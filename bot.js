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

// ── Meteor-style continuous roam movement ─────────────────────────
//
//  Runs every 100ms (like a game tick) and checks 3 things ahead:
//    HOLE  — ground block ahead is non-solid → turn to new direction
//    WALL  — body-level block ahead is solid  → try jump, else turn
//    STUCK — position hasn't changed in 2s    → force new direction
//
//  The bot roams continuously, only pausing briefly after a direction
//  change. This mimics Meteor client's "roam" anti-AFK behaviour.
//
function startAntiAfk(bot) {
    console.log('[AntiAFK] Meteor-style roam started.');

    // ── Non-movement routines ─────────────────────────────────────
    // Subtle head drift
    setInterval(() => {
        if (!bot.entity) return;
        bot.look(
            bot.entity.yaw   + (Math.random() - 0.5) * 0.25,
            bot.entity.pitch + (Math.random() - 0.5) * 0.15,
            true
        );
    }, 3000);

    // Arm swing
    setInterval(() => {
        if (!bot.entity) return;
        bot.swingArm();
    }, randMs(12000, 35000));

    // Crouch toggle
    setInterval(() => {
        if (!bot.entity) return;
        bot.setControlState('sneak', true);
        setTimeout(() => bot.setControlState('sneak', false), 800 + Math.random() * 1200);
    }, randMs(60000, 150000));

    // ── Block helpers ─────────────────────────────────────────────
    const NON_SOLID = new Set([
        'air','cave_air','void_air','water','lava','seagrass','tall_seagrass',
        'grass','tall_grass','fern','large_fern','dead_bush','snow',
        'poppy','dandelion','cornflower','oxeye_daisy','azure_bluet',
        'rose_bush','peony','sunflower','lilac','vine','kelp','kelp_plant',
        'bubble_column','torch','wall_torch','lantern','chain',
        'tripwire','string','cobweb','sugar_cane','bamboo',
        'wheat','carrots','potatoes','beetroots',
    ]);

    function solid(block) {
        return block && !NON_SOLID.has(block.name);
    }

    function getBlock(x, y, z) {
        try { return bot.blockAt({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }); }
        catch { return null; }
    }

    // ── Roam state ────────────────────────────────────────────────
    let roamYaw        = Math.random() * Math.PI * 2;
    let lastPos        = null;
    let lastMoveTime   = Date.now();
    let turning        = false;   // cooldown flag while changing direction
    let jumpCooldown   = false;

    function setYaw(yaw) {
        roamYaw = yaw;
        try { bot.look(yaw, 0, false); } catch {}
    }

    function turnRandom(bias = 0) {
        // bias: 0 = fully random, positive = prefer right, negative = prefer left
        const angle = (Math.PI * 0.5) + Math.random() * (Math.PI * 0.6);
        const dir   = bias !== 0 ? Math.sign(bias) : (Math.random() < 0.5 ? 1 : -1);
        setYaw(roamYaw + angle * dir);
    }

    function doJump() {
        if (jumpCooldown) return;
        jumpCooldown = true;
        bot.setControlState('jump', true);
        setTimeout(() => {
            bot.setControlState('jump', false);
            setTimeout(() => { jumpCooldown = false; }, 600);
        }, 250);
    }

    // ── Main tick (100ms) ─────────────────────────────────────────
    setInterval(() => {
        if (!bot.entity || turning) return;

        const pos = bot.entity.position;
        const dx  = -Math.sin(roamYaw);
        const dz  =  Math.cos(roamYaw);

        // Look-ahead distances
        const near = 0.85;   // immediate next step
        const far  = 1.4;    // one full block ahead

        // -- HOLE CHECK --
        // Block below foot level at near and far ahead
        const groundNear = getBlock(pos.x + dx * near, pos.y - 0.1, pos.z + dz * near);
        const groundFar  = getBlock(pos.x + dx * far,  pos.y - 0.1, pos.z + dz * far);

        if (!solid(groundNear) || !solid(groundFar)) {
            console.log('[Roam] Hole detected — changing direction.');
            bot.setControlState('forward', false);
            turning = true;
            turnRandom();
            setTimeout(() => {
                turning = false;
                bot.setControlState('forward', true);
            }, 400);
            return;
        }

        // -- WALL / OBSTACLE CHECK --
        // Block at foot level (step up check) and body level ahead
        const stepBlock  = getBlock(pos.x + dx * near, pos.y + 0.1,  pos.z + dz * near); // 1 block up
        const bodyBlock  = getBlock(pos.x + dx * near, pos.y + 0.6,  pos.z + dz * near); // mid body
        const headBlock  = getBlock(pos.x + dx * near, pos.y + 1.55, pos.z + dz * near); // head

        if (solid(stepBlock)) {
            // There's a block at foot level — check if it's only 1 high (jumpable)
            if (!solid(bodyBlock) && !solid(headBlock)) {
                // 1-block step up → jump over it like Meteor does
                doJump();
                console.log('[Roam] 1-block step — jumping.');
            } else {
                // 2+ blocks tall — turn away
                console.log('[Roam] Wall/build detected — changing direction.');
                bot.setControlState('forward', false);
                turning = true;
                turnRandom();
                setTimeout(() => {
                    turning = false;
                    bot.setControlState('forward', true);
                }, 400);
            }
            return;
        }

        // Also catch wide walls at body/head level even with clear feet
        if (solid(bodyBlock) || solid(headBlock)) {
            console.log('[Roam] Upper obstacle detected — changing direction.');
            bot.setControlState('forward', false);
            turning = true;
            turnRandom();
            setTimeout(() => {
                turning = false;
                bot.setControlState('forward', true);
            }, 400);
            return;
        }

        // -- STUCK CHECK --
        // If the bot hasn't moved more than 0.05 blocks in 2 seconds it's stuck
        if (lastPos) {
            const moved = Math.abs(pos.x - lastPos.x) + Math.abs(pos.z - lastPos.z);
            if (moved < 0.05 && Date.now() - lastMoveTime > 2000) {
                console.log('[Roam] Stuck — forcing new direction.');
                bot.setControlState('forward', false);
                turning = true;
                turnRandom();
                // Try a jump too in case we're wedged
                doJump();
                lastMoveTime = Date.now();
                setTimeout(() => {
                    turning = false;
                    bot.setControlState('forward', true);
                }, 500);
                lastPos = pos.clone();
                return;
            }
        }

        // Update last position every 2s
        if (!lastPos || Date.now() - lastMoveTime > 2000) {
            lastPos      = pos.clone();
            lastMoveTime = Date.now();
        }

        // All clear — keep walking forward
        bot.setControlState('forward', true);

    }, 100);

    // Occasionally pick a fresh random direction even with no obstacle
    // so the bot doesn't just pace back and forth on the same line
    setInterval(() => {
        if (!bot.entity || turning) return;
        console.log('[Roam] Random direction change.');
        bot.setControlState('forward', false);
        turning = true;
        setYaw(Math.random() * Math.PI * 2);
        setTimeout(() => {
            turning = false;
            bot.setControlState('forward', true);
        }, 300);
    }, randMs(15000, 35000));

    // Start moving after a short delay
    setTimeout(() => {
        if (!bot.entity) return;
        setYaw(Math.random() * Math.PI * 2);
        bot.setControlState('forward', true);
        console.log('[Roam] Initial walk started.');
    }, 2000);
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
