const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear } = require('mineflayer-pathfinder').goals;
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────
const BOT_USERNAME    = process.env.BOT_USERNAME    || 'COOLBOI';
const SERVER_HOST     = process.env.SERVER_HOST     || 'pathborn.falix.me';
const SERVER_PORT     = parseInt(process.env.SERVER_PORT) || 24233;
const SERVER_VERSION  = process.env.SERVER_VERSION  || '1.21.1';
const AUTH_TYPE       = process.env.AUTH_TYPE       || 'offline';
const MAX_RUNTIME_MIN = 340;
const PASSWORD_FILE   = path.join(__dirname, '.bot_password');

// ── Global state (persists across every reconnect) ────────────────
const startTime       = Date.now();
let isShuttingDown    = false;
let isReconnecting    = false;
let reconnectAttempts = 0;
let reconnectTimeout  = null;
let falixTimerPending = false;
let botInstance       = null;

// ── Password ──────────────────────────────────────────────────────
// Password is loaded from:
//   1. BOT_PASSWORD env var (set as GitHub Actions secret — most reliable)
//   2. .bot_password file (GitHub Actions cache fallback)
//   3. Generate a new one and save both to file and log it loudly
function loadOrCreatePassword() {
    // 1. Env var set by workflow from the saved secret
    if (process.env.BOT_PASSWORD && process.env.BOT_PASSWORD.trim()) {
        const pw = process.env.BOT_PASSWORD.trim();
        // Always keep the file in sync so cache also has it
        try { fs.writeFileSync(PASSWORD_FILE, pw); } catch {}
        console.log('[Auth] Password loaded from BOT_PASSWORD env var.');
        return pw;
    }

    // 2. Cache file from previous run
    if (fs.existsSync(PASSWORD_FILE)) {
        try {
            const pw = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
            if (pw) {
                console.log('[Auth] Password loaded from cache file.');
                return pw;
            }
        } catch (e) { console.error('[Auth] Could not read password file:', e.message); }
    }

    // 3. Generate brand new password
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let pw = '';
    for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    try { fs.writeFileSync(PASSWORD_FILE, pw); } catch (e) { console.error('[Auth] Could not save password file:', e.message); }

    // Print clearly to logs so you can copy it into the GitHub secret
    console.log('==========================================');
    console.log('NEW PASSWORD GENERATED — SAVE THIS:');
    console.log(`BOT_PASSWORD=${pw}`);
    console.log('==========================================');
    return pw;
}

const AUTHME_PASSWORD = loadOrCreatePassword();

// ── Reconnect helpers ─────────────────────────────────────────────
function getReconnectDelay() {
    return Math.min(15000 * Math.pow(1.5, reconnectAttempts), 300000);
}

function scheduleReconnect(falixTriggered = false, overrideDelayMs = null) {
    if (isShuttingDown) return;
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }

    if (isReconnecting) {
        console.log('[Reconnect] Already scheduled — skipping duplicate.');
        return;
    }

    isReconnecting = true;
    reconnectAttempts++;

    const delay = overrideDelayMs !== null ? overrideDelayMs
                : falixTriggered           ? 8000
                :                            getReconnectDelay();

    const label = falixTriggered  ? ' (FalixNodes timer reset)'
                : overrideDelayMs ? ' (server fully stopped)'
                :                   '';
    console.log(`[Reconnect] Attempt #${reconnectAttempts} in ${Math.round(delay / 1000)}s${label}`);

    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        isReconnecting   = false;
        if (!isShuttingDown) createBot();
    }, delay);
}

// ── Bot factory ───────────────────────────────────────────────────
function createBot() {
    let isAuthenticated = false;
    let authAttempts    = 0;
    let antiAfkStarted  = false;
    const MAX_AUTH      = 3;

    console.log(`[Bot] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${BOT_USERNAME}...`);

    const bot = mineflayer.createBot({
        host:    SERVER_HOST,
        port:    SERVER_PORT,
        username: BOT_USERNAME,
        version: SERVER_VERSION,
        auth:    AUTH_TYPE,
        checkTimeoutInterval: 60000,
        hideErrors: false,
    });

    botInstance = bot;
    bot.loadPlugin(pathfinder);

    // ── Spawn ──────────────────────────────────────────────────────
    bot.on('spawn', () => {
        console.log(`[Bot] Spawned! Pos: ${fmtPos(bot.entity.position)}`);
        reconnectAttempts = 0;

        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig          = false; // never break blocks
        movements.canPlace        = false; // never place blocks
        movements.allow1by1towers = false; // never pillar up
        bot.pathfinder.setMovements(movements);

        setTimeout(() => {
            if (!antiAfkStarted) {
                console.log('[Auth] No AuthMe prompt detected — starting anti-AFK directly.');
                isAuthenticated = true;
                startAntiAfk(bot);
                antiAfkStarted = true;
            }
        }, 8000);
    });

    bot.on('login', () => console.log('[Bot] Login acknowledged.'));

    // ── Chat ───────────────────────────────────────────────────────
    bot.on('message', (jsonMsg) => {
        const msg = jsonMsg.toString();
        console.log(`[Chat] ${msg}`);
        if (handleFalix(msg)) return;
        if (!isAuthenticated) handleAuthMe(msg);
        handleCommand(msg);
    });

    bot.on('error',  (err)    => console.error(`[Error] ${err.message}`));
    bot.on('kicked', (reason) => {
        const r = String(reason);
        console.warn(`[Kicked] ${r}`);
        if (/throttle|wait|rate.?limit/i.test(r)) reconnectAttempts += 2;
    });

    // ── End — single reconnect entry point ────────────────────────
    bot.on('end', (reason) => {
        console.log(`[Disconnect] ${reason || 'unknown'}`);
        antiAfkStarted  = false;
        isAuthenticated = false;
        const wasFalix  = falixTimerPending;
        falixTimerPending = false;
        scheduleReconnect(wasFalix);
    });

    bot.on('death', () => console.log('[Bot] Died — auto-respawning...'));

    // ── AuthMe ─────────────────────────────────────────────────────
    function handleAuthMe(msg) {
        const OK_RE  = /successfully (logged.?in|registered)|login successful|welcome back|authenticated/i;
        const REG_RE = /please register|\/(register)|type.*\/register|you need to register/i;
        const LOG_RE = /please login|\/(login)|type.*\/login|you need to login|password.*login/i;
        const ERR_RE = /wrong password|incorrect password|login failed|registration failed/i;

        if (OK_RE.test(msg)) {
            console.log('[Auth] Authenticated successfully!');
            isAuthenticated = true;
            authAttempts    = 0;
            setTimeout(() => { if (!antiAfkStarted) { startAntiAfk(bot); antiAfkStarted = true; } }, 2000);
            return;
        }
        if (ERR_RE.test(msg)) {
            console.warn(`[Auth] Auth error: ${msg}`);
            if (++authAttempts >= MAX_AUTH) { console.log('[Auth] Too many failures — reconnecting.'); bot.quit(); }
            return;
        }
        if (REG_RE.test(msg) && authAttempts < MAX_AUTH) {
            setTimeout(() => {
                if (!isAuthenticated) {
                    bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`);
                    console.log('[Auth] Sent /register');
                    authAttempts++;
                }
            }, 2000 + Math.random() * 2000);
            return;
        }
        if (LOG_RE.test(msg) && authAttempts < MAX_AUTH) {
            setTimeout(() => {
                if (!isAuthenticated) {
                    bot.chat(`/login ${AUTHME_PASSWORD}`);
                    console.log('[Auth] Sent /login');
                    authAttempts++;
                }
            }, 2000 + Math.random() * 2000);
        }
    }

    // ── FalixNodes ─────────────────────────────────────────────────
    const FALIX_AFK = [
        /are you here\??/i, /are you still there\??/i, /afk.?check/i,
        /confirm you are here/i, /type.*to confirm/i,
    ];
    const FALIX_TIMER = [
        /server will stop in/i, /server stopping in/i, /shutting down in/i,
        /stop.*timer/i, /auto.?stop/i, /will.*stop.*\d+\s*(second|minute)/i,
    ];
    const FALIX_NOW = [
        /server is stopping/i, /shutting down now/i, /server closed/i,
    ];

    function handleFalix(msg) {
        if (FALIX_AFK.some(p => p.test(msg))) {
            const replies = ['yes', 'yeah', 'here', 'present', 'yep', 'yes im here', 'not afk'];
            setTimeout(() => {
                try { bot.chat(replies[Math.floor(Math.random() * replies.length)]); } catch {}
                console.log('[FalixNodes] Responded to AFK check.');
            }, 1000 + Math.random() * 2000);
            return true;
        }
        if (FALIX_TIMER.some(p => p.test(msg))) {
            if (falixTimerPending) return true;
            console.log('[FalixNodes] Stop-timer detected — disconnecting to reset it...');
            falixTimerPending = true;
            setTimeout(() => {
                try { bot.quit('FalixNodes timer reset'); } catch {}
            }, 500);
            return true;
        }
        if (FALIX_NOW.some(p => p.test(msg))) {
            console.log('[FalixNodes] Server shutting down — waiting 45s before rejoining...');
            if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
            isReconnecting = true;
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                isReconnecting   = false;
                if (!isShuttingDown) createBot();
            }, 45000);
            return true;
        }
        return false;
    }

    // ── Commands ───────────────────────────────────────────────────
    function handleCommand(msg) {
        if (!msg.includes(bot.username) || msg.includes(bot.username + '>')) return;
        const lower = msg.toLowerCase();
        if (lower.includes('status')) {
            const mins = Math.floor((Date.now() - startTime) / 60000);
            try { bot.chat(`Up ${mins}m | HP:${Math.round(bot.health ?? 0)} | Auth:${isAuthenticated} | Reconnects:${reconnectAttempts}`); } catch {}
        } else if (lower.includes('stop') || lower.includes('shutdown')) {
            try { bot.chat('Shutting down...'); } catch {}
            gracefulShutdown();
        }
    }
}

// ── Pathfinder roam — picks random points near spawn and walks to them ──
function startAntiAfk(bot) {
    console.log('[AntiAFK] Pathfinder roam started.');

    const { GoalNear } = require('mineflayer-pathfinder').goals;

    // ── Non-movement routines ─────────────────────────────────────
    setInterval(() => { if (bot.entity) bot.swingArm(); }, randMs(12000, 35000));

    setInterval(() => {
        if (!bot.entity) return;
        bot.setControlState('sneak', true);
        setTimeout(() => bot.setControlState('sneak', false), 800 + Math.random() * 1200);
    }, randMs(60000, 150000));

    // ── Roam loop ─────────────────────────────────────────────────
    let spawnX  = null;
    let spawnZ  = null;
    let roaming = false;
    let failStreak = 0; // how many goals in a row failed

    function pickGoal() {
        // Tight radius — spawn is a small skyblock island with void edges
        // Never go more than 6 blocks from spawn center to stay safe
        const radius = 6;
        const angle  = Math.random() * Math.PI * 2;
        const dist   = 1 + Math.random() * radius;
        const tx = spawnX + Math.cos(angle) * dist;
        const tz = spawnZ + Math.sin(angle) * dist;
        const ty = bot.entity.position.y;
        return new GoalNear(tx, ty, tz, 1);
    }

    async function roamStep() {
        if (!bot.entity || roaming) return;
        roaming = true;

        const goal = pickGoal();
        console.log(`[Roam] Walking to ~${Math.floor(goal.x)}, ${Math.floor(goal.z)}`);

        try {
            await bot.pathfinder.goto(goal);
            console.log('[Roam] Reached goal.');
            failStreak = 0;
        } catch (e) {
            failStreak++;
            const reason = e.message || String(e);

            // Pathfinder throws when it needs to dig but can't — treat as blocked
            if (/dig|break|block|no path/i.test(reason)) {
                console.log(`[Roam] Path blocked (${reason}) — picking new direction.`);
            } else {
                console.log(`[Roam] Could not reach goal (${reason}) — trying another.`);
            }

            bot.pathfinder.stop();

            // After 4 fails nudge manually to get unstuck
            if (failStreak >= 4) {
                console.log('[Roam] Nudging to get unstuck.');
                const dirs = ['forward', 'back', 'left', 'right'];
                const dir  = dirs[Math.floor(Math.random() * dirs.length)];
                bot.setControlState(dir, true);
                await new Promise(r => setTimeout(r, 700));
                bot.setControlState(dir, false);
                failStreak = 0;
            }
        }

        roaming = false;
        // Pause 1–3s between walks
        setTimeout(roamStep, randMs(1000, 3000));
    }

    // Start after spawn settles
    setTimeout(() => {
        if (!bot.entity) return;
        spawnX = bot.entity.position.x;
        spawnZ = bot.entity.position.z;
        console.log(`[Roam] Spawn at ${Math.floor(spawnX)}, ${Math.floor(spawnZ)} — starting roam.`);
        roamStep();
    }, 3000);
}
// ── Runtime monitor ───────────────────────────────────────────────
setInterval(() => {
    const mins = Math.floor((Date.now() - startTime) / 60000);
    if (mins >= MAX_RUNTIME_MIN) {
        console.log(`[Runtime] ${MAX_RUNTIME_MIN}m limit reached — shutting down for workflow restart.`);
        gracefulShutdown();
    } else if (mins > 0 && mins % 10 === 0) {
        console.log(`[Runtime] ${mins}/${MAX_RUNTIME_MIN} min elapsed.`);
    }
}, 60000);

// ── Graceful shutdown ─────────────────────────────────────────────
function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[Bot] Graceful shutdown initiated.');
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    try { botInstance?.quit('Graceful shutdown'); } catch {}
    setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT',  gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException',  (e) => console.error('[Uncaught]',  e.message));
process.on('unhandledRejection', (r) => console.error('[Rejection]', r));

// ── Helpers ───────────────────────────────────────────────────────
function randMs(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
function fmtPos(p) { return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown'; }

// ── Start ─────────────────────────────────────────────────────────
console.log('==========================================');
console.log('      COOLBOI AFK Bot Starting           ');
console.log(`  Server : ${SERVER_HOST}:${SERVER_PORT} `);
console.log(`  Version: ${SERVER_VERSION}             `);
console.log(`  Runtime: max ${MAX_RUNTIME_MIN} min    `);
console.log('==========================================');
createBot();
