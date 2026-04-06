// ── follow.js ─────────────────────────────────────────────────────
// Drop-in follow module for COOLBOI.
// Attach with: require('./follow')(bot, { ownerName, stopAllTasks, startAntiAfk, roamTimers, sleep, randMs })
// ─────────────────────────────────────────────────────────────────

const { GoalFollow, GoalNear } = require('mineflayer-pathfinder').goals;

module.exports = function attachFollow(bot, {
    ownerName,       // your IGN — only you can command the bot
    stopAllTasks,    // fn from main bot — pauses roaming
    startAntiAfk,   // fn from main bot — resumes roaming
    roamTimers,      // shared timer array for cleanup
    sleep,
    randMs,
}) {
    // ── State ─────────────────────────────────────────────────────
    let followActive  = false;
    let followSession = 0;
    let distCheckInt  = null;

    // ── Auto-eat ──────────────────────────────────────────────────
    // Requires mineflayer-auto-eat plugin:  npm i mineflayer-auto-eat
    // If you don't have it, this block is safely skipped.
    try {
        const autoEat = require('mineflayer-auto-eat').plugin;
        bot.loadPlugin(autoEat);
        bot.once('spawn', () => {
            bot.autoEat.options = {
                priority:        'foodPoints',
                startAt:         16,          // eat when hunger <= 16 (8 shanks)
                bannedFood:      [],
                eatingTimeout:   3000,
                ignoreInventoryCheck: false,
            };
            bot.autoEat.enable();
            console.log('[Follow] Auto-eat enabled.');
        });
    } catch {
        console.log('[Follow] mineflayer-auto-eat not installed — skipping auto-eat.');
    }

    // ── Auto-totem ────────────────────────────────────────────────
    // Moves a totem from inventory to off-hand whenever off-hand is empty.
    function equipTotem() {
        try {
            const offhand = bot.inventory.slots[45]; // slot 45 = off-hand
            if (offhand && offhand.name.includes('totem')) return;

            const totem = bot.inventory.items().find(i => i.name.includes('totem'));
            if (!totem) return;

            bot.equip(totem, 'off-hand').catch(() => {});
            console.log('[Follow] Totem equipped to off-hand.');
        } catch {}
    }

    // Check totem every 5s
    setInterval(equipTotem, 5000);
    bot.on('spawn', equipTotem);

    // ── Whisper parser ────────────────────────────────────────────
    // Covers vanilla:  [player -> COOLBOI] text
    //          Paper:  player whispers to you: text
    //          Also catches general chat mentions for servers that echo /msg differently
    function parseWhisper(raw) {
        const text = raw.toString();

        // vanilla / paper whisper formats
        const m =
            text.match(/^\[([^->\]]+)\s*->\s*[^\]]+\]\s*(.+)$/) ||   // [player -> bot] text
            text.match(/^([A-Za-z0-9_]{1,16})\s+whispers(?:\s+to\s+you)?:\s*(.+)$/i) ||
            text.match(/^([A-Za-z0-9_]{1,16})\s*»\s*(.+)$/);         // some plugin formats

        if (!m) return null;
        return { sender: m[1].trim(), content: m[2].trim() };
    }

    // ── Main chat listener ────────────────────────────────────────
    bot.on('message', (jsonMsg) => {
        const parsed = parseWhisper(jsonMsg);
        if (!parsed) return;

        const { sender, content } = parsed;
        if (sender.toLowerCase() !== ownerName.toLowerCase()) return;

        const cmd = content.toLowerCase().trim();

        if (cmd === 'follow me' || cmd === 'follow') {
            startFollow();
        } else if (cmd === 'stop' || cmd === 'afk' || cmd === 'unfollow') {
            stopFollow(true);
        } else if (cmd === 'status') {
            const st = followActive ? 'following you' : 'in AFK mode';
            try { bot.chat(`/msg ${ownerName} I am ${st}.`); } catch {}
        }
    });

    // ── Start follow ──────────────────────────────────────────────
    function startFollow() {
        if (followActive) {
            try { bot.chat(`/msg ${ownerName} Already following you!`); } catch {}
            return;
        }

        console.log(`[Follow] Follow mode activated for ${ownerName}.`);
        stopAllTasks();        // pause roaming
        followActive  = true;
        followSession++;
        const mySession = followSession;

        try { bot.chat(`/msg ${ownerName} On my way!`); } catch {}

        // Set pathfinder to follow owner continuously
        function updateGoal() {
            if (!followActive || followSession !== mySession) return;
            const player = bot.players[ownerName]?.entity;
            if (!player) return;
            try {
                bot.pathfinder.setGoal(new GoalFollow(player, 3), true);
                // 3 = stay within 3 blocks; 'true' = dynamic (updates as player moves)
            } catch {}
        }

        // Refresh goal every 500ms (human-ish speed, not tick-perfect)
        distCheckInt = setInterval(() => {
            if (!followActive || followSession !== mySession) {
                clearInterval(distCheckInt);
                return;
            }

            const player = bot.players[ownerName]?.entity;
            if (!player) return;

            const dist = bot.entity.position.distanceTo(player.position);

            // If player teleported far away (rtp/home/warp) → send /tpa
            if (dist > 60) {
                console.log(`[Follow] Owner teleported (dist ${Math.floor(dist)}) — sending /tpa`);
                try { bot.chat(`/tpa ${ownerName}`); } catch {}
                // Stop pathfinding while waiting for TP
                try { bot.pathfinder.stop(); } catch {}
                return;
            }

            updateGoal();
        }, 500);

        roamTimers.push(distCheckInt);
    }

    // ── Stop follow ───────────────────────────────────────────────
    function stopFollow(resumeAfk = false) {
        if (!followActive) return;

        console.log('[Follow] Follow mode deactivated.');
        followActive = false;
        followSession++;

        if (distCheckInt) {
            clearInterval(distCheckInt);
            distCheckInt = null;
        }

        try { bot.pathfinder.stop(); } catch {}

        if (resumeAfk) {
            try { bot.chat(`/msg ${ownerName} Going back to AFK mode.`); } catch {}
            const t = setTimeout(() => startAntiAfk(), 1500);
            roamTimers.push(t);
        }
    }

    // Expose so main bot can call stopFollow on disconnect/death
    return { startFollow, stopFollow };
};
