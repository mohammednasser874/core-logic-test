const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear, GoalBlock } = require('mineflayer-pathfinder').goals;
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const BOT_USERNAME = process.env.BOT_USERNAME || 'COOLBOI';
const SERVER_HOST = process.env.SERVER_HOST || 'ahsmpw.falixsrv.me';
const SERVER_PORT = parseInt(process.env.SERVER_PORT) || 29724;
const SERVER_VERSION = process.env.SERVER_VERSION || '1.20.1';
const AUTH_TYPE = process.env.AUTH_TYPE || 'offline';
const MAX_RUNTIME_MINUTES = 340; // 5 hours 40 minutes (340 minutes)

// Password file path for persistence
const PASSWORD_FILE = path.join(__dirname, '.bot_password');

// AuthMe configuration - Generate or load persistent password
function getAuthMePassword() {
    // Check if password file exists
    if (fs.existsSync(PASSWORD_FILE)) {
        try {
            const savedPassword = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
            if (savedPassword) {
                console.log(`[${getTimestamp()}] Loaded saved password from file`);
                return savedPassword;
            }
        } catch (e) {
            console.error(`[${getTimestamp()}] Error reading password file:`, e.message);
        }
    }

    // Generate new random password
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < 16; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Save password to file for persistence
    try {
        fs.writeFileSync(PASSWORD_FILE, password);
        console.log(`[${getTimestamp()}] Generated and saved new password`);
    } catch (e) {
        console.error(`[${getTimestamp()}] Error saving password file:`, e.message);
    }

    return password;
}

const AUTHME_PASSWORD = getAuthMePassword();
let isAuthMeAuthenticated = false;
let authAttempts = 0;
const MAX_AUTH_ATTEMPTS = 3;

// Track runtime
const startTime = Date.now();
let lastActivityTime = Date.now();
let isShuttingDown = false;
let botInstance = null;

// Create bot instance
function createBot() {
    const options = {
        host: SERVER_HOST,
        port: SERVER_PORT,
        username: BOT_USERNAME,
        version: SERVER_VERSION,
        auth: AUTH_TYPE,
        checkTimeoutInterval: 60000, // Check connection every minute
    };

    // Add password for online mode if provided
    if (process.env.BOT_PASSWORD) {
        options.password = process.env.BOT_PASSWORD;
    }

    const bot = mineflayer.createBot(options);
    botInstance = bot;

    // Load plugins
    bot.loadPlugin(pathfinder);

    // Store original position for reference
    let originalPosition = null;
    let mcData = null;
    let antiAfkStarted = false;

    // Bot spawn event
    bot.on('spawn', () => {
        console.log(`[${getTimestamp()}] Bot spawned successfully!`);
        console.log(`[${getTimestamp()}] Username: ${bot.username}`);
        console.log(`[${getTimestamp()}] Server: ${SERVER_HOST}:${SERVER_PORT}`);
        console.log(`[${getTimestamp()}] Position: ${formatPosition(bot.entity.position)}`);

        originalPosition = bot.entity.position.clone();

        // Load mcData after spawn
        mcData = require('minecraft-data')(bot.version);
        const defaultMove = new Movements(bot, mcData);
        bot.pathfinder.setMovements(defaultMove);

        // Wait for AuthMe messages before starting anti-AFK
        // AuthMe usually sends messages within first few seconds
        console.log(`[${getTimestamp()}] Waiting for AuthMe authentication...`);

        // Set a timeout - if no auth required, start anti-AFK after 8 seconds
        setTimeout(() => {
            if (!antiAfkStarted) {
                console.log(`[${getTimestamp()}] No AuthMe prompt detected, assuming no auth required`);
                isAuthMeAuthenticated = true;
                startAntiAfkRoutines(bot);
                antiAfkStarted = true;
            }
        }, 8000);
    });

    // Login event
    bot.on('login', () => {
        console.log(`[${getTimestamp()}] Bot logged in successfully`);
    });

    // Error handling
    bot.on('error', (err) => {
        console.error(`[${getTimestamp()}] Bot error:`, err.message);
    });

    // Kicked from server
    bot.on('kicked', (reason, loggedIn) => {
        console.log(`[${getTimestamp()}] Bot was kicked! Reason: ${reason}`);
        isAuthMeAuthenticated = false;
        authAttempts = 0;
        antiAfkStarted = false;
        if (!isShuttingDown) {
            console.log(`[${getTimestamp()}] Reconnecting in 10 seconds...`);
            setTimeout(createBot, 10000);
        }
    });

    // End/Disconnect event
    bot.on('end', () => {
        console.log(`[${getTimestamp()}] Bot disconnected`);
        isAuthMeAuthenticated = false;
        authAttempts = 0;
        antiAfkStarted = false;
        if (!isShuttingDown) {
            console.log(`[${getTimestamp()}] Reconnecting in 10 seconds...`);
            setTimeout(createBot, 10000);
        }
    });

    // Chat message handler - AuthMe detection and remote commands
    bot.on('message', (jsonMsg) => {
        const message = jsonMsg.toString();
        console.log(`[${getTimestamp()}] Chat: ${message}`);

        // FalixNodes specific messages (AFK check, stop timer)
        const handledByFalix = handleFalixMessages(bot, message);

        // AuthMe Detection and Auto-Response
        if (!isAuthMeAuthenticated && AUTHME_PASSWORD) {
            handleAuthMeMessages(bot, message);
        }

        // Simple command processing (if message contains bot username)
        if (message.includes(bot.username) && !message.includes(bot.username + '>')) {
            handleCommand(bot, message);
        }
    });

    // Handle death
    bot.on('death', () => {
        console.log(`[${getTimestamp()}] Bot died! Respawning...`);
        // Bot auto-respawns, but we log it
    });

    // Health monitoring
    bot.on('health', () => {
        if (bot.health < 10) {
            console.log(`[${getTimestamp()}] WARNING: Low health! ${bot.health}/20`);
        }
    });

    return bot;
}

// Handle AuthMe login/register messages
function handleAuthMeMessages(bot, message) {
    const lowerMsg = message.toLowerCase();

    // Common AuthMe register messages
    const registerPatterns = [
        /register/i,
        /\/(register|reg)/i,
        /register.*password/i,
        /please register/i,
        /authentication.*register/i,
        /you need to register/i,
        /\/register.*password/i,
        /type \/register/i,
        /usage: \/register/i
    ];

    // Common AuthMe login messages
    const loginPatterns = [
        /login/i,
        /\/(login|log)/i,
        /authenticate/i,
        /please login/i,
        /authentication.*login/i,
        /you need to login/i,
        /\/login.*password/i,
        /type \/login/i,
        /usage: \/login/i,
        /password.*login/i
    ];

    // Success patterns
    const successPatterns = [
        /successfully logged in/i,
        /login successful/i,
        /welcome back/i,
        /authenticated successfully/i,
        /successful authentication/i,
        /registered successfully/i,
        /registration successful/i
    ];

    // Error patterns (wrong password, etc)
    const errorPatterns = [
        /wrong password/i,
        /incorrect password/i,
        /password.*incorrect/i,
        /login failed/i,
        /registration failed/i,
        /already registered/i,
        /not registered/i
    ];

    // Check for success messages
    if (successPatterns.some(pattern => pattern.test(message))) {
        console.log(`[${getTimestamp()}] AuthMe: Successfully authenticated!`);
        isAuthMeAuthenticated = true;
        authAttempts = 0;

        // Start anti-AFK routines after successful auth
        setTimeout(() => {
            console.log(`[${getTimestamp()}] Starting anti-AFK routines...`);
            startAntiAfkRoutines(bot);
        }, 2000);
        return;
    }

    // Check for error messages
    if (errorPatterns.some(pattern => pattern.test(message))) {
        console.log(`[${getTimestamp()}] AuthMe: Authentication error - ${message}`);
        authAttempts++;

        if (authAttempts >= MAX_AUTH_ATTEMPTS) {
            console.log(`[${getTimestamp()}] AuthMe: Max auth attempts reached. Reconnecting...`);
            bot.quit();
            setTimeout(createBot, 10000);
        }
        return;
    }

    // Check if we need to register
    if (registerPatterns.some(pattern => pattern.test(message))) {
        if (authAttempts < MAX_AUTH_ATTEMPTS) {
            console.log(`[${getTimestamp()}] AuthMe: Register prompt detected`);

            // Wait a random time (2-4 seconds) before responding
            setTimeout(() => {
                if (!isAuthMeAuthenticated) {
                    // Try both common register formats
                    bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`);
                    console.log(`[${getTimestamp()}] AuthMe: Sent /register command`);
                    authAttempts++;
                }
            }, 2000 + Math.random() * 2000);
        }
        return;
    }

    // Check if we need to login
    if (loginPatterns.some(pattern => pattern.test(message))) {
        if (authAttempts < MAX_AUTH_ATTEMPTS) {
            console.log(`[${getTimestamp()}] AuthMe: Login prompt detected`);

            // Wait a random time (2-4 seconds) before responding
            setTimeout(() => {
                if (!isAuthMeAuthenticated) {
                    bot.chat(`/login ${AUTHME_PASSWORD}`);
                    console.log(`[${getTimestamp()}] AuthMe: Sent /login command`);
                    authAttempts++;
                }
            }, 2000 + Math.random() * 2000);
        }
        return;
    }
}

// Anti-AFK routines
function startAntiAfkRoutines(bot) {
    // Routine 1: Random arm swing every 15-45 seconds
    setInterval(() => {
        if (isShuttingDown || !isAuthMeAuthenticated) return;
        performRandomArmSwing(bot);
    }, getRandomInterval(15000, 45000));

    // Routine 2: Head rotation every 20-60 seconds
    setInterval(() => {
        if (isShuttingDown || !isAuthMeAuthenticated) return;
        performRandomHeadTurn(bot);
    }, getRandomInterval(20000, 60000));

    // Routine 3: Small movement every 30-90 seconds
    setInterval(() => {
        if (isShuttingDown || !isAuthMeAuthenticated) return;
        performRandomMovement(bot);
    }, getRandomInterval(30000, 90000));

    // Routine 4: Jump occasionally every 60-180 seconds
    setInterval(() => {
        if (isShuttingDown || !isAuthMeAuthenticated) return;
        performRandomJump(bot);
    }, getRandomInterval(60000, 180000));

    // Routine 5: Look around continuously (subtle)
    setInterval(() => {
        if (isShuttingDown || !isAuthMeAuthenticated) return;
        performSubtleLook(bot);
    }, 3000);

    // Main anti-AFK: Change position every minute
    setInterval(() => {
        if (isShuttingDown || !isAuthMeAuthenticated) return;
        performAntiAfkSequence(bot);
    }, 60000); // Every minute

    console.log(`[${getTimestamp()}] All anti-AFK routines started!`);
}

// Perform a sequence of anti-AFK actions
function performAntiAfkSequence(bot) {
    if (!bot.entity) return;

    const actions = [
        () => performRandomMovement(bot),
        () => performRandomArmSwing(bot),
        () => performRandomHeadTurn(bot),
        () => performRandomJump(bot),
        () => performCrouchToggle(bot),
    ];

    // Execute 2-3 random actions
    const numActions = Math.floor(Math.random() * 2) + 2;
    const shuffled = actions.sort(() => Math.random() - 0.5);

    console.log(`[${getTimestamp()}] Performing anti-AFK sequence (${numActions} actions)`);

    shuffled.slice(0, numActions).forEach((action, index) => {
        setTimeout(() => {
            if (!isShuttingDown && bot.entity && isAuthMeAuthenticated) {
                action();
            }
        }, index * 2000); // Stagger actions by 2 seconds
    });

    lastActivityTime = Date.now();
}

// Random arm swing (simulates clicking/using item)
function performRandomArmSwing(bot) {
    if (!bot.entity) return;

    const swingTypes = ['arm', 'off_hand', 'eat', 'drink'];
    const type = swingTypes[Math.floor(Math.random() * swingTypes.length)];

    switch(type) {
        case 'arm':
            bot.swingArm();
            break;
        case 'off_hand':
            bot.swingArm('off-hand');
            break;
        case 'eat':
            // Simulate eating if holding food
            bot.swingArm();
            break;
        case 'drink':
            // Simulate drinking
            bot.swingArm();
            break;
    }

    console.log(`[${getTimestamp()}] Anti-AFK: Arm swing (${type})`);
}

// Random head turning
function performRandomHeadTurn(bot) {
    if (!bot.entity) return;

    const yaw = Math.random() * Math.PI * 2; // 0 to 360 degrees
    const pitch = (Math.random() - 0.5) * Math.PI; // -90 to 90 degrees

    bot.look(yaw, pitch, false); // false = instant, true = smooth
    console.log(`[${getTimestamp()}] Anti-AFK: Head turn`);
}

// Subtle continuous looking (makes bot appear more natural)
function performSubtleLook(bot) {
    if (!bot.entity) return;

    const currentYaw = bot.entity.yaw;
    const currentPitch = bot.entity.pitch;

    // Small random adjustments
    const newYaw = currentYaw + (Math.random() - 0.5) * 0.3;
    const newPitch = currentPitch + (Math.random() - 0.5) * 0.2;

    bot.look(newYaw, newPitch, true); // true = smooth
}

// Random movement - walk a small distance
function performRandomMovement(bot) {
    if (!bot.entity || !bot.pathfinder) return;

    const moves = ['forward', 'back', 'left', 'right', 'small_walk'];
    const move = moves[Math.floor(Math.random() * moves.length)];

    switch(move) {
        case 'forward':
            bot.setControlState('forward', true);
            setTimeout(() => bot.setControlState('forward', false), 500 + Math.random() * 1000);
            break;
        case 'back':
            bot.setControlState('back', true);
            setTimeout(() => bot.setControlState('back', false), 500 + Math.random() * 1000);
            break;
        case 'left':
            bot.setControlState('left', true);
            setTimeout(() => bot.setControlState('left', false), 300 + Math.random() * 500);
            break;
        case 'right':
            bot.setControlState('right', true);
            setTimeout(() => bot.setControlState('right', false), 300 + Math.random() * 500);
            break;
        case 'small_walk':
            // Use pathfinder to walk to nearby random position
            const x = bot.entity.position.x + (Math.random() - 0.5) * 3;
            const z = bot.entity.position.z + (Math.random() - 0.5) * 3;
            const y = bot.entity.position.y;

            try {
                bot.pathfinder.goto(new GoalNear(x, y, z, 1)).catch(() => {
                    // Pathfinding failed, just do manual movement
                    bot.setControlState('forward', true);
                    setTimeout(() => bot.setControlState('forward', false), 1000);
                });
            } catch (e) {
                // Fallback to simple movement
                bot.setControlState('forward', true);
                setTimeout(() => bot.setControlState('forward', false), 1000);
            }
            break;
    }

    console.log(`[${getTimestamp()}] Anti-AFK: Movement (${move})`);
}

// Random jumping
function performRandomJump(bot) {
    if (!bot.entity) return;

    const jumpTypes = ['normal', 'sprint'];
    const type = jumpTypes[Math.floor(Math.random() * jumpTypes.length)];

    if (type === 'sprint') {
        bot.setControlState('sprint', true);
        bot.setControlState('jump', true);
        setTimeout(() => {
            bot.setControlState('jump', false);
            setTimeout(() => bot.setControlState('sprint', false), 500);
        }, 500);
    } else {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 250);
    }

    console.log(`[${getTimestamp()}] Anti-AFK: Jump (${type})`);
}

// Crouch toggle (sneak/unsneak)
function performCrouchToggle(bot) {
    if (!bot.entity) return;

    bot.setControlState('sneak', true);
    setTimeout(() => {
        bot.setControlState('sneak', false);
    }, 1000 + Math.random() * 2000);

    console.log(`[${getTimestamp()}] Anti-AFK: Crouch toggle`);
}

// FalixNodes specific message patterns
const FALIX_PATTERNS = {
    // "Are you here?" AFK check
    afkCheck: [
        /are you here\?/i,
        /are you still there\?/i,
        /are you afk\?/i,
        /afk check/i,
        /respond to confirm/i,
        /type.*to confirm/i,
        /confirm you are here/i
    ],
    // Stop server timer
    stopTimer: [
        /server will stop in/i,
        /server stopping in/i,
        /stop.*timer/i,
        /shutting down in/i,
        /restart.*in/i,
        /server.*restart.*in/i,
        /countdown.*stop/i,
        /auto.*stop/i
    ],
    // Server is stopping now
    stoppingNow: [
        /server is stopping/i,
        /server stopping now/i,
        /shutting down now/i,
        /server closed/i
    ]
};

// Handle FalixNodes specific messages
function handleFalixMessages(bot, message) {
    // Check for AFK check messages
    if (FALIX_PATTERNS.afkCheck.some(pattern => pattern.test(message))) {
        console.log(`[${getTimestamp()}] Falix: AFK check detected! Responding...`);
        // Respond with random message to show we're not AFK
        const responses = ['yes', 'yeah', 'here', 'present', 'yep', 'yes im here', 'not afk'];
        const response = responses[Math.floor(Math.random() * responses.length)];

        setTimeout(() => {
            bot.chat(response);
            console.log(`[${getTimestamp()}] Falix: Responded to AFK check`);
        }, 1000 + Math.random() * 2000);
        return true;
    }

    // Check for stop timer - LEAVE AND REJOIN to cancel it
    if (FALIX_PATTERNS.stopTimer.some(pattern => pattern.test(message))) {
        console.log(`[${getTimestamp()}] Falix: STOP TIMER DETECTED! Leaving and rejoining to cancel...`);

        // Leave and rejoin sequence
        setTimeout(() => {
            bot.chat('Disconnecting to cancel stop timer...');
            console.log(`[${getTimestamp()}] Falix: Disconnecting now...`);

            // Disconnect
            bot.quit();

            // Reconnect after 3 seconds
            setTimeout(() => {
                console.log(`[${getTimestamp()}] Falix: Reconnecting to cancel timer...`);
                createBot();
            }, 3000);
        }, 1000);
        return true;
    }

    // Check if server is stopping now
    if (FALIX_PATTERNS.stoppingNow.some(pattern => pattern.test(message))) {
        console.log(`[${getTimestamp()}] Falix: Server is stopping! Will reconnect when back up...`);
        // Wait longer before reconnecting since server is actually stopping
        setTimeout(() => {
            console.log(`[${getTimestamp()}] Falix: Attempting to reconnect after shutdown...`);
            createBot();
        }, 30000); // Wait 30 seconds for server to restart
        return true;
    }

    return false;
}

// Handle chat commands
function handleCommand(bot, message) {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.includes('status')) {
        const runtime = Math.floor((Date.now() - startTime) / 1000 / 60);
        const health = bot.health || '?';
        const food = bot.food || '?';
        const pos = formatPosition(bot.entity?.position);
        const authStatus = isAuthMeAuthenticated ? 'Auth: Yes' : 'Auth: No';
        bot.chat(`Status: ${runtime}min | HP: ${health}/20 | Food: ${food}/20 | ${authStatus} | Pos: ${pos}`);
    }
    else if (lowerMsg.includes('pos') || lowerMsg.includes('position')) {
        const pos = formatPosition(bot.entity?.position);
        bot.chat(`Position: ${pos}`);
    }
    else if (lowerMsg.includes('stop') || lowerMsg.includes('shutdown')) {
        bot.chat('Shutting down AFK bot...');
        gracefulShutdown(bot);
    }
    else if (lowerMsg.includes('auth') || lowerMsg.includes('login')) {
        const status = isAuthMeAuthenticated ? 'Authenticated' : 'Not Authenticated';
        bot.chat(`AuthMe Status: ${status}`);
    }
}

// Helper: Get random interval between min and max
function getRandomInterval(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper: Format position
function formatPosition(pos) {
    if (!pos) return 'unknown';
    return `X:${Math.floor(pos.x)} Y:${Math.floor(pos.y)} Z:${Math.floor(pos.z)}`;
}

// Helper: Get timestamp
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// Graceful shutdown
function gracefulShutdown(bot) {
    isShuttingDown = true;
    console.log(`[${getTimestamp()}] Initiating graceful shutdown...`);

    if (bot) {
        bot.chat('AFK Bot disconnecting. Goodbye!');
        setTimeout(() => {
            bot.quit();
            process.exit(0);
        }, 1000);
    } else {
        process.exit(0);
    }
}

// Runtime monitoring - shutdown at 5h 50m
function checkRuntime() {
    const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;

    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        console.log(`[${getTimestamp()}] Runtime limit reached (${MAX_RUNTIME_MINUTES} minutes). Shutting down for restart...`);
        gracefulShutdown(botInstance);
        return;
    }

    // Log status every 10 minutes
    if (Math.floor(elapsedMinutes) % 10 === 0) {
        const remaining = MAX_RUNTIME_MINUTES - elapsedMinutes;
        const authStatus = isAuthMeAuthenticated ? 'Authenticated' : 'Not Authenticated';
        console.log(`[${getTimestamp()}] Runtime: ${Math.floor(elapsedMinutes)}min / ${MAX_RUNTIME_MINUTES}min (${Math.floor(remaining)}min remaining) | Auth: ${authStatus}`);
    }
}

// Start the bot
console.log('==========================================');
console.log('       Minecraft AFK Bot Starting        ');
console.log('==========================================');
console.log(`Bot Username: ${BOT_USERNAME}`);
console.log(`Server: ${SERVER_HOST}:${SERVER_PORT}`);
console.log(`Version: ${SERVER_VERSION}`);
console.log(`Max Runtime: ${MAX_RUNTIME_MINUTES} minutes (5h 50m)`);
console.log(`AuthMe Support: Enabled (Auto-Password: ${AUTHME_PASSWORD})`);
console.log('==========================================');

// Create bot
const bot = createBot();

// Start runtime checker
setInterval(checkRuntime, 60000); // Check every minute

// Handle process signals
process.on('SIGINT', () => gracefulShutdown(botInstance));
process.on('SIGTERM', () => gracefulShutdown(botInstance));
