# Minecraft AFK Bot

An automated Minecraft AFK bot using [Mineflayer](https://github.com/PrismarineJS/mineflayer) that runs on GitHub Actions with intelligent anti-AFK protection.

## Features

- **Smart Anti-AFK**: Random movements every minute to avoid being kicked
  - Arm swinging (15-45 second intervals)
  - Head rotation (20-60 second intervals)
  - Small walks/jumps (30-90 second intervals)
  - Continuous subtle movements
- **AuthMe Auto-Login**: Automatically handles `/login` and `/register` commands
- **Auto-Reconnect**: Automatically reconnects if disconnected
- **Auto-Restart**: Stops at 5h 50m and automatically triggers a new run
- **Remote Commands**: Respond to chat commands for status checks
- **Health Monitoring**: Tracks health and food levels
- **Pathfinding**: Uses mineflayer-pathfinder for intelligent movement

## Setup

1. **Fork this repository**

2. **Configure Secrets** (Settings → Secrets and variables → Actions):

| Secret | Required | Default | Description |
|--------|----------|---------|-------------|
| `SERVER_HOST` | Yes | - | Minecraft server IP or hostname |
| `SERVER_PORT` | No | `25565` | Server port |
| `BOT_USERNAME` | No | `AFKBot_GH` | Bot's username |
| `SERVER_VERSION` | No | `1.20.1` | Minecraft version |
| `AUTH_TYPE` | No | `offline` | Authentication: `offline`, `microsoft`, or `mojang` |
| `BOT_PASSWORD` | No | - | Password (for online servers) |

3. **Start the Bot**

   Go to Actions → Minecraft AFK Bot → Run workflow

## Anti-AFK Actions

The bot performs these actions at random intervals:

- **Arm Swinging**: Simulates clicking/using items
- **Head Turning**: Looks around randomly
- **Walking**: Small forward/back/side movements
- **Jumping**: Occasional jumps (sometimes while sprinting)
- **Sneaking**: Brief crouch toggles
- **Pathfinding**: Walks to nearby random positions

## Chat Commands

If you mention the bot's username in chat, it can respond to commands:

- `@AFKBot status` - Shows runtime, health, food, auth status, and position
- `@AFKBot pos` - Shows current coordinates
- `@AFKBot auth` - Shows AuthMe authentication status
- `@AFKBot stop` - Gracefully shuts down the bot

## AuthMe Plugin Support

If the server uses the [AuthMe](https://github.com/AuthMe/AuthMeReloaded) plugin, the bot automatically handles authentication with a **randomly generated password**:

### How it works

1. When the bot joins, AuthMe typically sends "Please /login" or "Please /register"
2. The bot automatically generates a random 12-character password
3. It detects the prompts and sends the appropriate command:
   - **First time**: `/register <random_password> <random_password>`
   - **After that**: `/login <same_random_password>`
4. It waits 2-4 seconds (randomized) before responding to appear more natural
5. After successful authentication, anti-AFK routines start automatically
6. If authentication fails 3 times, the bot reconnects and tries again

### AuthMe Features

- **Auto-Generated Password**: 12-character random password (e.g., `aB3xK9pL2mN4`)
- **Auto-Register**: Detects register prompts and registers automatically
- **Auto-Login**: Detects login prompts and logs in with the same password
- **Success Detection**: Recognizes successful authentication messages
- **Error Handling**: Handles already registered, wrong password, etc.
- **Anti-AFK Delay**: Won't move until fully authenticated

### Note on Password Persistence

Since GitHub Actions runners don't have persistent storage, **each new run generates a new random password**. This means:
- If the bot reconnects within the same 6-hour run → uses the same password ✅
- If a new GitHub Actions run starts → generates a new password ⚠️

For servers where you want the same account across multiple days, you should manually register the bot once, then add the username/password to the server's AuthMe database directly.

## Runtime Behavior

- **Max Runtime**: 5 hours 50 minutes (350 minutes)
- **Auto-Restart**: Automatically triggers a new workflow run when time is up
- **Continuous Operation**: With GitHub Actions scheduling, the bot runs 24/7
- **Logs**: Available in the Actions tab for each run

## Requirements

- Minecraft server (vanilla, Spigot, Paper, etc.)
- For cracked/offline servers: use `AUTH_TYPE: offline`
- For premium servers: use `AUTH_TYPE: microsoft` with valid credentials

## Disclaimer

**Use at your own risk!** Some servers prohibit AFK bots. Make sure to:
- Check server rules before using
- Use on servers you own or have permission to use
- Not use for malicious purposes (spam, griefing, etc.)

## License

MIT
