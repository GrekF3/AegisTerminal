// Runs inside the explicitly selected Futures page. Observe the site's existing
// private stream; never start a socket, subscribe to a channel, or fetch data.
function installLBankOrderEvents(scope, identity) {
  const key = Symbol.for('hedge.lbank.order-events.v1');
  const unavailable = reason => ({ state: 'unavailable', reason });
  if (typeof scope !== 'string' || !scope || typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) return unavailable('account_not_bound');
  const exactId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
  const get = (row, field) => row?.[field] ?? row?.[field[0].toLowerCase() + field.slice(1)];
  const stateOf = row => ({ '1': 'FILLED', '2': 'PARTIALLY_FILLED', '3': 'CANCELED', '4': 'NEW', '6': 'CANCELED' })[row.OrderStatus];
  const terminal = row => ['FILLED', 'CANCELED'].includes(stateOf(row));
  const same = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-12) * 1e-8;
  let registry = self[key];
  if (!registry) {
    registry = { scopes: new Map() };
    registry.read = (wantedScope, wantedIdentity, args = {}) => {
      const entry = registry.scopes.get(wantedScope);
      if (!entry || !entry.installed) return unavailable('observer_not_ready');
      if (!wantedIdentity || entry.identity !== wantedIdentity) return { state: 'conflict', reason: 'account_changed' };
      const id = exactId(args.orderId);
      if (!id || typeof args.symbol !== 'string') return { state: 'conflict', reason: 'invalid_order_identity' };
      const record = entry.orders.get(id);
      if (!record) return { state: 'missing' };
      if (record.conflict) return { state: 'conflict', reason: record.conflict };
      const row = record.row;
      if (row.InstrumentID !== args.symbol) return { state: 'conflict', reason: 'symbol_mismatch' };
      if (args.side != null && (!['BUY', 'SELL'].includes(args.side) || row.Direction !== (args.side === 'BUY' ? '0' : '1'))) return { state: 'conflict', reason: 'side_mismatch' };
      if (args.quantity != null && (!(number(args.quantity) > 0) || !same(row.Volume, number(args.quantity)))) return { state: 'conflict', reason: 'quantity_mismatch' };
      return { state: 'matched', row: { ...row }, receivedAt: record.receivedAt };
    };
    self[key] = registry;
  }
  let entry = registry.scopes.get(scope);
  if (entry?.identity !== undefined && entry.identity !== identity) return { state: 'mismatch', reason: 'account_changed' };
  if (entry?.installed) return { state: 'ready' };
  if (!entry) {
    entry = { identity, orders: new Map(), installed: false, unsubscribe: null };
    registry.scopes.set(scope, entry);
    while (registry.scopes.size > 4) {
      const oldest = registry.scopes.keys().next().value, removed = registry.scopes.get(oldest);
      try { removed.unsubscribe?.(); } catch { /* Cache eviction must not affect the site. */ }
      registry.scopes.delete(oldest);
    }
  }
  const save = raw => {
    if (!raw || typeof raw !== 'object') return;
    const id = exactId(get(raw, 'OrderSysID')), symbol = get(raw, 'InstrumentID');
    const volume = number(get(raw, 'Volume')), traded = number(get(raw, 'VolumeTraded'));
    const status = String(get(raw, 'OrderStatus')), direction = String(get(raw, 'Direction'));
    if (!id || typeof symbol !== 'string' || !/^[A-Z0-9]{1,20}USDT$/.test(symbol) || !(volume > 0) || traded === null || traded < 0 || traded > volume + volume * 1e-8
      || !['1', '2', '3', '4', '6'].includes(status) || !['0', '1'].includes(direction) || (status === '1' && !same(traded, volume))) return;
    const row = { OrderSysID: id, InstrumentID: symbol, Volume: volume, VolumeTraded: traded, OrderStatus: status, Direction: direction };
    for (const field of ['TradePrice', 'Price', 'Fee', 'VolumeRemain', 'VolumeCancled', 'InsertTime', 'UpdateTime']) {
      const value = number(get(raw, field));
      if (value !== null && (field === 'Fee' || value >= 0)) row[field] = value;
    }
    const offset = get(raw, 'OffsetFlag');
    if (offset != null && /^[0-8]$/.test(String(offset))) row.OffsetFlag = String(offset);
    const previous = entry.orders.get(id);
    if (previous?.conflict) return;
    if (previous) {
      const prior = previous.row;
      const conflict = prior.InstrumentID !== symbol || prior.Direction !== direction || !same(prior.Volume, volume)
        || (terminal(prior) && terminal(row) && (stateOf(prior) !== stateOf(row) || !same(prior.VolumeTraded, traded)
          || prior.TradePrice > 0 && row.TradePrice > 0 && !same(prior.TradePrice, row.TradePrice)))
        || (terminal(prior) && traded > prior.VolumeTraded && !same(prior.VolumeTraded, traded))
        || (terminal(row) && traded < prior.VolumeTraded && !same(prior.VolumeTraded, traded));
      if (conflict) { previous.conflict = 'contradictory_order_events'; return; }
      if (terminal(prior) && !terminal(row) || traded < prior.VolumeTraded && !same(prior.VolumeTraded, traded)) return;
      if (stateOf(prior) === 'PARTIALLY_FILLED' && stateOf(row) === 'NEW' && same(prior.VolumeTraded, traded)) return;
      // A repeated receipt may omit price/fee fields already confirmed earlier.
      for (const field of ['TradePrice', 'Fee']) if (row[field] == null && same(prior.VolumeTraded, traded) && prior[field] != null) row[field] = prior[field];
    }
    entry.orders.set(id, { row, receivedAt: Date.now() });
    while (entry.orders.size > 2000) entry.orders.delete(entry.orders.keys().next().value);
  };
  try {
    let require;
    const chunks = self.webpackChunk_N_E;
    if (!Array.isArray(chunks)) return unavailable('futures_client_not_ready');
    chunks.push([[`hedge_order_events_${Date.now()}_${Math.random()}`], {}, current => { require = current; }]);
    const candidates = Object.keys(require?.m || {}).filter(id => {
      const source = String(require.m[id]);
      return source.includes('observeMessage') && source.includes('WS_MESSAGES_PARSED_BATCH');
    });
    for (const id of candidates) {
      const observer = Object.values(require(id) || {}).find(value => value && typeof value.observeMessage === 'function');
      if (!observer) continue;
      const unsubscribe = observer.observeMessage(message => {
        if (!entry.installed || registry.scopes.get(scope) !== entry) return;
        if (Number(message?.topic) !== 12 || ![3, 4].includes(Number(message?.type)) || !Array.isArray(message.data) || message.data.length > 1000) return;
        for (const raw of message.data) save(raw);
      });
      if (typeof unsubscribe !== 'function') return unavailable('observer_contract_changed');
      entry.unsubscribe = unsubscribe; entry.installed = true;
      return { state: 'ready' };
    }
    return unavailable('order_observer_not_found');
  } catch { return unavailable('order_observer_failed'); }
}

function readLBankOrderEvent(scope, identity, args) {
  const registry = self[Symbol.for('hedge.lbank.order-events.v1')];
  return typeof registry?.read === 'function' ? registry.read(scope, identity, args) : { state: 'unavailable', reason: 'observer_not_ready' };
}

module.exports = { installLBankOrderEvents, readLBankOrderEvent };
