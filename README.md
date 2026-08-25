# NoForwardingBot

NoForwardingBot is an aggressive Telegram moderator that eliminates forwarded spam in group chats. The bot immediately deletes the offending message and bans the sender while staying out of everyone's way.

## Features

- Detects every flavor of manual forwards (from users, channels, or external chats)
- Removes Telegram invite links to other groups/channels and bans whoever posts them
- Blocks messages sent by non-admin bots (including inline `via @bot` spam and quoted bot messages)
- Removes quotes of users from other chats to stop cross-posting spam
- Bans anyone who shares a contact card (toggle with `BLOCK_CONTACTS`)
- Bans anyone who sends the same message more than twice within the last 25 messages (limit, window, and toggle are configurable)
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
   CHAT_NOTIFICATIONS_ENABLED=true
   BLOCK_CONTACTS=true
   BLOCK_REPEATED_MESSAGES=true
   REPEAT_MESSAGE_LIMIT=2
   REPEAT_MESSAGE_WINDOW=25
   REPEAT_MESSAGE_MIN_LENGTH=1
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

Want to keep moderation noise out of the chat entirely? Set `CHAT_NOTIFICATIONS_ENABLED=false` so bans are still enforced and logged to stdout/banned.log without posting confirmation messages in Telegram.

Shared contact cards are treated as spam by default: the message is deleted and the sender is banned (admins are exempt, as with every other rule). Set `BLOCK_CONTACTS=false` to allow members to share contacts.

Repeated messages are also treated as spam. The bot keeps the last `REPEAT_MESSAGE_WINDOW` messages (default 25) per chat in memory; if a member sends the same message more than `REPEAT_MESSAGE_LIMIT` times (default 2) within that window, the message is deleted and the member is banned. Text is compared case-insensitively with whitespace collapsed, and media (photos, videos, documents, stickers, etc.) is compared by Telegram file ID. Set `REPEAT_MESSAGE_MIN_LENGTH` to ignore short text such as "ok" or "lol", or set `BLOCK_REPEATED_MESSAGES=false` to turn the rule off. The window is in-memory only and resets when the bot restarts.

For best results, give the bot the administrator permissions to delete messages, ban members, and manage invites. Without the invite permission the bot cannot confirm whether a `t.me/+HASH` link belongs to your chat, so private invites might slip through moderation. The bot refuses to start if it does not have a valid token.
