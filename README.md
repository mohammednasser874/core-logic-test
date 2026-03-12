# FalixNodes AFK Bot (COOLBOI)

An advanced Minecraft AFK bot specifically optimized for **FalixNodes** servers. Runs on GitHub Actions with powerful anti-AFK protection, automatic AuthMe authentication, and FalixNodes-specific features.

## Features

### Core Features
- **Bot Name**: `COOLBOI` (fixed)
- **Target Server**: `ahsmpw.falixsrv.me:29724`
- **Auto-Register/Login**: Automatically handles AuthMe `/register` and `/login`
- **Persistent Password**: Password is saved and reused between sessions (via GitHub Cache)

### FalixNodes Specific Features
- **"Are You Here?" Detection**: Automatically responds to FalixNodes AFK checks
- **Stop Timer Cancel**: Detects server stop timers and leaves/rejoins to cancel them
- **FalixNodes Optimized**: Anti-AFK designed specifically for FalixNodes kick patterns

### Anti-AFK Protection
- Random arm swinging every 15-45 seconds
- Head rotation every 20-60 seconds
- Small movements every 30-90 seconds
- Random jumping every 60-180 seconds
- Continuous subtle head movements
- Pathfinding to random nearby positions

### Auto Management
- **Auto-Reconnect**: Reconnects if disconnected or kicked
- **Auto-Restart**: Stops at exactly 5 hours 40 minutes, then triggers a new run
- **Runtime Limit**: 340 minutes (5h 40m) to stay within FalixNodes limits

## GitHub Actions Workflow

### How It Works

1. **Scheduled Runs**: The workflow runs automatically every 5 hours
2. **Auto-Restart**: When a run completes, it automatically triggers a new one after 5 minutes
3. **Password Persistence**: The bot's password is cached between runs using GitHub Actions Cache
4. **Timeout Protection**: Hard timeout at 5h 40m to ensure clean restarts

### Manual Trigger

You can manually trigger the bot:
1. Go to **Actions** tab
2. Select **"FalixNodes AFK Bot"**
3. Click **"Run workflow"**

## Bot Behavior

### First Join (Registration)
1. Bot joins as `COOLBOI`
2. AuthMe prompts to `/register`
3. Bot generates a random 16-character password
4. Sends: `/register <password> <password>`
5. Password is saved to cache for future logins

### Subsequent Joins (Login)
1. Bot joins as `COOLBOI`
2. AuthMe prompts to `/login`
3. Bot loads the saved password from cache
4. Sends: `/login <password>`

### "Are You Here?" Response
When FalixNodes sends "Are you here?" or similar AFK check:
- Bot randomly responds with: `yes`, `yeah`, `here`, `present`, `yep`, `yes im here`, or `not afk`
- Response is delayed 1-3 seconds to appear natural

### Stop Timer Detection
When server announces a stop timer:
1. Bot immediately sends a chat message
2. Disconnects from server
3. Waits 3 seconds
4. Reconnects (this cancels the stop timer on FalixNodes)

## File Structure

```
bot-code/
├── bot.js              # Main bot code with all features
├── package.json        # Dependencies
├── .github/
│   └── workflows/
│       └── afk-bot.yml # GitHub Actions workflow
└── .bot_password       # Cached password (auto-generated)
```

## Configuration

The bot is pre-configured with these settings:

```javascript
const BOT_USERNAME = 'COOLBOI';
const SERVER_HOST = 'ahsmpw.falixsrv.me';
const SERVER_PORT = 29724;
const SERVER_VERSION = '1.20.1';
const AUTH_TYPE = 'offline';
const MAX_RUNTIME_MINUTES = 340; // 5h 40m
```

## Workflow Schedule

```yaml
# Runs every 5 hours
cron: '0 */5 * * *'

# Also runs at 45 minutes past every 6th hour (redundancy)
cron: '45 */6 * * *'
```

## Runtime Cycle

```
Run Start
    |
    v
Join Server
    |
    v
AuthMe Login/Register
    |
    v
Anti-AFK Routines Active
    |
    v
Watch for:
  - "Are you here?" -> Respond
  - Stop Timer -> Leave/Rejoin
  - Disconnect -> Reconnect
    |
    v
5h 40m reached
    |
    v
Disconnect
    |
    v
Wait 5 minutes
    |
    v
Trigger new run
    |
    v
Repeat
```

## Monitoring

View bot activity:
1. Go to **Actions** tab in GitHub
2. Click on the latest **"FalixNodes AFK Bot"** run
3. View the logs in real-time

Log output shows:
- Connection status
- AuthMe authentication steps
- Anti-AFK actions performed
- "Are you here?" responses
- Stop timer detections
- Runtime progress

## Troubleshooting

### Bot not joining
- Check if the server IP/port is correct
- Verify the server is online
- Check Actions logs for errors

### AuthMe issues
- Password is cached; if registration failed, clear the cache
- Manual reset: Go to Actions → Caches → Delete `bot-password-*`

### Stopped working
- Check if server has whitelist
- Verify bot wasn't banned
- Check if server requires a different Minecraft version

## Requirements

- GitHub repository (public or private)
- GitHub Actions enabled (free tier works)
- No additional secrets needed (all config is hardcoded)

## Notes

- **GitHub Actions free tier**: 2,000 minutes/month (enough for ~5-6 runs of this bot)
- The bot is designed for continuous operation but respects GitHub's limits
- Password persistence uses GitHub Actions Cache (valid for 7 days)

## Disclaimer

**Use at your own risk!**
- Only use on servers you own or have permission to use
- Respect server rules and terms of service
- Not responsible for any bans or penalties

## License

MIT

## Credits

Built with [Mineflayer](https://github.com/PrismarineJS/mineflayer) - Minecraft bot framework for Node.js
