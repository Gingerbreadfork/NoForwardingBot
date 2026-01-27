import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

loadEnv();

const requiredToken = process.env.BOT_TOKEN;

if (!requiredToken) {
  console.error('Missing BOT_TOKEN. Provide it via environment variable or .env file.');
  process.exit(1);
}

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const configuredBanPath = process.env.BAN_LOG_PATH || 'banned.log';
const resolvedBanPath = isAbsolute(configuredBanPath)
  ? configuredBanPath
  : resolve(projectRoot, configuredBanPath);
const BAN_LOG_PATH = resolvedBanPath;
let logDirEnsured = false;
const TEST_MODE = String(process.env.TEST_MODE || '').toLowerCase() === 'true';

const bot = new Telegraf(requiredToken, {
  handlerTimeout: 9_000
});

const GROUP_TYPES = new Set(['group', 'supergroup']);
const PROTECTED_STATUSES = new Set(['creator', 'administrator']);

const LEGACY_FORWARD_FIELDS = [
  'forward_date',
  'forward_from',
  'forward_from_chat',
  'forward_sender_name',
  'forward_signature',
  'forward_from_message_id'
];

const isGroupChat = (chat = {}) => GROUP_TYPES.has(chat.type);

const hasForwardOrigin = (message = {}) => Boolean(message.forward_origin);

const hasLegacyForwardMetadata = (message = {}) =>
  LEGACY_FORWARD_FIELDS.some((field) => Object.hasOwn(message, field) && Boolean(message[field]));

const isForwardedMessage = (message = {}) =>
  hasForwardOrigin(message) || hasLegacyForwardMetadata(message);

const formatTimestamp = () => new Date().toISOString();

const buildUserLabel = (user) => {
  if (!user) return 'Unknown user';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username;
  if (name && user.username) {
    return `${name} (@${user.username})`;
  }

  if (name) {
    return name;
  }

  return `user ${user.id}`;
};

const normalizeForLog = (value) => {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
};

const describeContext = (chat, offender, message) => ({
  chat_id: chat?.id ?? 'unknown',
  chat_title: normalizeForLog(chat?.title || chat?.username || ''),
  user_id: offender?.id ?? 'unknown',
  user: normalizeForLog(buildUserLabel(offender)),
  message_id: message?.message_id ?? 'unknown'
});

const LOG_METHODS = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

const logConsole = (level, text, meta = {}) => {
  const method = LOG_METHODS[level] || console.log.bind(console);
  const entry = `[${formatTimestamp()}] [${level.toUpperCase()}] ${text}`;
  if (meta && Object.keys(meta).length) {
    method(entry, meta);
  } else {
    method(entry);
  }
};

const getBanSkipReason = (message) => {
  if (!message) {
    return 'missing_message';
  }

  if (message.is_automatic_forward) {
    return 'automatic_forward';
  }

  if (!message.from) {
    return 'missing_sender';
  }

  if (message.from.is_bot) {
    return 'bot_sender';
  }

  return null;
};

const logAction = async (ctx, text) => {
  const threadId = ctx.message?.message_thread_id;
  const chatId = ctx.chat?.id ?? ctx.message?.chat?.id;
  if (!chatId) {
    return;
  }

  try {
    await ctx.telegram.sendMessage(chatId, text, {
      disable_notification: true,
      ...(typeof threadId === 'number' ? { message_thread_id: threadId } : {})
    });
  } catch {
    // Silence logging errors so moderation continues unaffected
  }
};

const recordBan = async ({ chat, offender, message }) => {
  const logLine = [
    formatTimestamp(),
    `chat_id=${chat?.id ?? 'unknown'}`,
    `chat_title="${normalizeForLog(chat?.title || chat?.username || '')}"`,
    `user_id=${offender?.id ?? 'unknown'}`,
    `user="${normalizeForLog(buildUserLabel(offender))}"`,
    `message_id=${message?.message_id ?? 'unknown'}`
  ].join('\t');

  try {
    if (!logDirEnsured) {
      await mkdir(dirname(BAN_LOG_PATH), { recursive: true });
      logDirEnsured = true;
    }
    await appendFile(BAN_LOG_PATH, `${logLine}\n`);
  } catch (err) {
    console.error(`Failed to write ban log for ${buildUserLabel(offender)}:`, err);
  }
};

bot.on('message', async (ctx, next) => {
  const { chat, message } = ctx;

  if (!isGroupChat(chat) || !message) {
    return next();
  }

  if (!isForwardedMessage(message)) {
    return next();
  }

  const offender = message.from;
  const contextDetails = describeContext(chat, offender, message);

  if (message.is_automatic_forward) {
    logConsole('info', 'Ignored automatic forward from linked chat', contextDetails);
    return next();
  }

  if (!offender) {
    logConsole('warn', 'Forwarded message missing sender metadata', contextDetails);
    return next();
  }

  logConsole('info', 'Forwarded message detected', contextDetails);

  if (TEST_MODE) {
    logConsole('info', 'TEST_MODE: would delete forwarded message', contextDetails);
  } else {
    try {
      await ctx.deleteMessage(message.message_id);
      logConsole('info', 'Forwarded message deleted', contextDetails);
    } catch (err) {
      await logAction(
        ctx,
        `Forwarded message detected but could not delete it. Error: ${err.message}`
      );
      logConsole('warn', 'Failed to delete forwarded message', {
        ...contextDetails,
        error: err.message
      });
    }
  }

  const skipReason = getBanSkipReason(message);
  if (skipReason) {
    logConsole('info', 'Skipping ban for forwarded message', {
      ...contextDetails,
      reason: skipReason
    });
    return next();
  }

  let memberInfo;

  try {
    memberInfo = await ctx.telegram.getChatMember(chat.id, offender.id);
  } catch (err) {
    await logAction(
      ctx,
      `Failed to inspect ${buildUserLabel(offender)} before banning. Error: ${err.message}`
    );
    logConsole('warn', 'Failed to inspect offender before banning', {
      ...contextDetails,
      error: err.message
    });
  }

  if (memberInfo && PROTECTED_STATUSES.has(memberInfo.status)) {
    logConsole('info', 'Skipping ban for protected member', {
      ...contextDetails,
      status: memberInfo.status
    });
    return next();
  }

  if (TEST_MODE) {
    logConsole('info', 'TEST_MODE: would ban user for forwarding message', contextDetails);
    return;
  }

  try {
    await ctx.banChatMember(offender.id, { revoke_messages: true });

    await logAction(
      ctx,
      `🚫 ${buildUserLabel(offender)} was banned for forwarding a message.`
    );
    logConsole('info', 'User banned for forwarding message', contextDetails);
    await recordBan({ chat, offender, message });
  } catch (err) {
    await logAction(
      ctx,
      `Tried to ban ${buildUserLabel(offender)} for forwarding a message but failed. Error: ${
        err.message
      }`
    );
    logConsole('error', 'Failed to ban user for forwarding message', {
      ...contextDetails,
      error: err.message
    });
  }
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('NoForwardingBot is now watching for forwarded spam...');
  if (TEST_MODE) {
    console.warn('NoForwardingBot is running in TEST_MODE. No bans or deletions will be performed.');
  }
});

const gracefulShutdown = (signal) => {
  process.once(signal, () => {
    bot.stop(`Received ${signal}`);
    process.exit(0);
  });
};

['SIGINT', 'SIGTERM'].forEach(gracefulShutdown);
