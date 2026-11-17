import fs from 'node:fs';
import crypto from 'node:crypto';

export const CAMP_MINIAPP_URL = 'https://m.q.qq.com/a/s/1bacb484aaf1419520802da0b1204504';
const TEMPLATE_URL = new URL('../resources/miniapp/camp.json', import.meta.url);
const PACKAGE_URL = new URL('../package.json', import.meta.url);

function primitive(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
}
function maskedId(value) {
  const text = String(value ?? '');
  return text.length > 6 ? text.slice(0, 2) + '***' + text.slice(-4) : (text ? '***' : '');
}
function packageVersion() {
  try { return String(JSON.parse(fs.readFileSync(PACKAGE_URL, 'utf8')).version || 'unknown'); }
  catch { return 'unknown'; }
}

/** Error/request objects are never serialized wholesale: they may contain card data or login headers. */
export function safeLogText(value, secrets = []) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = String(value);
  try { text = decodeURIComponent(text); } catch { /* Keep non-URL text. */ }
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join('[redacted]');
  }
  if (text.includes('com.tencent.miniapp')) return '[card-related error body redacted]';
  text = text.replace(/\b(?:cookie|set-cookie|authorization)\s*[:=]\s*[^\r\n]+/gi, '[sensitive header redacted]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]');
  text = text.replace(/\b(?:gok_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|npm_[A-Za-z0-9_]+)\b/g, '[redacted]');
  text = text.replace(/(["']?(?:authorization|cookie|(?:access[_-]?|refresh[_-]?)?token|secret|ticket|session|session_id|openid|open_id|[cs]key|ck|stoken|ltoken|csrf|jwt|authcode|code|password)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, '$1[redacted]');
  return text.slice(0, 800);
}
function safePrimitive(value, secrets) {
  const raw = primitive(value);
  return typeof raw === 'string' ? safeLogText(raw, secrets) : raw;
}

export function errorSummary(error, secrets = []) {
  const nested = error?.error || error?.response?.data;
  return {
    name: safeLogText(error?.name || 'Error', secrets),
    code: safePrimitive(error?.code ?? nested?.code, secrets),
    retcode: safePrimitive(error?.retcode ?? nested?.retcode, secrets),
    status: safePrimitive(error?.status ?? error?.response?.status, secrets),
    message: safeLogText(error?.message || error?.wording || nested?.message || nested?.wording || 'unknown_error', secrets),
    stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 5).map(line => safeLogText(line, secrets)).join('\n') : undefined
  };
}

export function receiptSummary(result, secrets = []) {
  const rows = Array.isArray(result) ? result.slice(0, 8) : [result];
  const messageIds = [];
  for (const row of rows) {
    const id = primitive(row?.message_id ?? row?.messageId ?? row?.data?.message_id ?? row?.seq);
    if (id !== undefined && /^[A-Za-z0-9+/=_:-]{1,128}$/.test(String(id)) && !secrets.some(secret => secret && String(id).includes(secret))) {
      messageIds.push(safeLogText(String(id), secrets));
    }
  }
  const first = rows[0];
  return {
    resultType: result === null ? 'null' : typeof result,
    status: safePrimitive(first?.status, secrets),
    retcode: safePrimitive(first?.retcode, secrets),
    messageIds,
    explicitFailure: result === false || Boolean(first?.error) || first?.status === 'failed' ||
      (first?.retcode !== undefined && ![0, 1, '0', '1'].includes(first.retcode))
  };
}

export async function withDeadline(promise, ms = 2500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error('diagnostic_timeout'); error.code = 'DIAGNOSTIC_TIMEOUT'; reject(error); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Shared diagnostics only; frameworks supply their own native transports. No login state is obtained here. */
export async function sendMiniappWithDiagnostics(event, hooks) {
  const traceId = crypto.randomBytes(6).toString('hex');
  const started = Date.now();
  const secrets = [];
  const context = {
    traceId, diagnosticVersion: 1, diagnosticRevision: '20261118.1', framework: hooks.framework, pluginVersion: packageVersion(),
    node: process.version, os: process.platform
  };
  const log = (level, stage, extra = {}) => {
    try {
      const logger = hooks.logger();
      const method = logger?.[level] || logger?.info;
      if (typeof method !== 'function') return;
      method.call(logger, `[营地小程序][${traceId}] ${JSON.stringify({ ...context, stage, elapsedMs: Date.now() - started, ...extra })}`);
    } catch { /* A broken log sink must not block a reply. */ }
  };
  const fail = (stage, error, extra = {}) => log('warn', stage, { ...extra, error: errorSummary(error, secrets) });
  const outcome = { traceId, log, fail, receipt: result => receiptSummary(result, secrets), fallback: false, confirmed: false, serverVerification: 'unavailable' };
  let phase = 'context';
  try {
    const described = hooks.describe(event) || {};
    Object.assign(context, {
      adapter: described.adapter || 'unknown', botId: String(described.botId || ''),
      scene: event?.isGroup ? 'group' : 'private', target: maskedId(described.target), user: maskedId(described.user),
      capabilities: described.capabilities, command: String(event?.msg || '').match(/^#[^\d\s]{1,32}/)?.[0] || ''
    });
    log('info', 'begin');
    phase = 'template_load';
    const rawTemplate = fs.readFileSync(TEMPLATE_URL, 'utf8');
    const signature = rawTemplate.match(/"token"\s*:\s*"([^"]+)"/);
    if (signature) secrets.push(signature[1]);
    const card = JSON.parse(rawTemplate);
    if (typeof card?.config?.token === 'string') secrets.push(card.config.token);
    const cardJson = JSON.stringify(card);
    secrets.push(cardJson, JSON.stringify(cardJson));
    context.templateHash = crypto.createHash('sha256').update(cardJson).digest('hex').slice(0, 16);
    context.payloadBytes = Buffer.byteLength(cardJson);
    context.cardVersion = String(card?.ver || '');
    context.schema = { rootKeys: Object.keys(card || {}), configKeys: Object.keys(card?.config || {}), signaturePresent: Boolean(card?.config?.token), signatureType: typeof card?.config?.token, ctimePresent: Boolean(card?.config?.ctime), ctimeType: typeof card?.config?.ctime, previewPresent: Boolean(card?.meta?.miniapp?.preview) };
    phase = 'template_validate';
    const invalid = [];
    if (card?.app !== 'com.tencent.miniapp.lua') invalid.push('app');
    if (card?.view !== 'miniapp') invalid.push('view');
    if (card?.meta?.miniapp?.jumpUrl !== CAMP_MINIAPP_URL) invalid.push('meta.miniapp.jumpUrl');
    if (typeof card?.config?.token !== 'string' || !card.config.token) invalid.push('config.token');
    if (!['number', 'string'].includes(typeof card?.config?.ctime) || !Number.isFinite(Number(card.config.ctime)) || Number(card.config.ctime) <= 0) invalid.push('config.ctime');
    if (typeof card?.meta?.miniapp?.ark_reserved1 !== 'string') invalid.push('meta.miniapp.ark_reserved1');
    if (invalid.length) {
      const error = new Error('invalid_card_template_fields: ' + invalid.join(', ')); error.code = 'CARD_TEMPLATE_INVALID'; throw error;
    }
    const reserved = JSON.parse(card.meta.miniapp.ark_reserved1);
    if (reserved.mini_app_id !== 'wx898cb4b08963dccb') {
      const error = new Error('unexpected_miniapp_id'); error.code = 'CARD_APP_ID_MISMATCH'; throw error;
    }
    log('debug', 'template_validated');
    phase = 'transport_select';
    const route = hooks.route(event, cardJson);
    context.route = route.name;
    context.dataShape = route.dataShape;
    if (!route.send) {
      outcome.fallback = true;
      log('warn', 'unsupported_transport', { reason: route.reason || 'no_native_json_transport', serverVerification: 'not_attempted' });
      return outcome;
    }
    if (hooks.version) {
      try {
        const version = await hooks.version(event);
        context.backend = safeLogText(version?.app || 'unknown', secrets);
        context.backendVersion = safeLogText(version?.version || 'unknown', secrets);
        context.versionSource = version?.source || 'adapter';
        context.versionAgeMs = Number.isFinite(version?.ageMs) ? version.ageMs : 0;
        context.nativeClientVersion = safeLogText(version?.clientVersion || 'unknown', secrets);
        log('debug', 'backend_version');
      } catch (error) { fail('backend_version_unavailable', error); }
    }
    phase = 'send';
    log('info', 'dispatch', { singleCardMessage: true });
    const result = await route.send();
    const receipt = receiptSummary(result, secrets);
    outcome.messageId = receipt.messageIds[0] || '';
    if (receipt.explicitFailure) {
      outcome.fallback = true;
      fail('send_rejected', result, { receipt });
      return outcome;
    }
    outcome.confirmed = Boolean(hooks.confirm(result));
    log(outcome.confirmed ? 'info' : 'warn', outcome.confirmed ? 'receipt_confirmed' : 'receipt_unconfirmed', { receipt, clientDisplay: 'not_verified', authorization: 'not_observed' });
    // An ambiguous acknowledgement is never a reason to resend the card and create duplicates.
    if (outcome.confirmed && outcome.messageId && hooks.verify) {
      phase = 'server_verify';
      try {
        const verification = await hooks.verify(event, outcome.messageId, context.backend);
        outcome.serverVerification = verification.status;
        if (verification.status === 'downgraded') outcome.fallback = true;
        log(verification.status === 'downgraded' ? 'warn' : 'info', 'server_verify', {
          status: verification.status, elementTypes: verification.elementTypes,
          reason: safeLogText(verification.reason || '', secrets), clientDisplay: 'not_verified', authorization: 'not_observed'
        });
      } catch (error) { fail('server_verification_unavailable', error); }
    } else log('debug', 'server_verify', { status: 'unavailable', reason: 'no_server_packet_verifier', clientDisplay: 'not_verified', authorization: 'not_observed' });
    return outcome;
  } catch (error) {
    outcome.fallback = true;
    fail(phase + '_failed', error);
    return outcome;
  } finally {
    log('info', 'card_attempt_end', { confirmed: outcome.confirmed, fallback: outcome.fallback, serverVerification: outcome.serverVerification });
  }
}
