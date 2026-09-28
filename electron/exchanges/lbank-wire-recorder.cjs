const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 2_000_000;
const MAX_VALUE_DEPTH = 14;
const MAX_ARRAY_ITEMS = 2_000;
const ALLOWED_MARKERS = new Set([
  'baseline', 'leverage', 'margin_mode', 'place_post_only', 'cancel_order',
  'open_market', 'close_position', 'set_tp_sl', 'edit_tp_sl', 'cancel_tp_sl',
  'trigger_tp_sl',
]);

function normalizedKey(value) { return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function secretKey(value) {
  const key = normalizedKey(value);
  return key === 'sign' || key.includes('signature') || key.includes('secret') || key.includes('token')
    || key.includes('password') || key.includes('passphrase') || key.includes('cookie')
    || key.includes('authorization') || key.includes('credential') || key.includes('apikey')
    || key.includes('accesskey') || key.endsWith('key') || ['key', 'listenkey', 'privatekey', 'publickey', 'echostr'].includes(key);
}
function identityKey(value) {
  const key = normalizedKey(value);
  return ['accountid', 'memberid', 'userid', 'customerid', 'investorid', 'tradeunitid', 'subaccountid'].includes(key);
}
function pseudonym(captureId, value) {
  return `sha256:${crypto.createHash('sha256').update(`${captureId}:${String(value)}`).digest('hex').slice(0, 16)}`;
}
function cleanString(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '***')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***');
}
function sanitize(value, captureId, key = '', depth = 0) {
  if (secretKey(key)) return '***';
  if (identityKey(key) && value !== null && value !== undefined && value !== '') return pseudonym(captureId, value);
  if (depth > MAX_VALUE_DEPTH) return '[depth-limited]';
  if (typeof value === 'string') return cleanString(value).slice(0, MAX_BODY_BYTES);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const rows = value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitize(item, captureId, key, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) rows.push(`[${value.length - MAX_ARRAY_ITEMS} items omitted]`);
    return rows;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, captureId, childKey, depth + 1)]));
  return value === undefined ? null : cleanString(value);
}
function parsePayload(value, captureId, contentType = '') {
  const raw = String(value || '');
  if (!raw) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return { omitted: true, bytes: Buffer.byteLength(raw, 'utf8'), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  try { return sanitize(JSON.parse(raw), captureId); } catch {}
  const base64 = !/application\/x-www-form-urlencoded/i.test(contentType) && /^[A-Za-z0-9+/]{16,}={0,2}$/.test(raw)
    && Buffer.from(raw, 'base64').toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '');
  if (base64) return { opaque: true, bytes: Buffer.byteLength(raw, 'utf8'), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  if (/application\/x-www-form-urlencoded/i.test(contentType) || /^[A-Za-z][A-Za-z0-9_.-]{0,63}=[^&]*(?:&[A-Za-z][A-Za-z0-9_.-]{0,63}=[^&]*)*$/.test(raw)) {
    try {
      const result = {};
      for (const [key, item] of new URLSearchParams(raw)) result[key] = result[key] === undefined ? sanitize(item, captureId, key) : ([]).concat(result[key], sanitize(item, captureId, key));
      return result;
    } catch {}
  }
  const cleaned = cleanString(raw);
  if (/^(?:ping|pong)$/i.test(cleaned.trim())) return cleaned.trim().toLowerCase();
  return { opaque: true, bytes: Buffer.byteLength(raw, 'utf8'), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}
function safeEndpoint(value, captureId) {
  try {
    const url = new URL(value);
    if (!['https:', 'wss:'].includes(url.protocol)) return null;
    const query = {};
    for (const [key, item] of url.searchParams) query[key] = query[key] === undefined ? sanitize(item, captureId, key) : ([]).concat(query[key], sanitize(item, captureId, key));
    return { url: `${url.origin}${url.pathname}`, ...(Object.keys(query).length ? { query } : {}) };
  } catch { return null; }
}
function isLBankCfdUrl(value, trustedLBankPage = false) {
  try {
    const url = new URL(value);
    const publicHost = url.hostname === 'lbank.com' || url.hostname.endsWith('.lbank.com');
    return url.protocol === 'https:' && (trustedLBankPage || publicHost) && /(?:^|\/)cfd\//i.test(url.pathname);
  } catch { return false; }
}
function selectedHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const allowed = new Set(['content-type', 'content-length', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']);
  const result = {};
  for (const [key, value] of Object.entries(headers)) if (allowed.has(key.toLowerCase())) result[key.toLowerCase()] = cleanString(value).slice(0, 300);
  return Object.keys(result).length ? result : undefined;
}
function safeErrorCode(error) {
  if (error?.cdpReason && /^[a-z_]+$/.test(error.cdpReason)) return error.cdpReason;
  if (error?.name === 'AbortError') return 'aborted';
  return 'body_unavailable';
}

class LBankWireRecorder {
  constructor({ connection, sessionId, directory, now = () => Date.now(), id = () => crypto.randomUUID() }) {
    if (!connection || typeof connection.send !== 'function' || typeof connection.onEvent !== 'function') throw new Error('LBank recorder: CDP-соединение не поддерживает пассивную запись');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('LBank recorder: вкладка Futures не подключена');
    this.connection = connection;
    this.sessionId = sessionId;
    this.directory = path.resolve(directory);
    this.now = now;
    this.captureId = id();
    this.active = false;
    this.eventCount = 0;
    this.sequence = 0;
    this.startedAt = null;
    this.filePath = null;
    this.requests = new Map();
    this.sockets = new Map();
    this.pendingBodies = new Set();
    this.writeChain = Promise.resolve();
    this.writeError = null;
    this.unsubscribe = null;
  }
  status() {
    return { active: this.active, captureId: this.captureId, startedAt: this.startedAt, eventCount: this.eventCount, error: this.writeError ? 'Не удалось записать файл диагностики' : null,
      filePath: this.filePath, fileName: this.filePath ? path.basename(this.filePath) : null, directory: this.directory };
  }
  append(kind, payload = {}) {
    const record = { schemaVersion: 1, captureId: this.captureId, sequence: ++this.sequence, recordedAt: new Date(this.now()).toISOString(), kind, ...payload };
    const line = `${JSON.stringify(record)}\n`;
    this.eventCount++;
    this.writeChain = this.writeChain.then(() => fs.promises.appendFile(this.filePath, line, 'utf8')).catch(error => {
      this.writeError ||= error;
      this.active = false;
      this.unsubscribe?.(); this.unsubscribe = null;
    });
    return this.writeChain;
  }
  async start() {
    if (this.active) return this.status();
    await fs.promises.mkdir(this.directory, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(this.directory, `lbank-wire-${stamp}-${this.captureId.slice(0, 8)}.jsonl`);
    const handle = await fs.promises.open(this.filePath, 'wx', 0o600); await handle.close();
    this.startedAt = this.now();
    this.active = true;
    this.unsubscribe = this.connection.onEvent(event => this.onEvent(event));
    try {
      await this.connection.send('Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: MAX_BODY_BYTES, maxPostDataSize: MAX_BODY_BYTES }, this.sessionId);
      await this.append('capture_started', { scope: 'selected_lbank_futures_tab', filters: ['https /cfd/*', 'json websocket frames'], redaction: 'before_disk' });
      if (this.writeError) throw new Error('LBank recorder: не удалось создать файл записи');
      return this.status();
    } catch (error) {
      this.active = false; this.unsubscribe?.(); this.unsubscribe = null;
      await fs.promises.rm(this.filePath, { force: true }).catch(() => {});
      throw error;
    }
  }
  mark(marker) {
    if (!this.active) throw new Error('Сначала запустите LBank recorder');
    if (!ALLOWED_MARKERS.has(marker)) throw new Error('Неизвестная метка действия');
    return this.append('marker', { marker }).then(() => this.status());
  }
  onEvent(event) {
    if (!this.active || event?.sessionId !== this.sessionId || typeof event.method !== 'string') return;
    const params = event.params || {};
    // The selected target is already verified as https://www.lbank.com/futures/*.
    // LBank deliberately serves /cfd/* from rotating, non-LBank-looking hosts,
    // so the target/session boundary is the trust boundary rather than hostname.
    if (event.method === 'Network.requestWillBeSent' && isLBankCfdUrl(params.request?.url, true)) {
      const requestId = String(params.requestId || ''); if (!requestId) return;
      const contentType = Object.entries(params.request.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
      this.requests.set(requestId, { endpoint: safeEndpoint(params.request.url, this.captureId) });
      void this.append('http_request', { requestId, method: String(params.request.method || 'GET').slice(0, 12), ...safeEndpoint(params.request.url, this.captureId),
        resourceType: String(params.type || '').slice(0, 30), headerNames: Object.keys(params.request.headers || {}).map(normalizedKey).filter(Boolean).sort(),
        body: parsePayload(params.request.postData, this.captureId, contentType) });
      return;
    }
    if (event.method === 'Network.responseReceived' && this.requests.has(String(params.requestId || ''))) {
      const requestId = String(params.requestId), endpoint = this.requests.get(requestId)?.endpoint || {};
      void this.append('http_response', { requestId, ...endpoint, status: Number(params.response?.status), mimeType: String(params.response?.mimeType || '').slice(0, 100), headers: selectedHeaders(params.response?.headers) });
      return;
    }
    if (event.method === 'Network.loadingFinished' && this.requests.has(String(params.requestId || ''))) {
      const requestId = String(params.requestId), endpoint = this.requests.get(requestId)?.endpoint || {};
      const task = this.readBody(requestId, endpoint, Number(params.encodedDataLength));
      this.pendingBodies.add(task); task.then(() => this.pendingBodies.delete(task), () => this.pendingBodies.delete(task));
      return;
    }
    if (event.method === 'Network.loadingFailed' && this.requests.has(String(params.requestId || ''))) {
      const requestId = String(params.requestId), endpoint = this.requests.get(requestId)?.endpoint || {};
      this.requests.delete(requestId);
      void this.append('http_failed', { requestId, ...endpoint, canceled: params.canceled === true, blockedReason: String(params.blockedReason || '').slice(0, 80) || undefined });
      return;
    }
    if (event.method === 'Network.webSocketCreated') {
      const requestId = String(params.requestId || ''), endpoint = safeEndpoint(params.url, this.captureId);
      if (!requestId || !endpoint) return;
      this.sockets.set(requestId, endpoint);
      void this.append('websocket_opened', { requestId, ...endpoint });
      return;
    }
    if (['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(event.method)) {
      const requestId = String(params.requestId || ''); if (!requestId) return;
      const frame = params.response || {}, parsed = parsePayload(frame.payloadData, this.captureId);
      // Existing LBank sockets emit hundreds of opaque binary market frames per
      // second. They cannot be safely interpreted here. JSON control/private
      // frames remain useful and are retained even when the socket predated us.
      if (parsed?.opaque === true) return;
      void this.append('websocket_frame', { requestId, ...(this.sockets.get(requestId) || {}), existingSocket: !this.sockets.has(requestId) || undefined,
        direction: event.method.endsWith('Sent') ? 'sent' : 'received', opcode: Number(frame.opcode), payload: parsed });
      return;
    }
    if (event.method === 'Network.webSocketClosed' && this.sockets.has(String(params.requestId || ''))) {
      const requestId = String(params.requestId); void this.append('websocket_closed', { requestId, ...this.sockets.get(requestId) }); this.sockets.delete(requestId);
    }
  }
  async readBody(requestId, endpoint, encodedDataLength) {
    try {
      const result = await this.connection.send('Network.getResponseBody', { requestId }, this.sessionId);
      let raw = String(result?.body || '');
      if (result?.base64Encoded) {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length > MAX_BODY_BYTES) raw = ''; else raw = decoded.toString('utf8');
      }
      await this.append('http_response_body', { requestId, ...endpoint, encodedDataLength: Number.isFinite(encodedDataLength) ? encodedDataLength : undefined,
        body: raw ? parsePayload(raw, this.captureId, 'application/json') : { omitted: true, bytes: Number(encodedDataLength) || undefined } });
    } catch (error) {
      await this.append('http_response_body_unavailable', { requestId, ...endpoint, reason: safeErrorCode(error) });
    } finally { this.requests.delete(requestId); }
  }
  async stop(reason = 'user') {
    if (!this.active) { await this.writeChain; return this.status(); }
    this.active = false; this.unsubscribe?.(); this.unsubscribe = null;
    await Promise.allSettled([...this.pendingBodies]);
    await this.append('capture_stopped', { reason: ['user', 'disconnect', 'quit'].includes(reason) ? reason : 'user' });
    await this.writeChain;
    return this.status();
  }
}

module.exports = { LBankWireRecorder, ALLOWED_MARKERS, sanitize, parsePayload, isLBankCfdUrl };
