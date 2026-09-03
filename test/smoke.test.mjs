// Smoke test: stubs the Telegram API and drives the real update handler through spam scenarios.
// Run with `pnpm test`; set TEST_MODE=true to check that dry-run mode performs no actions.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telegraf, Telegram } from 'telegraf';

const BAN_LOG = join(mkdtempSync(join(tmpdir(), 'noforwardingbot-')), 'banned.log');
process.env.BOT_TOKEN = '123:test';
process.env.BAN_LOG_PATH = BAN_LOG;
process.env.CHAT_NOTIFICATIONS_ENABLED = 'true';
const TEST_MODE = process.env.TEST_MODE === 'true';

const calls = [];
const deleted = new Set();
const failBanFor = new Set();
const apiError = (msg) => { const e = new Error(msg); e.description = msg; return e; };

Telegram.prototype.callApi = async function (method, payload = {}) {
  calls.push({ method, payload });
  switch (method) {
    case 'getMe': return { id: 1, is_bot: true, username: 'testbot', first_name: 'Test' };
    case 'deleteWebhook': return true;
    case 'getChat':
      if (typeof payload.chat_id === 'string') {
        return payload.chat_id === '@othergroup'
          ? { id: -100999, type: 'supergroup', title: 'Other' }
          : { id: 5, type: 'private', first_name: 'Someone' };
      }
      return { id: payload.chat_id, type: 'supergroup', title: 'Test Group', invite_link: 'https://t.me/+selfcode', linked_chat_id: -100777 };
    case 'getChatMember':
      return { status: payload.user_id === 999 ? 'administrator' : 'member', user: { id: payload.user_id } };
    case 'deleteMessage':
      if (deleted.has(payload.message_id)) throw apiError('Bad Request: message to delete not found');
      deleted.add(payload.message_id);
      return true;
    case 'deleteMessages':
      for (const id of payload.message_ids) deleted.add(id);
      return true;
    case 'banChatMember':
      if (failBanFor.has(payload.user_id)) throw apiError('Bad Request: not enough rights to restrict/unrestrict chat member');
      return true;
    case 'banChatSenderChat': return true;
    case 'sendMessage': return { message_id: 999999 };
    default: return true;
  }
};

let bot;
Telegraf.prototype.launch = async function (_cfg, onLaunch) {
  bot = this;
  this.botInfo = { id: 1, is_bot: true, username: 'testbot', first_name: 'Test' };
  onLaunch?.();
};

const logs = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
}

await import('../src/index.js');
assert.ok(bot, 'launch stub should capture the bot');
assert.ok(logs.some((l) => l.text.includes('now watching')), 'startup message printed');

const chat = { id: -1001234, type: 'supergroup', title: 'Test Group' };
let updateId = 1;
let nextId = 1000;
const user = (id, name) => ({ id, is_bot: false, first_name: name });
const msg = (from, text, extra = {}) => ({ message_id: nextId++, date: 1, chat, from, ...(text !== undefined ? { text } : {}), ...extra });
const deliver = (...messages) => Promise.all(messages.map((m) => bot.handleUpdate({ update_id: updateId++, message: m })));
const deliverEdit = (m) => bot.handleUpdate({ update_id: updateId++, edited_message: m });
const bansFor = (userId) => calls.filter((c) => c.method === 'banChatMember' && c.payload.user_id === userId);
const banNotices = () => calls.filter((c) => c.method === 'sendMessage' && c.payload.text.includes('was banned')).map((c) => c.payload.text);
const ids = (...messages) => messages.map((m) => m.message_id);
const allDeleted = (...messages) => ids(...messages).every((id) => deleted.has(id));
const noneDeleted = (...messages) => ids(...messages).every((id) => !deleted.has(id));
const results = [];
const scenario = (name, fn) => fn().then(() => results.push(`PASS ${name}`), (err) => results.push(`FAIL ${name}: ${err.message}`));

if (TEST_MODE) {
  await scenario('TEST_MODE performs no deletes or bans', async () => {
    const s = user(43, 'Burst');
    await deliver(...Array.from({ length: 5 }, () => msg(s, 'Same spam text')));
    assert.equal(calls.filter((c) => ['deleteMessage', 'deleteMessages', 'banChatMember'].includes(c.method)).length, 0);
    assert.ok(logs.some((l) => l.text.includes('TEST_MODE: would ban user')));
    assert.ok(logs.some((l) => l.text.includes('would delete earlier messages from offender')));
  });
  console.info = console.log;
  process.stdout.write(results.join('\n') + '\n');
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}

await scenario('A: copies evicted from the window are still deleted, plus other tracked messages', async () => {
  const s = user(42, 'Spammer');
  const a1 = msg(s, 'Buy crypto now');
  const hello = msg(s, 'hello everyone');
  await deliver(a1);
  await deliver(hello);
  for (let i = 0; i < 30; i++) await deliver(msg(user(100 + i, 'U'), `filler ${i}`));
  const a2 = msg(s, 'buy  CRYPTO now');
  const a3 = msg(s, 'Buy crypto now');
  const a4 = msg(s, 'Buy crypto now ');
  await deliver(a2);
  await deliver(a3);
  assert.equal(bansFor(42).length, 0, 'no ban before the limit is exceeded');
  await deliver(a4);
  assert.equal(bansFor(42).length, 1, 'exactly one ban');
  const ban = bansFor(42)[0].payload;
  assert.equal(ban.until_date, undefined);
  assert.equal(ban.revoke_messages, true);
  assert.ok(allDeleted(a1, a2, a3, a4, hello), `all spammer messages deleted; deleted=${[...deleted]}`);
  assert.ok(banNotices().at(-1).includes('4 earlier messages removed'), banNotices().at(-1));
});

await scenario('B: burst of 5 copies in one batch bans once and deletes all without failure noise', async () => {
  const s = user(43, 'Burst');
  const copies = Array.from({ length: 5 }, () => msg(s, 'Same spam text'));
  const before = logs.length;
  await deliver(...copies);
  assert.equal(bansFor(43).length, 1, 'one ban');
  assert.ok(allDeleted(...copies));
  assert.equal(banNotices().filter((t) => t.includes('Burst')).length, 1, 'one ban notice');
  const noise = logs.slice(before).filter((l) => l.level === 'warn' || l.level === 'error');
  assert.deepEqual(noise, [], `no warnings: ${JSON.stringify(noise)}`);
});

await scenario('C: administrators are never banned or deleted', async () => {
  const admin = user(999, 'Admin');
  const copies = Array.from({ length: 3 }, () => msg(admin, 'Reminder: rules apply'));
  for (const c of copies) await deliver(c);
  assert.equal(bansFor(999).length, 0);
  assert.ok(noneDeleted(...copies));
});

await scenario('D: posting as a channel bans the channel, not the shared service account', async () => {
  const from = { id: 136817688, is_bot: true, first_name: 'Channel', username: 'Channel_Bot' };
  const sender_chat = { id: -100555, type: 'channel', title: 'Spam Channel' };
  const copies = Array.from({ length: 3 }, () => msg(from, 'Promo promo', { sender_chat }));
  for (const c of copies) await deliver(c);
  assert.equal(bansFor(136817688).length, 0, 'service account not banned');
  const chatBans = calls.filter((c) => c.method === 'banChatSenderChat');
  assert.equal(chatBans.length, 1);
  assert.equal(chatBans[0].payload.sender_chat_id, -100555);
  assert.ok(allDeleted(...copies));
  assert.ok(banNotices().at(-1).includes('Spam Channel'), banNotices().at(-1));
});

await scenario('E: anonymous admin forwards are ignored', async () => {
  const from = { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' };
  const m = msg(from, 'forwarded thing', { sender_chat: { id: chat.id, type: 'supergroup', title: chat.title }, forward_origin: { type: 'user', date: 1, sender_user: user(7, 'X') } });
  const before = calls.length;
  await deliver(m);
  assert.ok(noneDeleted(m));
  assert.equal(calls.slice(before).filter((c) => c.method.startsWith('ban')).length, 0);
  assert.ok(logs.some((l) => l.text.includes('anonymous_admin')));
});

await scenario('F: editing a link into an existing message is enforced', async () => {
  const s = user(44, 'Editor');
  const m = msg(s, 'hi all');
  await deliver(m);
  assert.ok(noneDeleted(m));
  await deliverEdit({ ...m, text: 'join us https://t.me/joinchat/othercode', edit_date: 2 });
  assert.equal(bansFor(44).length, 1);
  assert.ok(allDeleted(m));
  assert.ok(logs.some((l) => l.text.includes('"edited":true')));
});

await scenario('G: messages arriving right after a ban are removed on sight', async () => {
  const s = user(42, 'Spammer');
  const late = msg(s, 'totally different text');
  await deliver(late);
  assert.ok(allDeleted(late));
  assert.equal(bansFor(42).length, 1, 'no second ban');
  assert.ok(logs.some((l) => l.text.includes('recently banned sender')));
});

await scenario('H: when the ban fails only the identical copies are removed', async () => {
  failBanFor.add(77);
  const s = user(77, 'Unbannable');
  const h1 = msg(s, 'Repeat me');
  const other = msg(s, 'legit remark');
  const h2 = msg(s, 'repeat me');
  const h3 = msg(s, 'REPEAT ME');
  for (const m of [h1, other, h2, h3]) await deliver(m);
  assert.equal(bansFor(77).length, 1, 'ban attempted');
  assert.ok(allDeleted(h1, h2, h3));
  assert.ok(noneDeleted(other));
});

await scenario('I: unicode look-alikes and invisible characters match', async () => {
  const s = user(45, 'Unicode');
  const bold = String.fromCodePoint(0x1d401, 0x1d42e, 0x1d432) + String.fromCharCode(0x200b) + ' ' + String.fromCodePoint(0x1d427, 0x1d428, 0x1d430);
  const copies = [msg(s, 'Buy now'), msg(s, 'BUY   now'), msg(s, bold)];
  for (const m of copies) await deliver(m);
  assert.equal(bansFor(45).length, 1);
  assert.ok(allDeleted(...copies));
});

await scenario('J: ban log includes violation type', async () => {
  const lines = readFileSync(BAN_LOG, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 4, `expected several ban lines, got ${lines.length}`);
  assert.ok(lines.every((l) => /\tviolation=\w+$/.test(l)), lines[0]);
  assert.ok(lines.some((l) => l.includes('violation=repeated_message')));
  assert.ok(lines.some((l) => l.includes('violation=group_link')));
});

const noise = logs.filter((l) => l.level === 'warn' || l.level === 'error');
process.stdout.write(results.join('\n') + '\n');
process.stdout.write(`warn/error log lines: ${noise.length}\n` + noise.map((l) => `  [${l.level}] ${l.text.slice(0, 200)}`).join('\n') + '\n');
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
