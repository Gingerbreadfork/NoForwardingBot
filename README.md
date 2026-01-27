# NoForwardingBot

NoForwardingBot is an aggressive Telegram moderator that eliminates forwarded spam in group chats. The bot immediately deletes the offending message and bans the sender while staying out of everyone's way.

## Features

- Detects every flavor of manual forwards (from users, channels, or external chats)
- Deletes the forwarded message before anyone sees it
- Bans the sender, while skipping administrators and automatic forwards from linked channels
- Writes every ban to `banned.log` (or a custom file) for effortless auditing
- Streams every moderation decision to stdout so you can monitor the bot without opening Telegram
- Optional testing mode to rehearse moderation without deleting or banning anyone
- Graceful error handling so failed bans never crash the bot

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Use Node.js 18+ (the bot relies on the latest Telegram Bot API features).
3. Clone this repository and install dependencies:
   ```bash
   npm install
   ```
4. Provide the bot token (and optionally override the ban log path) in an `.env` file:
   ```bash
   cat <<'EOF' > .env
   BOT_TOKEN=123456:ABC
   BAN_LOG_PATH=./banned.log
   TEST_MODE=false
   EOF
   ```
5. Run the bot:
   ```bash
   npm start
   # or
   pnpm dev
   ```

## How it Works

The bot listens to every message in the group. If Telegram marks the message as forwarded, the bot deletes it and bans the sender (unless that user is an admin). The action is logged in the group so everyone knows what happened.

Every successful ban is also appended to the file specified via `BAN_LOG_PATH` (defaults to `./banned.log`). Each line includes the timestamp, chat information, and the user who was removed—the perfect audit trail for moderators. Relative paths are resolved from the project root (alongside this README) and the directory is created automatically if it does not exist.

Need a rehearsal run? Set `TEST_MODE=true` so the bot only logs (to stdout) what it would delete/ban without touching any user or message in Telegram. Flip it back to `false` for full enforcement.

For best results, give the bot the administrator permissions to delete messages and ban members. The bot refuses to start if it does not have a valid token.
