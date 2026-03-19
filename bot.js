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
const SERVER_VERSION  = process.env.SERVER_VERSION  || '1.20.1';
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
function loadOrCreatePassword() {
    if (fs.existsSync(PASSWORD_FILE)) {
        try {
            const pw = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
            if (pw) { console.log('[Auth] Loaded saved password.'); return pw; }
        } catch (e) { console.error('[Auth] Could not read password file:', e.message); }
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let pw = '';
    for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
    try { fs.writeFileSync(PASSWORD_FILE, pw); console.log('[Auth] Generated and saved new password.'); }
    catch (e) { console.error('[Auth] Could not save password:', e.message); }
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
        bot.pathfinder.setMovements(new Movements(bot, mcData));

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

// ── Anti-AFK routines ─────────────────────────────────────────────
function startAntiAfk(bot) {
    console.log('[AntiAFK] All routines started.');

    setInterval(() => {
        if (!bot.entity) return;
        bot.look(
            bot.entity.yaw   + (Math.random() - 0.5) * 0.3,
            bot.entity.pitch + (Math.random() - 0.5) * 0.2,
            true
        );
    }, 3000);

    setInterval(() => {
        if (!bot.entity) return;
        bot.swingArm();
        console.log('[AntiAFK] Arm swing.');
    }, randMs(15000, 45000));

    setInterval(() => {
        if (!bot.entity) return;
        bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI, false);
        console.log('[AntiAFK] Head turn.');
    }, randMs(20000, 60000));

    setInterval(() => {
        if (!bot.entity) return;
        const dirs = ['forward', 'back', 'left', 'right'];
        const dir  = dirs[Math.floor(Math.random() * dirs.length)];
        bot.setControlState(dir, true);
        setTimeout(() => bot.setControlState(dir, false), 400 + Math.random() * 800);
        console.log(`[AntiAFK] Nudge ${dir}.`);
    }, randMs(30000, 90000));

    setInterval(() => {
        if (!bot.entity) return;
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 250);
        console.log('[AntiAFK] Jump.');
    }, randMs(60000, 180000));

    setInterval(() => {
        if (!bot.entity) return;
        bot.setControlState('sneak', true);
        setTimeout(() => bot.setControlState('sneak', false), 1000 + Math.random() * 1500);
        console.log('[AntiAFK] Crouch toggle.');
    }, randMs(90000, 210000));

    setInterval(() => {
        if (!bot.entity || !bot.pathfinder) return;
        const x = bot.entity.position.x + (Math.random() - 0.5) * 4;
        const z = bot.entity.position.z + (Math.random() - 0.5) * 4;
        bot.pathfinder.goto(new GoalNear(x, bot.entity.position.y, z, 1)).catch(() => {
            bot.setControlState('forward', true);
            setTimeout(() => bot.setControlState('forward', false), 800);
        });
        console.log('[AntiAFK] Walking to nearby position.');
    }, 62000);
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
