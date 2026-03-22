# AFK Bot (COOLBOI)  V1.5

An advanced Minecraft AFK bot specifically optimized for servers. Runs on GitHub Actions with powerful anti-AFK protection, automatic AuthMe authentication

## Features

### Core Features
- **Bot Name**: `COOLBOI`
- **Target Server**: `Your Target server`
- **Auto-Register/Login**: Automatically handles AuthMe `/register` and `/login`
- **Persistent Password**: You have to make a github secrete for the bot password which will get generated when the bot joins a server (1st time only)


### Anti-AFK Protection
- Moves to a random place
- smart edge detector

### Auto Management
- **Auto-Reconnect**: Reconnects if disconnected or kicked
- **Auto-Restart**: Stops at exactly 5 hours 40 minutes, then triggers a new run
- **Runtime Limit**: 340 minutes (5h 40m) to stay within FalixNodes limits

## GitHub Actions Workflow

### How It Works

1. **Scheduled Runs**: The workflow runs automatically every 5 hours
2. **Auto-Restart**: When a run completes, it automatically triggers a new one after 5 minutes
4. **Timeout Protection**: Hard timeout at 5h 40m to ensure clean restarts

### Manual Trigger

You can manually trigger the bot:
1. Go to **Actions** tab
2. Select **"AFK Bot"**
3. Click **"Run workflow"**

## Bot Behavior

### First Join (Registration)
1. Bot joins as `COOLBOI`
2. AuthMe prompts to `/register`
3. Bot generates a random 16-character password
4. Sends: `/register <password> <password>`

### Subsequent Joins (Login)
1. Bot joins as `COOLBOI`
2. AuthMe prompts to `/login`
3. Bot loads the saved password
4. Sends: `/login <password>`

### Stop Timer Detection
When server announces a stop timer:
1. Bot immediately sends a chat message
2. Disconnects from server
3. Waits
4. Reconnects

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
const SERVER_HOST = 'Your Target Server';
const SERVER_PORT = 
const SERVER_VERSION = 
const AUTH_TYPE = 
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
2. Click on the latest **"AFK Bot"** run
3. View the logs in real-time

Log output shows:
- Connection status
- AuthMe authentication steps
- Anti-AFK actions performed
  
## Troubleshooting

### Bot not joining
- Check if the server IP/port is correct
- Verify the server is online
- Check Actions logs for errors
- check if the hoster doesn't block the i bot's ip

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
- additional secrets needed only the github_secrete and the bot's password if the server has authme plugin

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

## Doesn't work if the hoster is blocking bots IP
