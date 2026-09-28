// Attach-only integration. It cannot launch, stop, edit or export browser profiles.
function localUrl(value, websocket = false) {
  let url; try { url = new URL(value); } catch { throw new Error('Некорректный локальный адрес Undetectable'); }
  if (!(websocket ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port
    || url.username || url.password || url.search || url.hash || (!websocket && !['', '/'].includes(url.pathname))) {
    throw new Error('Undetectable API/CDP: нужен локальный адрес с портом, без пароля и токена');
  }
  return url.href.replace(/\/$/, '');
}
async function json(url, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Undetectable: HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error('Undetectable: слишком большой ответ');
  return JSON.parse(body);
}
async function listProfiles(apiUrl, fetcher = fetch) {
  const base = localUrl(apiUrl || 'http://127.0.0.1:25325');
  let payload;
  try { payload = await json(base + '/list', fetcher); }
  catch { throw new Error('Запустите Undetectable и включите Local API в его настройках'); }
  if (payload?.code !== 0 || payload.status !== 'success' || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new Error('Undetectable: неизвестный формат списка профилей');
  return Object.entries(payload.data).filter(([id, row]) => /^[A-Za-z0-9_-]{1,128}$/.test(id) && row && typeof row === 'object').map(([id, row]) => ({
    id, name: String(row.name || id).slice(0, 200), status: String(row.status || ''),
    endpoint: row.websocket_link || (/^\d+$/.test(String(row.debug_port)) && Number(row.debug_port) > 0 && Number(row.debug_port) <= 65535 ? `http://127.0.0.1:${row.debug_port}` : ''),
  }));
}
function isFuturesPage(value) {
  try { const u = new URL(value); return u.origin === 'https://www.lbank.com' && /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?futures\/[a-z0-9]+\/?$/i.test(u.pathname); } catch { return false; }
}
function protocolError(error, method) {
  // Protocol messages can contain evaluated source/URLs. Only known messages
  // are surfaced; never log raw params, response.data or arbitrary page content.
  const known = [
    [/^Promise was collected\.?$/i, 'promise_collected', 'браузер освободил ожидаемый ответ'],
    [/^(Execution context was destroyed\.?|Cannot find context with specified id)$/i, 'context_lost', 'контекст вкладки изменился'],
    [/^(Inspected target navigated or closed|Target closed\.?)$/i, 'target_closed', 'вкладка закрылась или перешла на другую страницу'],
    [/^(Session with given id not found\.?|Session closed\.?)$/i, 'session_lost', 'сессия вкладки потеряна'],
    [/^Object couldn't be returned by value$/i, 'serialization', 'ответ не удалось сериализовать'],
  ];
  const match = known.find(([pattern]) => pattern.test(String(error?.message || '')));
  const code = Number.isInteger(error?.code) ? error.code : undefined;
  const safeMethod = /^[A-Za-z]+\.[A-Za-z]+$/.test(method || '') ? method : 'request';
  return Object.assign(new Error(`CDP ${safeMethod}${code == null ? '' : ` [${code}]`}: ${match?.[2] || 'ошибка протокола'}`), {
    cdpCode: code, cdpReason: match?.[1] || 'unknown', cdpMethod: safeMethod,
  });
}
class CdpConnection {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    socket.addEventListener('message', event => {
      let value; try { value = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(value.id);
      if (!pending) { if (value && typeof value.method === 'string') for (const listener of [...this.listeners]) { try { listener(value); } catch {} } return; }
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.error) pending.reject(protocolError(value.error, pending.method)); else pending.resolve(value.result);
    });
    socket.addEventListener('close', () => { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Undetectable отключён. Подключите профиль вручную.')); } this.pending.clear(); this.listeners.clear(); });
  }
  static async connect(endpoint, fetcher = fetch) {
    let url = localUrl(endpoint, true);
    if (url.startsWith('http')) url = localUrl((await json(url + '/json/version', fetcher)).webSocketDebuggerUrl, true);
    if (!/^wss?:/.test(url)) throw new Error('Undetectable не вернул CDP WebSocket');
    const socket = new WebSocket(url);
    const connection = new CdpConnection(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Undetectable: таймаут CDP')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Undetectable: CDP недоступен')); }, { once: true });
    });
    return connection;
  }
  send(method, params = {}, sessionId) {
    if (this.closed || this.socket.readyState !== 1) return Promise.reject(new Error('Подключите Undetectable вручную'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Undetectable: таймаут ответа страницы')); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('CDP: соединение потеряно')); }
    });
  }
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('CDP event listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() { this.socket.close(); } // Disconnect transport only; never Browser.close or profile/stop.
}
module.exports = { localUrl, listProfiles, isFuturesPage, CdpConnection };
