// ── follow.js v3 ──────────────────────────────────────────────────
// Features: follow, auto-eat, auto-armor, auto-totem, auto-attack,
//           friendlist, inventory sharing, auto-respawn
// Attach: require('./follow')(bot, { ownerName, stopAllTasks, startAntiAfk, roamTimers, sleep, randMs })
// ─────────────────────────────────────────────────────────────────

const { GoalFollow } = require('mineflayer-pathfinder').goals;

// Armor slot IDs and priority order (higher = better)
const ARMOR_SLOTS  = { head: 5, chest: 6, legs: 7, feet: 8 };
const ARMOR_TIERS  = { leather: 1, chainmail: 2, iron: 3, golden: 3, diamond: 4, netherite: 5 };

module.exports = function attachFollow(bot, {
    ownerName,
    stopAllTasks,
    startAntiAfk,
    roamTimers,
    sleep,
    randMs,
}) {

    // ── State ─────────────────────────────────────────────────────
    let followActive     = false;
    let followSession    = 0;
    let distCheckInt     = null;
    let combatInt        = null;
    let invSession       = null;   // tracks pending inventory request
    const friendList     = new Set([ownerName.toLowerCase()]);  // never attack these

    // ── Auto-eat ──────────────────────────────────────────────────
    try {
        const autoEat = require('mineflayer-auto-eat').loader;
        bot.loadPlugin(autoEat);
        bot.once('spawn', () => {
            bot.autoEat.options = {
                priority:    'foodPoints',
                startAt:     16,
                bannedFood:  [],
                eatingTimeout: 3000,
            };
            bot.autoEat.enable();
            console.log('[Follow] Auto-eat enabled.');
        });
    } catch {
        console.log('[Follow] mineflayer-auto-eat not installed — skipping.');
    }

    // ── Auto-respawn ──────────────────────────────────────────────
    bot.on('death', () => {
        console.log('[Combat] Died — auto-respawning in 1s...');
        setTimeout(() => {
            try { bot.respawn(); } catch {}
        }, 1000);
    });

    // ── Auto-armor ────────────────────────────────────────────────
    function getArmorTier(itemName) {
        if (!itemName) return 0;
        for (const [mat, tier] of Object.entries(ARMOR_TIERS)) {
            if (itemName.includes(mat)) return tier;
        }
        return 0;
    }

    function getArmorType(itemName) {
        if (!itemName) return null;
        if (itemName.includes('helmet') || itemName.includes('cap'))          return 'head';
        if (itemName.includes('chestplate') || itemName.includes('tunic'))    return 'chest';
        if (itemName.includes('leggings') || itemName.includes('pants'))      return 'legs';
        if (itemName.includes('boots') || itemName.includes('shoes'))         return 'feet';
        return null;
    }

    async function equipBestArmor() {
        await sleep(500);
        for (const [slot, slotId] of Object.entries(ARMOR_SLOTS)) {
            const currentItem = bot.inventory.slots[slotId];
            const currentTier = getArmorTier(currentItem?.name);

            // Find best item of this type in inventory
            let bestItem = null;
            let bestTier = currentTier;

            for (const item of bot.inventory.items()) {
                if (getArmorType(item.name) === slot) {
                    const tier = getArmorTier(item.name);
                    if (tier > bestTier) {
                        bestTier = tier;
                        bestItem = item;
                    }
                }
            }

            if (bestItem) {
                try {
                    await bot.equip(bestItem, slot === 'head'  ? 'head'
                                            : slot === 'chest' ? 'torso'
                                            : slot === 'legs'  ? 'legs'
                                            :                    'feet');
                    console.log(`[Armor] Equipped ${bestItem.name} to ${slot}.`);
                    await sleep(200);
                } catch (e) {
                    console.log(`[Armor] Failed to equip ${bestItem?.name}: ${e.message}`);
                }
            }
        }
    }

    // ── Auto-totem ────────────────────────────────────────────────
    async function equipTotem() {
        try {
            const offhand = bot.inventory.slots[45];
            if (offhand?.name?.includes('totem')) return;
            const totem = bot.inventory.items().find(i => i.name.includes('totem'));
            if (!totem) return;
            await bot.equip(totem, 'off-hand');
            console.log('[Armor] Totem equipped to off-hand.');
        } catch {}
    }

    // Equip armor + totem on spawn and inventory change
    bot.on('spawn', async () => {
        await sleep(2000);
        await equipBestArmor();
        await equipTotem();
    });

    bot.on('playerCollect', async (collector) => {
        if (collector.username !== bot.username) return;
        await sleep(500);
        await equipBestArmor();
        await equipTotem();
    });

    setInterval(equipTotem, 10000);

    // ── Auto-attack ───────────────────────────────────────────────
    function startCombat() {
        if (combatInt) return;

        combatInt = setInterval(() => {
            if (!bot.entity) return;

            // Find nearest player not in friendlist
            let nearest = null;
            let nearestDist = 4.5;  // attack range

            for (const [username, player] of Object.entries(bot.players)) {
                if (!player.entity) continue;
                if (friendList.has(username.toLowerCase())) continue;
                if (username === bot.username) continue;

                const dist = bot.entity.position.distanceTo(player.entity.position);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = player.entity;
                }
            }

            if (nearest) {
                try {
                    bot.lookAt(nearest.position.offset(0, nearest.height, 0));
                    bot.attack(nearest);
                    console.log(`[Combat] Attacked ${nearest.username || 'player'} (${Math.floor(nearestDist)}m)`);
                } catch {}
            }
        }, 600);  // ~1 attack per 0.6s (human-ish, not spam)
    }

    function stopCombat() {
        if (combatInt) {
            clearInterval(combatInt);
            combatInt = null;
        }
    }

    // Always run combat loop (it checks range itself)
    bot.on('spawn', () => {
        stopCombat();
        startCombat();
    });

    bot.on('end', stopCombat);

    // ── Inventory sharing ─────────────────────────────────────────
    function buildInventoryList() {
        const items = bot.inventory.items();
        if (!items.length) return null;
        return items.map((item, i) => `${i + 1}. ${item.name} x${item.count}`).join('\n');
    }

    async function handleInvRequest() {
        const items = bot.inventory.items();
        if (!items.length) {
            try { bot.chat(`/msg ${ownerName} My inventory is empty!`); } catch {}
            return;
        }

        invSession = items;  // save current item list

        // Split into chunks of 10 lines (MC chat limit)
        const lines = items.map((item, i) => `${i + 1}. ${item.name} x${item.count}`);
        const chunks = [];
        for (let i = 0; i < lines.length; i += 8) {
            chunks.push(lines.slice(i, i + 8).join(' | '));
        }

        try { bot.chat(`/msg ${ownerName} My inventory (reply with numbers to get items):`); } catch {}
        await sleep(600);
        for (const chunk of chunks) {
            try { bot.chat(`/msg ${ownerName} ${chunk}`); } catch {}
            await sleep(800);
        }
    }

    async function handleInvPick(content) {
        if (!invSession) {
            try { bot.chat(`/msg ${ownerName} No inventory session active. Ask for inventory first.`); } catch {}
            return;
        }

        const nums = content.match(/\d+/g);
        if (!nums) return;

        const indices = nums.map(n => parseInt(n) - 1).filter(i => i >= 0 && i < invSession.length);
        if (!indices.length) return;

        for (const idx of indices) {
            const wanted = invSession[idx];
            // Find the actual current item (inventory may have shifted)
            const actual = bot.inventory.items().find(i => i.name === wanted.name);
            if (!actual) {
                try { bot.chat(`/msg ${ownerName} I don't have ${wanted.name} anymore.`); } catch {}
                continue;
            }
            try {
                await bot.tossStack(actual);
                console.log(`[Inv] Dropped ${actual.name} x${actual.count} for ${ownerName}`);
                await sleep(300);
            } catch (e) {
                console.log(`[Inv] Failed to drop ${actual.name}: ${e.message}`);
            }
        }

        invSession = null;
        await sleep(500);
        await equipBestArmor();
        await equipTotem();
        try { bot.chat(`/msg ${ownerName} Done! Re-equipping best gear.`); } catch {}
    }

    // ── Whisper parser ────────────────────────────────────────────
    function parseWhisper(raw) {
        const text = raw.toString();
        const m =
            text.match(/^\[([^->\]]+)\s*->\s*[^\]]+\]\s*(.+)$/) ||
            text.match(/^([A-Za-z0-9_]{1,16})\s+whispers(?:\s+to\s+you)?:\s*(.+)$/i) ||
            text.match(/^([A-Za-z0-9_]{1,16})\s*»\s*(.+)$/);
        if (!m) return null;
        return { sender: m[1].trim(), content: m[2].trim() };
    }

    // ── Command handler ───────────────────────────────────────────
    bot.on('message', async (jsonMsg) => {
        const parsed = parseWhisper(jsonMsg);
        if (!parsed) return;

        const { sender, content } = parsed;
        const senderLow = sender.toLowerCase();
        const cmd = content.toLowerCase().trim();

        // Only owner can command
        if (senderLow !== ownerName.toLowerCase()) return;

        // follow / stop
        if (cmd === 'follow me' || cmd === 'follow') {
            startFollow();
            return;
        }
        if (cmd === 'stop' || cmd === 'afk' || cmd === 'unfollow') {
            stopFollow(true);
            return;
        }

        // status
        if (cmd === 'status') {
            const st = followActive ? 'following you' : 'in AFK mode';
            const hp = Math.round(bot.health ?? 0);
            const friends = [...friendList].filter(f => f !== ownerName.toLowerCase()).join(', ') || 'none';
            try { bot.chat(`/msg ${ownerName} ${st} | HP:${hp} | Friends: ${friends}`); } catch {}
            return;
        }

        // friend <playername>
        const friendMatch = cmd.match(/^friend\s+([a-z0-9_]{1,16})$/i);
        if (friendMatch) {
            const target = friendMatch[1];
            friendList.add(target.toLowerCase());
            console.log(`[Combat] Added ${target} to friendlist.`);
            try { bot.chat(`/msg ${ownerName} Alr, I will be friends with ${target} and won't attack them.`); } catch {}
            return;
        }

        // unfriend <playername>
        const unfriendMatch = cmd.match(/^unfriend\s+([a-z0-9_]{1,16})$/i);
        if (unfriendMatch) {
            const target = unfriendMatch[1].toLowerCase();
            if (target === ownerName.toLowerCase()) {
                try { bot.chat(`/msg ${ownerName} I can never unfriend you!`); } catch {}
                return;
            }
            friendList.delete(target);
            try { bot.chat(`/msg ${ownerName} Removed ${unfriendMatch[1]} from friends.`); } catch {}
            return;
        }

        // inventory request
        if (cmd === 'give me ur inventory' || cmd === 'inventory' || cmd === 'inv') {
            await handleInvRequest();
            return;
        }

        // picking items from inventory (owner replies with numbers)
        if (/^\d[\d\s,]+$/.test(cmd) && invSession) {
            await handleInvPick(cmd);
            return;
        }

        // equip best gear manually
        if (cmd === 'equip' || cmd === 'gear up') {
            await equipBestArmor();
            await equipTotem();
            try { bot.chat(`/msg ${ownerName} Equipped best gear!`); } catch {}
            return;
        }
    });

    // ── Follow ────────────────────────────────────────────────────
    function startFollow() {
        if (followActive) {
            try { bot.chat(`/msg ${ownerName} Already following you!`); } catch {}
            return;
        }

        console.log(`[Follow] Follow mode activated for ${ownerName}.`);
        stopAllTasks();
        followActive  = true;
        followSession++;
        const mySession = followSession;

        try { bot.chat(`/msg ${ownerName} On my way!`); } catch {}

        distCheckInt = setInterval(() => {
            if (!followActive || followSession !== mySession) {
                clearInterval(distCheckInt);
                return;
            }

            const player = bot.players[ownerName]?.entity;
            if (!player) return;

            const dist = bot.entity.position.distanceTo(player.position);

            if (dist > 60) {
                console.log(`[Follow] Owner teleported (dist ${Math.floor(dist)}) — sending /tpa`);
                try { bot.chat(`/tpa ${ownerName}`); } catch {}
                try { bot.pathfinder.stop(); } catch {}
                return;
            }

            try {
                bot.pathfinder.setGoal(new GoalFollow(player, 3), true);
            } catch {}
        }, 500);

        roamTimers.push(distCheckInt);
    }

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

    return { startFollow, stopFollow, equipBestArmor, equipTotem };
};
