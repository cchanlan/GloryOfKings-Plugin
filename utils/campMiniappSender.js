import zlib from 'node:zlib';
import { normalizeId } from './adapter.js';
import { isConfirmedReceipt } from './privateMsg.js';
import { CAMP_MINIAPP_URL, sendMiniappWithDiagnostics, withDeadline } from './campMiniappDiag.js';

const versionCache = new WeakMap();
const ONEBOT = /onebot|napcat|snowluma|llonebot|lagrange|shamrock/i;
function botFor(event) {
  if (event?.bot) return event.bot;
  const host = globalThis.Bot;
  if (event?.self_id && host?.[event.self_id]) return host[event.self_id];
  if (host && !Array.isArray(host.uin) && String(host.uin) === String(event?.self_id)) return host;
  return null;
}
function adapterName(event, bot) {
  return String((typeof bot?.adapter === 'string' ? bot.adapter : bot?.adapter?.name) || event?.adapter_name || '');
}
function capabilities(event) {
  const bot = botFor(event);
  return { sendApi: typeof bot?.sendApi === 'function', nativeICQQ: typeof bot?.sendUni === 'function', json: typeof globalThis.segment?.json === 'function', raw: typeof globalThis.segment?.raw === 'function' };
}
function numericId(value) { return /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function route(event, cardJson) {
  const bot = botFor(event);
  const name = adapterName(event, bot);
  if (ONEBOT.test(name)) {
    const target = event.isGroup ? event.group_id : event.user_id;
    if (!numericId(target)) return { name: 'onebot', dataShape: 'json/data.data', reason: 'invalid_numeric_contact' };
    if (typeof bot?.sendApi === 'function') {
      const params = { message_type: event.isGroup ? 'group' : 'private', message: [{ type: 'json', data: { data: cardJson } }] };
      params[event.isGroup ? 'group_id' : 'user_id'] = normalizeId(target);
      return { name: 'onebot_api', dataShape: 'json/data.data', send: () => bot.sendApi('send_msg', params) };
    }
    if (typeof globalThis.segment?.raw === 'function') return {
      name: 'onebot_raw', dataShape: 'raw/json/data.data',
      send: () => event.reply(globalThis.segment.raw({ type: 'json', data: { data: cardJson } }), false)
    };
    return { name: 'onebot', dataShape: 'json/data.data', reason: 'missing_onebot_api_or_raw' };
  }
  if (/icqq|oicq/i.test(name) || typeof bot?.sendUni === 'function') {
    const element = typeof globalThis.segment?.json === 'function' ? globalThis.segment.json(cardJson) : { type: 'json', data: cardJson };
    return { name: 'icqq_json', dataShape: 'json/data', send: () => event.reply(element, false) };
  }
  return { name: 'unsupported', dataShape: 'unknown', reason: 'unknown_or_unsupported_adapter' };
}
async function version(event) {
  const bot = botFor(event);
  if (!bot) return { app: 'unknown', version: 'unknown' };
  if (!ONEBOT.test(adapterName(event, bot)) || typeof bot.sendApi !== 'function') {
    return { app: adapterName(event, bot) || 'ICQQ', version: typeof bot.version === 'string' ? bot.version : 'unknown', clientVersion: String(bot.apk?.ver || bot.apk?.version || 'unknown') };
  }
  const cached = versionCache.get(bot);
  if (cached && Date.now() - cached.time < 600000) return { ...(await cached.promise), source: 'cache', ageMs: Date.now() - cached.time };
  const promise = withDeadline(Promise.resolve().then(() => bot.sendApi('get_version_info', {}))).then(result => {
    const data = result?.data || result;
    return { app: String(data?.app_name || data?.impl || 'unknown'), version: String(data?.app_version || data?.version || 'unknown'), source: 'get_version_info', ageMs: 0 };
  });
  versionCache.set(bot, { time: Date.now(), promise });
  return promise;
}
async function verify(event, messageId, backend) {
  const packet = event?.Packet || globalThis.Packet;
  const bot = botFor(event);
  if (!/napcat/i.test(backend || '') || !event.isGroup || !numericId(event.group_id) ||
      typeof bot?.sendApi !== 'function' || typeof packet?.getMsg !== 'function') {
    return { status: 'unavailable', reason: 'no_supported_server_packet_capability' };
  }
  return withDeadline((async () => {
    // get_msg is used only for the sequence; its local JSON cache is NOT a server-rendering check.
    const fetched = await bot.sendApi('get_msg', { message_id: numericId(messageId) ? Number(messageId) : messageId });
    const message = fetched?.data || fetched;
    if (!message?.real_seq) return { status: 'unavailable', reason: 'missing_server_sequence' };
    const response = await packet.getMsg({ bot, group_id: Number(event.group_id), isGroup: true }, message.real_seq, true);
    const rows = response?.['3']?.['6'];
    const messages = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    const elements = messages.flatMap(row => row?.['3']?.['1']?.['2'] || []);
    const elementTypes = [...new Set(elements.flatMap(element => Object.keys(element)))];
    for (const element of elements) {
      const bytes = element?.['51']?.['1'];
      if (!Buffer.isBuffer(bytes)) continue;
      const json = bytes[0] === 1 ? zlib.inflateSync(bytes.subarray(1)).toString() : bytes.subarray(1).toString();
      const card = JSON.parse(json);
      if (card.app === 'com.tencent.miniapp.lua' && card.meta?.miniapp?.jumpUrl === CAMP_MINIAPP_URL) return { status: 'card_preserved', elementTypes };
    }
    const texts = elements.map(element => element?.['1']?.['1']).filter(value => typeof value === 'string');
    if (texts.some(value => /发送者版本过低|无法展示内容/.test(value))) return { status: 'downgraded', elementTypes, reason: 'server_replaced_card_with_version_warning' };
    return { status: 'unavailable', elementTypes, reason: 'server_card_not_identified' };
  })());
}
export function sendCampMiniapp(event) {
  return sendMiniappWithDiagnostics(event, {
    framework: 'Yunzai', logger: () => globalThis.logger,
    describe: e => ({ adapter: adapterName(e, botFor(e)), botId: e.self_id || botFor(e)?.uin, target: e.isGroup ? e.group_id : e.user_id, user: e.user_id, capabilities: capabilities(e) }),
    route, version, confirm: isConfirmedReceipt, verify
  });
}
