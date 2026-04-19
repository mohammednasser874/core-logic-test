const mineflayer  = require('mineflayer');
const pathfinder  = require('mineflayer-pathfinder').pathfinder;
const Movements   = require('mineflayer-pathfinder').Movements;
const { GoalNear } = require('mineflayer-pathfinder').goals;
const fs   = require('fs');
const path = require('path');
const attachFollow = require('./follow');  // ← follow module

// ── Config ────────────────────────────────────────────────────────
const BOT_USERNAME    = process.env.BOT_USERNAME || 'COOLBOI';
const SERVER_HOST     = process.env.SERVER_HOST  || 'midnightsmp.axyron.cloud';  // ← updated
const SERVER_PORT     = parseInt(process.env.SERVER_PORT) || 25565;
const SERVER_VERSION  = process.env.SERVER_VERSION || '1.21.1';
const AUTH_TYPE       = process.env.AUTH_TYPE    || 'offline';
const MAX_RUNTIME_MIN = 340;
const PASSWORD_FILE   = path.join(__dirname, '.bot_password');
const OWNER_NAME      = 'Binwalk';  // ← YOUR NAME HERE (change if your IGN is different)

// ── Global state ──────────────────────────────────────────────────
const startTime       = Date.now();
let isShuttingDown    = false;
let isReconnecting    = false;
let reconnectAttempts = 0;
let reconnectTimeout  = null;
let falixTimerPending = false;
let botInstance       = null;

// ── Password ──────────────────────────────────────────────────────
function loadOrCreatePassword() {
    if (process.env.BOT_PASSWORD && process.env.BOT_PASSWORD.trim()) {
        const pw = process.env.BOT_PASSWORD.trim();
        try { fs.writeFileSync(PASSWORD_FILE, pw); } catch {}
        console.log('[Auth] Password loaded from BOT_PASSWORD env var.');
        return pw;
    }
    if (fs.existsSync(PASSWORD_FILE)) {
        try {
            const pw = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
            if (pw) { console.log('[Auth] Password loaded from cache file.'); return pw; }
        } catch (e) { console.error('[Auth] Could not read password file:', e.message); }
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let pw = '';
    for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    try { fs.writeFileSync(PASSWORD_FILE, pw); } catch (e) { console.error('[Auth] Could not save password:', e.message); }
    console.log('==========================================');
    console.log('NEW PASSWORD GENERATED — SAVE THIS:');
    console.log(`BOT_PASSWORD=${pw}`);
    console.log('==========================================');
    return pw;
}

const AUTHME_PASSWORD = loadOrCreatePassword();

// ── Reconnect ─────────────────────────────────────────────────────
function getReconnectDelay() {
    return Math.min(15000 * Math.pow(1.5, reconnectAttempts), 300000);
}

function scheduleReconnect(falixTriggered = false, overrideMs = null) {
    if (isShuttingDown) return;
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    if (isReconnecting) { console.log('[Reconnect] Already scheduled.'); return; }

    isReconnecting    = true;
    reconnectAttempts++;

    const delay = overrideMs !== null ? overrideMs
                : falixTriggered      ? 8000
                :                       getReconnectDelay();

    const label = falixTriggered ? ' (FalixNodes timer reset)'
                : overrideMs     ? ' (server stopped)'
                :                  '';
    console.log(`[Reconnect] Attempt #${reconnectAttempts} in ${Math.round(delay/1000)}s${label}`);

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
    let roamActive      = false;
    let roamTimers      = [];
    const MAX_AUTH      = 3;

    let sessionId = 0;

    function stopAllTasks() {
        sessionId++;
        roamActive = false;
        roamTimers.forEach(t => { try { clearTimeout(t); clearInterval(t); } catch {} });
        roamTimers = [];
        try { bot.pathfinder.stop(); } catch {}
        try {
            ['forward','back','left','right','jump','sneak','sprint']
                .forEach(k => bot.setControlState(k, false));
        } catch {}
        console.log('[Tasks] All tasks stopped.');
    }

    console.log(`[Bot] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${BOT_USERNAME}...`);

    const bot = mineflayer.createBot({
        host:     SERVER_HOST,
        port:     SERVER_PORT,
        username: BOT_USERNAME,
        version:  SERVER_VERSION,
        auth:     AUTH_TYPE,
        checkTimeoutInterval: 60000,
        hideErrors: false,
    });

    botInstance = bot;
    bot.loadPlugin(pathfinder);

    // ── Wire follow module ─────────────────────────────────────────
    const followControls = attachFollow(bot, {
        ownerName:   OWNER_NAME,
        stopAllTasks,
        startAntiAfk,
        roamTimers,
        sleep,
        randMs,
    });

    // ── Spawn ──────────────────────────────────────────────────────
    bot.on('spawn', () => {
        console.log(`[Bot] Spawned at ${fmtPos(bot.entity.position)}`);
        reconnectAttempts = 0;

        const mcData    = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig          = false;
        movements.canPlace        = false;
        movements.allow1by1towers = false;
        movements.maxDropDown     = 2;
        bot.pathfinder.setMovements(movements);

        const authTimeout = setTimeout(() => {
            if (!antiAfkStarted) {
                console.log('[Auth] No AuthMe prompt — starting anti-AFK directly.');
                isAuthenticated = true;
                startAntiAfk();
                antiAfkStarted  = true;
            }
        }, 10000);
        roamTimers.push(authTimeout);
    });

    bot.on('login', () => console.log('[Bot] Login OK.'));

    bot.on('forcedMove', () => {
        console.log('[GrimAC] Setback detected — letting pathfinder recover.');
    });

    // ── Chat ───────────────────────────────────────────────────────
    bot.on('message', (jsonMsg) => {
        const msg = jsonMsg.toString();
        console.log(`[Chat] ${msg}`);
        if (handleFalix(msg)) return;
        if (!isAuthenticated) handleAuthMe(msg);
        handleCommand(msg);
    });

    bot.on('error', (err) => console.error(`[Error] ${err.message}`));

    bot.on('kicked', (reason) => {
        const r = String(reason);
        console.warn(`[Kicked] ${r}`);
        stopAllTasks();
        if (/throttle|wait|rate.?limit/i.test(r)) reconnectAttempts += 2;
    });

    bot.on('end', (reason) => {
        console.log(`[Disconnect] ${reason || 'unknown'}`);
        stopAllTasks();
        antiAfkStarted  = false;
        isAuthenticated = false;
        const wasFalix  = falixTimerPending;
        falixTimerPending = false;
        scheduleReconnect(wasFalix);
    });

    bot.on('death', () => {
        console.log('[Bot] Died — respawning...');
        followControls.stopFollow(false);  // ← stop follow on death
        try { bot.pathfinder.stop(); } catch {}
    });

    // ── AuthMe ─────────────────────────────────────────────────────
    function handleAuthMe(msg) {
        const OK_RE  = /successfully (logged.?in|registered)|login successful|welcome back|authenticated/i;
        const REG_RE = /please register|\/(register)|type.*\/register|you need to register/i;
        const LOG_RE = /please login|\/(login)|type.*\/login|you need to login|password.*login/i;
        const ERR_RE = /wrong password|incorrect password|login failed|registration failed/i;

        if (OK_RE.test(msg)) {
            console.log('[Auth] Authenticated!');
            isAuthenticated = true;
            authAttempts    = 0;
            const t = setTimeout(() => {
                if (!antiAfkStarted) { startAntiAfk(); antiAfkStarted = true; }
            }, 2000);
            roamTimers.push(t);
            return;
        }
        if (ERR_RE.test(msg)) {
            console.warn(`[Auth] Error: ${msg}`);
            if (++authAttempts >= MAX_AUTH) { console.log('[Auth] Too many failures — reconnecting.'); bot.quit(); }
            return;
        }
        if (REG_RE.test(msg) && authAttempts < MAX_AUTH) {
            const t = setTimeout(() => {
                if (!isAuthenticated) {
                    bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`);
                    console.log('[Auth] Sent /register');
                    authAttempts++;
                }
            }, 2000 + Math.random() * 2000);
            roamTimers.push(t);
            return;
        }
        if (LOG_RE.test(msg) && authAttempts < MAX_AUTH) {
            const t = setTimeout(() => {
                if (!isAuthenticated) {
                    bot.chat(`/login ${AUTHME_PASSWORD}`);
                    console.log('[Auth] Sent /login');
                    authAttempts++;
                }
            }, 2000 + Math.random() * 2000);
            roamTimers.push(t);
        }
    }

    // ── FalixNodes ─────────────────────────────────────────────────
    const FALIX_AFK = [
        /are you here/i,
        /are you still there/i,
        /afk.?check/i,
        /confirm you are here/i,
        /still (here|active|playing)/i,
        /type.*to (confirm|stay)/i,
        /respond.*or.*kick/i,
        /you.*there\?/i,
    ];
    const FALIX_TIMER = [
        /server will stop in/i,
        /server stopping in/i,
        /shutting down in/i,
        /stop.*timer/i,
        /auto.?stop/i,
        /will.*stop.*\d+\s*(second|minute)/i,
        /stopping.*\d+\s*(second|minute)/i,
    ];
    const FALIX_NOW = [
        /server is stopping/i,
        /shutting down now/i,
        /server closed/i,
        /server.*stopped/i,
    ];

    function handleFalix(msg) {
        if (FALIX_AFK.some(p => p.test(msg))) {
            const replies = [
                'yes', 'yeah', 'here', 'present', 'yep',
                'yes im here', 'not afk', 'im here', 'yep still here',
            ];
            const t = setTimeout(() => {
                try { bot.chat(replies[Math.floor(Math.random() * replies.length)]); } catch {}
                console.log('[FalixNodes] Responded to AFK check.');
            }, 1000 + Math.random() * 2000);
            roamTimers.push(t);
            return true;
        }
        if (FALIX_TIMER.some(p => p.test(msg))) {
            if (falixTimerPending) return true;
            console.log('[FalixNodes] Stop-timer — disconnecting to reset...');
            falixTimerPending = true;
            stopAllTasks();
            const t = setTimeout(() => {
                try { bot.quit('FalixNodes timer reset'); } catch {}
            }, 500);
            roamTimers.push(t);
            return true;
        }
        if (FALIX_NOW.some(p => p.test(msg))) {
            console.log('[FalixNodes] Server stopping — waiting 45s...');
            stopAllTasks();
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
            try { bot.chat(`Up ${mins}m | HP:${Math.round(bot.health ?? 0)} | Auth:${isAuthenticated}`); } catch {}
        } else if (lower.includes('stop') || lower.includes('shutdown')) {
            try { bot.chat('Shutting down...'); } catch {}
            gracefulShutdown();
        }
    }

    // ── Anti-AFK / Roam ───────────────────────────────────────────
    function startAntiAfk() {
        if (roamActive) return;
        roamActive = true;
        console.log('[AntiAFK] Starting.');

        const swingInt = setInterval(() => {
            if (!bot.entity || !roamActive) return;
            bot.swingArm();
        }, randMs(15000, 40000));
        roamTimers.push(swingInt);

        const crouchInt = setInterval(() => {
            if (!bot.entity || !roamActive) return;
            bot.setControlState('sneak', true);
            const t = setTimeout(() => {
                try { bot.setControlState('sneak', false); } catch {}
            }, 800 + Math.random() * 1000);
            roamTimers.push(t);
        }, randMs(90000, 180000));
        roamTimers.push(crouchInt);

        const spawnX = bot.entity.position.x;
        const spawnZ = bot.entity.position.z;
        console.log(`[Roam] Spawn center: ${Math.floor(spawnX)}, ${Math.floor(spawnZ)}`);

        let failStreak = 0;

        function pickGoal() {
            const angle = Math.random() * Math.PI * 2;
            const dist  = 1.5 + Math.random() * 4.5;
            const tx    = spawnX + Math.cos(angle) * dist;
            const tz    = spawnZ + Math.sin(angle) * dist;
            return new GoalNear(tx, bot.entity.position.y, tz, 1);
        }

        async function roamStep() {
            const mySession = sessionId;

            if (!bot.entity || !roamActive) return;

            const goal = pickGoal();
            console.log(`[Roam] Walking to ${Math.floor(goal.x)}, ${Math.floor(goal.z)}`);

            try {
                await bot.pathfinder.goto(goal);
                if (sessionId !== mySession || !roamActive) return;
                console.log('[Roam] Reached.');
                failStreak = 0;
            } catch (e) {
                if (sessionId !== mySession || !roamActive) return;
                const reason = e.message || String(e);

                if (/path was stopped/i.test(reason)) {
                    console.log('[Roam] Path interrupted by setback — retrying.');
                    const t = setTimeout(roamStep, 500);
                    roamTimers.push(t);
                    return;
                }

                failStreak++;
                console.log(`[Roam] Failed (${reason}) streak:${failStreak}`);
                try { bot.pathfinder.stop(); } catch {}

                if (failStreak >= 4 && bot.entity && roamActive) {
                    console.log('[Roam] Nudging to unstick.');
                    const dirs = ['forward', 'back', 'left', 'right'];
                    const dir  = dirs[Math.floor(Math.random() * dirs.length)];
                    try { bot.setControlState(dir, true); } catch {}
                    await sleep(600);
                    if (sessionId !== mySession || !roamActive) return;
                    try { bot.setControlState(dir, false); } catch {}
                    failStreak = 0;
                }
            }

            if (sessionId !== mySession || !roamActive) return;

            const t = setTimeout(roamStep, randMs(2000, 6000));
            roamTimers.push(t);
        }

        const startT = setTimeout(roamStep, 2000);
        roamTimers.push(startT);
    }
}

// ── Runtime monitor ───────────────────────────────────────────────
setInterval(() => {
    const mins = Math.floor((Date.now() - startTime) / 60000);
    if (mins >= MAX_RUNTIME_MIN) {
        console.log(`[Runtime] ${MAX_RUNTIME_MIN}m limit — shutting down.`);
        gracefulShutdown();
    } else if (mins > 0 && mins % 10 === 0) {
        console.log(`[Runtime] ${mins}/${MAX_RUNTIME_MIN} min elapsed.`);
    }
}, 60000);

// ── Graceful shutdown ─────────────────────────────────────────────
function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[Bot] Graceful shutdown.');
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    try { botInstance?.quit('Graceful shutdown'); } catch {}
    setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT',             gracefulShutdown);
process.on('SIGTERM',            gracefulShutdown);
process.on('uncaughtException',  (e) => console.error('[Uncaught]',  e.message));
process.on('unhandledRejection', (r) => console.error('[Rejection]', r));

// ── Helpers ───────────────────────────────────────────────────────
function randMs(min, max) { return Math.floor(Math.random() * (max - min)) + min; }
function fmtPos(p)        { return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown'; }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }

// ── Start ─────────────────────────────────────────────────────────
console.log('==========================================');
console.log('      COOLBOI AFK Bot Starting           ');
console.log(`  Server : ${SERVER_HOST}:${SERVER_PORT} `);
console.log(`  Version: ${SERVER_VERSION}             `);
console.log(`  Runtime: max ${MAX_RUNTIME_MIN} min    `);
console.log('==========================================');
createBot();
