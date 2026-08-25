import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

loadEnv();

const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
};

const parseIntegerEnv = (name, defaultValue, { min = 0 } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    console.warn(`Ignoring invalid ${name}="${raw}" (expected an integer >= ${min}); using ${defaultValue}.`);
    return defaultValue;
  }
  return parsed;
};

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
const TEST_MODE = parseBooleanEnv(process.env.TEST_MODE, false);
const CHAT_NOTIFICATIONS_ENABLED = parseBooleanEnv(process.env.CHAT_NOTIFICATIONS_ENABLED, true);
const BLOCK_CONTACTS = parseBooleanEnv(process.env.BLOCK_CONTACTS, true);
const BLOCK_REPEATED_MESSAGES = parseBooleanEnv(process.env.BLOCK_REPEATED_MESSAGES, true);
const REPEAT_MESSAGE_LIMIT = parseIntegerEnv('REPEAT_MESSAGE_LIMIT', 2, { min: 1 });
const REPEAT_MESSAGE_WINDOW = parseIntegerEnv('REPEAT_MESSAGE_WINDOW', 50, { min: 1 });
const REPEAT_MESSAGE_MIN_LENGTH = parseIntegerEnv('REPEAT_MESSAGE_MIN_LENGTH', 1, { min: 1 });

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

const TELEGRAM_HOST_LINK_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i;

const VIOLATION_TYPES = {
  forward: {
    type: 'forward',
    logLabel: 'Forwarded message',
    actionDescription: 'forwarding a message'
  },
  groupLink: {
    type: 'group_link',
    logLabel: 'Telegram invite link',
    actionDescription: 'linking to another Telegram group or channel'
  },
  botMessage: {
    type: 'bot_message',
    logLabel: 'Bot message',
    actionDescription: 'using a bot to post in the chat'
  },
  quoteExternal: {
    type: 'quote_external',
    logLabel: 'External quote',
    actionDescription: 'quoting a user from another chat'
  },
  contact: {
    type: 'contact',
    logLabel: 'Shared contact',
    actionDescription: 'sharing a contact'
  },
  repeatedMessage: {
    type: 'repeated_message',
    logLabel: 'Repeated message',
    actionDescription: 'sending the same message repeatedly'
  }
};

const TELEGRAM_SERVICE_PATHS = new Set([
  'addstickers',
  'addemoji',
  'addtheme',
  'addlist',
  'proxy',
  'socks',
  'bg',
  'blog',
  'status',
  'spambot',
  'stickers',
  'contest',
  'contestbot',
  'privacy',
  'apps',
  'faq',
  'gif',
  'iv',
  'jobs',
  'login',
  'verify',
  'tour',
  'setlanguage',
  'passport',
  'contact',
  'downloads',
  'wallet',
  'share',
  'k',
  'addk',
  'socks5',
  'bgm',
  'badges',
  'stars',
  'premiumbot',
  'giftcode',
  'walletbot',
  'stickershop'
]);
const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me']);
const TELEGRAM_INLINE_LINK_REGEX = /((?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/[^\s]+|tg:\/\/[^\s]+)/gi;
const TELEGRAM_USERNAME_PATTERN = /^[a-z0-9_]{5,}$/i;
const COMMUNITY_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);
const PUBLIC_CHAT_CACHE = new Map();
const PUBLIC_CHAT_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAT_INFO_CACHE = new Map();
const CHAT_INFO_TTL_MS = 3 * 60 * 1000;

const sanitizeLinkCandidate = (value = '') =>
  value.replace(/^[<[(]+/, '').replace(/[>.)\]]+$/, '');

const ensureAbsoluteUrl = (value = '') => {
  if (!value) {
    return '';
  }
  if (/^[a-z]+:\/\//i.test(value)) {
    return value;
  }
  return `https://${value}`;
};

const normalizeTelegramHost = (host = '') => host.replace(/^www\./i, '').toLowerCase();

const parseTelegramLink = (raw = '') => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = sanitizeLinkCandidate(raw.trim());
  if (!trimmed) {
    return null;
  }

  let url;

  try {
    const normalized = ensureAbsoluteUrl(trimmed);
    url = new URL(normalized);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'tg:') {
    return null;
  }

  if (protocol === 'tg:') {
    return {
      scheme: 'tg',
      host: url.host.toLowerCase(),
      searchParams: url.searchParams,
      raw: trimmed
    };
  }

  const normalizedHost = normalizeTelegramHost(url.host);

  if (!TELEGRAM_HOSTS.has(normalizedHost)) {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);

  return {
    scheme: 'http',
    host: normalizedHost,
    segments,
    searchParams: url.searchParams,
    raw: trimmed
  };
};

const extractInviteCodeFromSegments = (segments = []) => {
  if (!segments.length) {
    return null;
  }
  const [firstSegment, secondSegment] = segments;

  if (!firstSegment) {
    return null;
  }

  if (firstSegment.toLowerCase() === 'joinchat' && secondSegment) {
    return secondSegment;
  }

  if (firstSegment.startsWith('+')) {
    return firstSegment.slice(1);
  }

  if (firstSegment === '+' && secondSegment) {
    return secondSegment;
  }

  return null;
};

const extractInviteCodeFromUrl = (link = '') => {
  const parsed = parseTelegramLink(link);
  if (!parsed) {
    return null;
  }

  if (parsed.scheme === 'tg' && parsed.host === 'join') {
    const invite = parsed.searchParams.get('invite');
    return invite || null;
  }

  if (parsed.scheme === 'http') {
    return extractInviteCodeFromSegments(parsed.segments);
  }

  return null;
};

const buildChatInviteCodeSet = (chat = {}) => {
  const codes = new Set();
  const inviteLink = chat.invite_link;
  if (typeof inviteLink === 'string' && inviteLink.trim()) {
    const code = extractInviteCodeFromUrl(inviteLink);
    if (code) {
      codes.add(code.toLowerCase());
    }
  }
  return codes;
};

const deriveChatInternalId = (chat = {}) => {
  if (!chat || typeof chat.id !== 'number') {
    return null;
  }
  const chatIdStr = String(chat.id);
  if (chatIdStr.startsWith('-100')) {
    return chatIdStr.slice(4);
  }
  if (chatIdStr.startsWith('-')) {
    return chatIdStr.slice(1);
  }
  return chatIdStr;
};

const isSelfInviteCode = (code, chatInviteCodes) =>
  Boolean(code && chatInviteCodes.has(String(code).toLowerCase()));

const collectInlineKeyboardUrls = (replyMarkup = {}) => {
  const rows = replyMarkup.inline_keyboard;
  if (!Array.isArray(rows)) {
    return [];
  }

  const urls = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button) continue;
      if (typeof button.url === 'string') {
        urls.push(button.url);
      } else if (button.login_url && typeof button.login_url.url === 'string') {
        urls.push(button.login_url.url);
      }
    }
  }

  return urls;
};

const extractTelegramLinksFromText = (text = '') => {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = [];

  for (const match of text.matchAll(TELEGRAM_INLINE_LINK_REGEX)) {
    matches.push(match[0]);
  }

  return matches;
};

const extractMentionUsernames = (text = '', entities = []) => {
  if (!text || !Array.isArray(entities) || !entities.length) {
    return [];
  }

  return entities
    .map((entity) => {
      if (!entity || entity.type !== 'mention') {
        return null;
      }
      if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length)) {
        return null;
      }
      const mentionText = text.slice(entity.offset, entity.offset + entity.length);
      const username = mentionText.replace(/^@/, '').trim();
      if (!username || !TELEGRAM_USERNAME_PATTERN.test(username)) {
        return null;
      }
      return username.toLowerCase();
    })
    .filter(Boolean);
};

const looksLikeTelegramLink = (value = '') => {
  if (!value) {
    return false;
  }

  return TELEGRAM_HOST_LINK_REGEX.test(value) || value.toLowerCase().startsWith('tg://');
};

const collectTelegramLinksFromMessage = (rootMessage = {}) => {
  const contexts = [];

  const pushContext = (text, entities, origin) => {
    if (typeof text !== 'string' || !text.trim()) {
      return;
    }
    contexts.push({ text, entities, origin });
  };

  const queue = [];
  const visited = new Set();
  const enqueueMessage = (msg, origin) => {
    if (!msg) return;
    const key = msg;
    if (visited.has(key)) return;
    visited.add(key);
    queue.push({ msg, origin });
  };

  enqueueMessage(rootMessage, 'message');

  while (queue.length) {
    const { msg, origin } = queue.shift();
    if (!msg) continue;

    pushContext(msg.text, msg.entities, `${origin}:text`);
    pushContext(msg.caption, msg.caption_entities, `${origin}:caption`);

    const inlineButtonUrls = collectInlineKeyboardUrls(msg.reply_markup);
    inlineButtonUrls.forEach((url) => {
      if (looksLikeTelegramLink(url)) {
        contexts.push({ text: url, entities: null, origin: `${origin}:buttons`, isDirectUrl: true });
      }
    });

    if (msg.quote) {
      pushContext(msg.quote.text, msg.quote.entities, `${origin}:quote`);
    }

    if (msg.reply_to_message) {
      enqueueMessage(msg.reply_to_message, `${origin}:reply`);
    }
  }

  const discovered = new Map();
  const addCandidate = (value, source, origin) => {
    if (!value) return;
    const trimmed = String(value).trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = discovered.get(key);
    if (existing) {
      if (existing.source === 'mention' && source !== 'mention') {
        discovered.set(key, { value: trimmed, source, origin });
      }
      return;
    }
    discovered.set(key, { value: trimmed, source, origin });
  };

  for (const { text, entities, origin, isDirectUrl } of contexts) {
    if (isDirectUrl) {
      addCandidate(text, 'link', origin);
      continue;
    }

    const entityUrls = extractUrlsFromEntities(text, entities);
    for (const entityUrl of entityUrls) {
      if (looksLikeTelegramLink(entityUrl)) {
        addCandidate(entityUrl, 'link', origin);
      }
    }

    const inlineMatches = extractTelegramLinksFromText(text);
    inlineMatches.forEach((match) => addCandidate(match, 'link', origin));

    const mentionUsernames = extractMentionUsernames(text, entities);
    mentionUsernames.forEach((username) => {
      addCandidate(`https://t.me/${username}`, 'mention', origin);
    });
  }

  return Array.from(discovered.values());
};

const shouldIgnoreServicePath = (segment = '') =>
  TELEGRAM_SERVICE_PATHS.has(segment.toLowerCase());

const buildBotReferenceMetadata = (bot = {}, prefix) => {
  if (!bot || !bot.is_bot || !prefix) {
    return {};
  }
  const meta = {};
  if (typeof bot.id !== 'undefined') {
    meta[`${prefix}_id`] = bot.id;
  }
  if (typeof bot.username === 'string' && bot.username.trim()) {
    meta[`${prefix}_username`] = bot.username.toLowerCase();
  }
  return meta;
};

const fetchChatInfoWithCache = async (telegram, chatId) => {
  if (!telegram || !chatId) {
    return null;
  }

  const now = Date.now();
  const cached = CHAT_INFO_CACHE.get(chatId);
  if (cached && now - cached.timestamp < CHAT_INFO_TTL_MS) {
    return cached.data;
  }

  try {
    const chatInfo = await telegram.getChat(chatId);
    CHAT_INFO_CACHE.set(chatId, { data: chatInfo, timestamp: now });
    return chatInfo;
  } catch (err) {
    CHAT_INFO_CACHE.set(chatId, { data: null, timestamp: now, error: err.message });
    return null;
  }
};

const ensureChatMetadata = async (ctx) => {
  if (ctx.__chatMetadata) {
    return ctx.__chatMetadata;
  }

  const { chat, telegram, message } = ctx;
  const baseChat = chat || message?.chat || {};
  let enrichedChat = baseChat;

  if (baseChat?.id) {
    const fetched = await fetchChatInfoWithCache(telegram, baseChat.id);
    if (fetched) {
      enrichedChat = { ...baseChat, ...fetched };
    }
  }

  const metadata = {
    chat: enrichedChat,
    inviteCodes: buildChatInviteCodeSet(enrichedChat),
    username: enrichedChat?.username ? enrichedChat.username.toLowerCase() : null,
    internalId: deriveChatInternalId(enrichedChat)
  };

  ctx.__chatMetadata = metadata;
  return metadata;
};

const resolvePublicChatType = async (telegram, username) => {
  if (!telegram || !username) {
    return null;
  }

  const normalized = username.toLowerCase();
  const cached = PUBLIC_CHAT_CACHE.get(normalized);
  const now = Date.now();
  if (cached && now - cached.timestamp < PUBLIC_CHAT_CACHE_TTL_MS) {
    return cached.type;
  }

  try {
    const chatInfo = await telegram.getChat(`@${normalized}`);
    const type = chatInfo?.type || null;
    PUBLIC_CHAT_CACHE.set(normalized, { type, timestamp: now });
    return type;
  } catch (err) {
    PUBLIC_CHAT_CACHE.set(normalized, { type: null, timestamp: now, error: err.message });
    return null;
  }
};

const evaluatePublicTargetRelation = async (telegram, username, chatUsername) => {
  if (!username) {
    return 'unknown';
  }
  const normalizedUsername = username.toLowerCase();
  if (chatUsername && normalizedUsername === chatUsername.toLowerCase()) {
    return 'self';
  }

  const targetType = await resolvePublicChatType(telegram, normalizedUsername);
  if (!targetType) {
    return 'unknown';
  }

  return COMMUNITY_CHAT_TYPES.has(targetType) ? 'community' : 'other';
};

const classifyParsedLink = async (parsedLink, ctx, source = 'link') => {
  const { telegram } = ctx;
  const metadata = await ensureChatMetadata(ctx);
  const chatInviteCodes = metadata.inviteCodes;
  const chatUsername = metadata.username;
  const chatInternalId = metadata.internalId;
  const hasInviteKnowledge = chatInviteCodes.size > 0;

  if (parsedLink.scheme === 'tg') {
    const host = parsedLink.host;
    if (host === 'join') {
      const inviteCode = parsedLink.searchParams.get('invite');
      if (inviteCode && !isSelfInviteCode(inviteCode, chatInviteCodes)) {
        return {
          link: parsedLink.raw,
          kind: 'invite_schema',
          target: { invite_code: inviteCode }
        };
      }
      return null;
    }

    if (host === 'resolve') {
      const usernameParam = parsedLink.searchParams.get('domain');
      if (!usernameParam) {
        return null;
      }

      const relation = await evaluatePublicTargetRelation(telegram, usernameParam, chatUsername);
      if (relation === 'community') {
        return {
          link: parsedLink.raw,
          kind: 'public_username',
          target: { username: usernameParam.toLowerCase() }
        };
      }
      if (relation === 'unknown' && source !== 'mention') {
        return {
          link: parsedLink.raw,
          kind: 'public_username',
          target: { username: usernameParam.toLowerCase() },
          unconfirmed: true
        };
      }
      return null;
    }

    if (host === 'privatepost') {
      const peer = parsedLink.searchParams.get('channel') || parsedLink.searchParams.get('peer');
      if (!peer) {
        return null;
      }

      if (chatUsername && peer.toLowerCase() === chatUsername) {
        return null;
      }

      const relation = await evaluatePublicTargetRelation(telegram, peer, chatUsername);
      if (relation === 'community') {
        return {
          link: parsedLink.raw,
          kind: 'private_post',
          target: { username: peer.toLowerCase() }
        };
      }
      if (relation === 'unknown' && source !== 'mention') {
        return {
          link: parsedLink.raw,
          kind: 'private_post',
          target: { username: peer.toLowerCase() },
          unconfirmed: true
        };
      }
      return null;
    }

    return null;
  }

  const segments = parsedLink.segments;
  if (!segments.length) {
    return null;
  }

  const [firstSegmentRaw, secondSegmentRaw] = segments;
  const firstSegment = firstSegmentRaw.toLowerCase();

  if (shouldIgnoreServicePath(firstSegment)) {
    return null;
  }

  const inviteCode = extractInviteCodeFromSegments(segments);
  if (inviteCode) {
    if (!hasInviteKnowledge) {
      ctx.__missingInviteCodes = true;
      noteMissingInvitePermissions(ctx, metadata.chat);
      return null;
    }
    if (!isSelfInviteCode(inviteCode, chatInviteCodes)) {
      return {
        link: parsedLink.raw,
        kind: 'invite_link',
        target: { invite_code: inviteCode }
      };
    }
    return null;
  }

  if (firstSegment === 's' && secondSegmentRaw) {
    const relation = await evaluatePublicTargetRelation(telegram, secondSegmentRaw, chatUsername);
    if (relation === 'community') {
      return {
        link: parsedLink.raw,
        kind: 'public_preview_link',
        target: { username: secondSegmentRaw.toLowerCase() }
      };
    }
    if (relation === 'unknown' && source !== 'mention') {
      return {
        link: parsedLink.raw,
        kind: 'public_preview_link',
        target: { username: secondSegmentRaw.toLowerCase() },
        unconfirmed: true
      };
    }
    return null;
  }

  if (firstSegment === 'c' && secondSegmentRaw) {
    const targetChatId = secondSegmentRaw;
    if (chatInternalId && targetChatId === chatInternalId) {
      return null;
    }
    return {
      link: parsedLink.raw,
      kind: 'private_chat_post',
      target: { internal_id: targetChatId }
    };
  }

  if (!firstSegmentRaw) {
    return null;
  }

  const relation = await evaluatePublicTargetRelation(telegram, firstSegmentRaw, chatUsername);
  if (relation === 'community') {
    return {
      link: parsedLink.raw,
      kind: 'public_username',
      target: { username: firstSegmentRaw.toLowerCase() }
    };
  }
  if (relation === 'unknown' && source !== 'mention') {
    return {
      link: parsedLink.raw,
      kind: 'public_username',
      target: { username: firstSegmentRaw.toLowerCase() },
      unconfirmed: true
    };
  }

  return null;
};

const findExternalGroupLink = async (ctx) => {
  const candidates = collectTelegramLinksFromMessage(ctx.message);
  for (const candidate of candidates) {
    const parsed = parseTelegramLink(candidate.value);
    if (!parsed) {
      continue;
    }
    const classification = await classifyParsedLink(parsed, ctx, candidate.source);
    if (classification) {
      return {
        ...classification,
        origin: candidate.origin
      };
    }
  }
  return null;
};

const detectQuotedInlineBotDetails = (message = {}) => {
  if (!message) {
    return null;
  }

  const replied = message.reply_to_message;
  if (replied?.via_bot && replied.via_bot.is_bot) {
    return {
      reason: 'quoted_via_bot',
      ...buildBotReferenceMetadata(replied.via_bot, 'quoted_via_bot'),
      ...(replied.message_id ? { quoted_message_id: replied.message_id } : {})
    };
  }

  const quote = message.quote;
  if (quote?.via_bot && quote.via_bot.is_bot) {
    return {
      reason: 'quoted_via_bot',
      ...buildBotReferenceMetadata(quote.via_bot, 'quoted_via_bot')
    };
  }

  return null;
};

const isExternalChatReference = (ref = {}, chat = {}) => {
  if (!ref || !chat?.id) {
    return null;
  }
  const target = ref.chat && typeof ref.chat === 'object' ? ref.chat : ref;
  if (target.id && target.id !== chat.id) {
    return {
      chat_id: target.id,
      title: target.title || target.username || ''
    };
  }
  return null;
};

const isExternalQuote = (message = {}, chat = {}) => {
  if (!message) {
    return null;
  }

  const quote = message.quote;
  const quoteReference = isExternalChatReference(quote, chat);
  if (quoteReference) {
    return quoteReference;
  }

  const replied = message.reply_to_message;
  const replyReference = isExternalChatReference(replied, chat);
  if (replyReference) {
    return replyReference;
  }

  const externalReply = message.external_reply;
  if (externalReply) {
    const replyChatReference = isExternalChatReference(externalReply, chat);
    if (replyChatReference) {
      return replyChatReference;
    }
    const originReference = isExternalChatReference(externalReply.origin, chat);
    if (originReference) {
      return originReference;
    }
  }

  return null;
};

const detectBotMessageDetails = (message = {}) => {
  if (!message) {
    return null;
  }

  if (message.via_bot && message.via_bot.is_bot) {
    return {
      reason: 'via_bot',
      ...buildBotReferenceMetadata(message.via_bot, 'via_bot')
    };
  }

  if (message.from?.is_bot) {
    return {
      reason: 'bot_sender'
    };
  }

  const quotedDetails = detectQuotedInlineBotDetails(message);
  if (quotedDetails) {
    return quotedDetails;
  }

  return null;
};

const detectContactDetails = (message = {}) => {
  if (!BLOCK_CONTACTS || !message.contact) {
    return null;
  }

  const contactUserId = message.contact.user_id;
  return {
    reason: 'shared_contact',
    ...(contactUserId !== undefined ? { contact_user_id: contactUserId } : {})
  };
};

const RECENT_MESSAGES_BY_CHAT = new Map();
const REPEAT_MEDIA_FIELDS = ['photo', 'video', 'document', 'animation', 'audio', 'voice', 'video_note', 'sticker'];

const normalizeRepeatText = (value = '') => value.replace(/\s+/g, ' ').trim().toLowerCase();

const extractMediaUniqueId = (message = {}) => {
  for (const field of REPEAT_MEDIA_FIELDS) {
    const media = message[field];
    if (!media) {
      continue;
    }
    if (Array.isArray(media)) {
      const largest = media[media.length - 1];
      return largest?.file_unique_id ? `${field}:${largest.file_unique_id}` : null;
    }
    return media.file_unique_id ? `${field}:${media.file_unique_id}` : null;
  }
  return null;
};

const buildMessageFingerprint = (message = {}) => {
  const text = normalizeRepeatText(message.text ?? message.caption ?? '');
  const mediaId = extractMediaUniqueId(message);
  if (!text && !mediaId) {
    return null;
  }
  if (text && text.length < REPEAT_MESSAGE_MIN_LENGTH && !mediaId) {
    return null;
  }
  return [text, mediaId ?? ''].join('\u0000');
};

const getRecentMessages = (chatId) => {
  let entries = RECENT_MESSAGES_BY_CHAT.get(chatId);
  if (!entries) {
    entries = [];
    RECENT_MESSAGES_BY_CHAT.set(chatId, entries);
  }
  return entries;
};

const recordRecentMessage = (chat = {}, message = {}) => {
  if (!BLOCK_REPEATED_MESSAGES || chat.id === undefined) {
    return;
  }
  const entries = getRecentMessages(chat.id);
  entries.push({
    senderId: message.from?.id ?? null,
    fingerprint: buildMessageFingerprint(message)
  });
  if (entries.length > REPEAT_MESSAGE_WINDOW) {
    entries.splice(0, entries.length - REPEAT_MESSAGE_WINDOW);
  }
};

const detectRepeatedMessageDetails = (chat = {}, message = {}) => {
  if (!BLOCK_REPEATED_MESSAGES || message.is_automatic_forward || chat.id === undefined) {
    return null;
  }
  const senderId = message.from?.id;
  if (senderId === undefined) {
    return null;
  }
  const fingerprint = buildMessageFingerprint(message);
  if (!fingerprint) {
    return null;
  }
  const entries = RECENT_MESSAGES_BY_CHAT.get(chat.id) ?? [];
  const priorMatches = entries.filter(
    (entry) => entry.senderId === senderId && entry.fingerprint === fingerprint
  ).length;
  if (priorMatches < REPEAT_MESSAGE_LIMIT) {
    return null;
  }
  return {
    reason: 'repeated_message',
    repeat_count: priorMatches + 1,
    repeat_window: REPEAT_MESSAGE_WINDOW
  };
};

const detectViolation = async (ctx) => {
  const { message, chat } = ctx;
  if (!message) {
    return null;
  }

  if (isForwardedMessage(message)) {
    return {
      ...VIOLATION_TYPES.forward,
      details: { reason: 'forwarded_message' }
    };
  }

  const contactDetails = detectContactDetails(message);
  if (contactDetails) {
    return {
      ...VIOLATION_TYPES.contact,
      details: contactDetails
    };
  }

  const linkDetails = await findExternalGroupLink(ctx);
  if (linkDetails) {
    return {
      ...VIOLATION_TYPES.groupLink,
      details: linkDetails
    };
  }

  const botDetails = detectBotMessageDetails(message);
  if (botDetails) {
    return {
      ...VIOLATION_TYPES.botMessage,
      details: botDetails
    };
  }

  const externalQuote = isExternalQuote(message, chat);
  if (externalQuote) {
    return {
      ...VIOLATION_TYPES.quoteExternal,
      details: {
        reason: 'external_quote',
        quoted_chat_id: externalQuote.chat_id,
        quoted_chat_title: normalizeForLog(externalQuote.title)
      }
    };
  }

  const repeatedDetails = detectRepeatedMessageDetails(chat, message);
  if (repeatedDetails) {
    return {
      ...VIOLATION_TYPES.repeatedMessage,
      details: repeatedDetails
    };
  }

  return null;
};

const isGroupChat = (chat = {}) => GROUP_TYPES.has(chat.type);

const hasForwardOrigin = (message = {}) => Boolean(message.forward_origin);

const hasLegacyForwardMetadata = (message = {}) =>
  LEGACY_FORWARD_FIELDS.some((field) => Object.hasOwn(message, field) && Boolean(message[field]));

const isForwardedMessage = (message = {}) =>
  hasForwardOrigin(message) || hasLegacyForwardMetadata(message);

const extractUrlsFromEntities = (text = '', entities = []) => {
  if (!text || !Array.isArray(entities) || !entities.length) {
    return [];
  }

  return entities
    .map((entity) => {
      if (!entity) return null;
      if (entity.type === 'text_link' && entity.url) {
        return entity.url;
      }
      if (entity.type === 'url' && Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
        return text.slice(entity.offset, entity.offset + entity.length);
      }
      return null;
    })
    .filter(Boolean);
};

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

const CHATS_MISSING_INVITE_PERMS = new Set();
const noteMissingInvitePermissions = (ctx, chat = {}) => {
  const chatId = chat?.id ?? ctx.chat?.id ?? ctx.message?.chat?.id;
  if (!chatId || CHATS_MISSING_INVITE_PERMS.has(chatId)) {
    return;
  }
  CHATS_MISSING_INVITE_PERMS.add(chatId);
  logConsole('warn', 'Cannot confirm private invite links for this chat. Grant the bot permission to create/manage invites to enforce private links.', {
    chat_id: chatId,
    chat_title: normalizeForLog(chat?.title || chat?.username || '')
  });
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

  return null;
};

const logAction = async (ctx, text, options = {}) => {
  if (!CHAT_NOTIFICATIONS_ENABLED) {
    return;
  }
  const threadId = ctx.message?.message_thread_id;
  const chatId = ctx.chat?.id ?? ctx.message?.chat?.id;
  if (!chatId) {
    return;
  }

  try {
    await ctx.telegram.sendMessage(chatId, text, {
      disable_notification: true,
      ...(typeof threadId === 'number' ? { message_thread_id: threadId } : {}),
      ...options
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

  const violation = await detectViolation(ctx);
  recordRecentMessage(chat, message);

  if (!violation) {
    return next();
  }

  const offender = message.from;
const contextDetails = {
  ...describeContext(chat, offender, message),
  violation: violation.type,
  ...(violation.details?.kind ? { link_kind: violation.details.kind } : {}),
  ...(violation.details?.link ? { link: violation.details.link } : {}),
  ...(violation.details?.reason ? { reason: violation.details.reason } : {}),
  ...(violation.details?.origin ? { link_origin: violation.details.origin } : {}),
  ...(violation.details?.unconfirmed ? { link_unconfirmed: true } : {}),
  ...(violation.details?.target?.username
    ? { target_username: violation.details.target.username }
      : {}),
    ...(violation.details?.target?.invite_code
      ? { invite_code: violation.details.target.invite_code }
      : {}),
    ...(violation.details?.target?.internal_id
      ? { target_internal_id: violation.details.target.internal_id }
      : {}),
    ...(violation.details?.via_bot_username ? { via_bot_username: violation.details.via_bot_username } : {}),
    ...(violation.details && Object.hasOwn(violation.details, 'via_bot_id')
      ? { via_bot_id: violation.details.via_bot_id }
      : {}),
    ...(violation.details?.quoted_via_bot_username
      ? { quoted_via_bot_username: violation.details.quoted_via_bot_username }
      : {}),
    ...(violation.details && Object.hasOwn(violation.details, 'quoted_via_bot_id')
      ? { quoted_via_bot_id: violation.details.quoted_via_bot_id }
      : {}),
    ...(violation.details && Object.hasOwn(violation.details, 'quoted_message_id')
      ? { quoted_message_id: violation.details.quoted_message_id }
      : {}),
    ...(violation.details?.quoted_chat_id ? { quoted_chat_id: violation.details.quoted_chat_id } : {}),
    ...(violation.details?.quoted_chat_title
      ? { quoted_chat_title: violation.details.quoted_chat_title }
      : {}),
    ...(violation.details && Object.hasOwn(violation.details, 'contact_user_id')
      ? { contact_user_id: violation.details.contact_user_id }
      : {}),
    ...(violation.details?.repeat_count ? { repeat_count: violation.details.repeat_count } : {}),
    ...(violation.details?.repeat_window ? { repeat_window: violation.details.repeat_window } : {})
};

  if (violation.type === 'forward' && message.is_automatic_forward) {
    logConsole('info', 'Ignored automatic forward from linked chat', contextDetails);
    return next();
  }

  if (!offender) {
    logConsole('warn', 'Detected violation missing sender metadata', contextDetails);
    return next();
  }

  let memberInfo;

  try {
    memberInfo = await ctx.telegram.getChatMember(chat.id, offender.id);
  } catch (err) {
    await logAction(
      ctx,
      `Failed to inspect ${buildUserLabel(offender)} before acting on a violation. Error: ${err.message}`
    );
    logConsole('warn', 'Failed to inspect offender before enforcement', {
      ...contextDetails,
      error: err.message
    });
  }

  if (memberInfo && PROTECTED_STATUSES.has(memberInfo.status)) {
    const adminContext = {
      ...contextDetails,
      status: memberInfo.status
    };
    logConsole('info', 'Ignoring violation from protected member', adminContext);
    return next();
  }

  const violationLabelLower = violation.logLabel.toLowerCase();

  logConsole('info', `${violation.logLabel} detected`, contextDetails);

  if (TEST_MODE) {
    logConsole('info', `TEST_MODE: would delete ${violationLabelLower}`, contextDetails);
  } else {
    try {
      await ctx.deleteMessage(message.message_id);
      logConsole('info', `${violation.logLabel} deleted`, contextDetails);
    } catch (err) {
      await logAction(
        ctx,
        `${violation.logLabel} detected but could not delete it. Error: ${err.message}`
      );
      logConsole('warn', `Failed to delete ${violationLabelLower}`, {
        ...contextDetails,
        error: err.message
      });
    }
  }

  const skipReason = getBanSkipReason(message);
  if (skipReason) {
    logConsole('info', `Skipping ban for ${violationLabelLower}`, {
      ...contextDetails,
      reason: skipReason
    });
    return next();
  }

  if (TEST_MODE) {
    logConsole('info', `TEST_MODE: would ban user for ${violation.actionDescription}`, contextDetails);
    return;
  }

  try {
    await ctx.banChatMember(offender.id, { revoke_messages: true });

    await logAction(
      ctx,
      `🚫 ${buildUserLabel(offender)} was banned for ${violation.actionDescription}.`
    );
    logConsole('info', `User banned for ${violation.actionDescription}`, contextDetails);
    await recordBan({ chat, offender, message });
  } catch (err) {
    await logAction(
      ctx,
      `Tried to ban ${buildUserLabel(offender)} for ${violation.actionDescription} but failed. Error: ${err.message}`
    );
    logConsole('error', `Failed to ban user for ${violation.actionDescription}`, {
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
  if (!BLOCK_CONTACTS) {
    console.log('Contact sharing enforcement is disabled (BLOCK_CONTACTS=false).');
  }
  if (BLOCK_REPEATED_MESSAGES) {
    console.log(
      `Repeated message enforcement: more than ${REPEAT_MESSAGE_LIMIT} identical sends within the last ${REPEAT_MESSAGE_WINDOW} messages (min length ${REPEAT_MESSAGE_MIN_LENGTH}).`
    );
  } else {
    console.log('Repeated message enforcement is disabled (BLOCK_REPEATED_MESSAGES=false).');
  }
});

const gracefulShutdown = (signal) => {
  process.once(signal, () => {
    bot.stop(`Received ${signal}`);
    process.exit(0);
  });
};

['SIGINT', 'SIGTERM'].forEach(gracefulShutdown);
