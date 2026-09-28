const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redactText } = require('../logger.cjs');
const { runOrders } = require('./run-orders.cjs');

const fields = (value, names) => Object.fromEntries(names.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
function historyRecord(snapshot, sensitive = []) {
  if (!snapshot?.id) return null;
  const record = fields(snapshot, ['id', 'sessionId', 'source', 'target', 'strategy', 'totalMargin', 'startedAt', 'updatedAt', 'state', 'active', 'dryRun', 'requiresAttention', 'completedOrders', 'totalOrders', 'stopMode', 'manualManagement', 'botStopped', 'closeStatus', 'appStoppedAt', 'outcome', 'reason', 'lossCount', 'maxLosses']);
  if (snapshot.error) record.error = redactText(snapshot.error, sensitive).slice(0, 2000);
  if (snapshot.closeError) record.closeError = redactText(snapshot.closeError, sensitive).slice(0, 2000);
  if (snapshot.result) record.result = fields(snapshot.result, ['targetProfit', 'sourcePnl', 'netPnl', 'tradingVolume', 'provisional']);
  record.symbols = [...new Set([...(snapshot.symbols || []), ...(snapshot.plan?.legs || []).map((leg) => leg.symbol), ...(snapshot.runs || []).map((run) => run.symbol)])];
  record.orders = (snapshot.runs || []).flatMap((run) => runOrders(run).map((order) => ({
    ...fields(order, ['leg', 'symbol', 'clientOrderId', 'orderId', 'quantity', 'executedQuantity', 'price', 'postOnly', 'averagePrice', 'status', 'side', 'type', 'reduceOnly', 'createdAt', 'updatedAt', 'errorCode', 'exchangeCode', 'observedClosed', 'nativeProtection', 'provisionalPrice', 'reconciliationReason']),
    hedgeId: snapshot.id, runId: run.id, exchange: order.leg === 'source' ? snapshot.source : snapshot.target,
  })));
  return record;
}

class HistoryStore {
  constructor(directory, { sensitiveValues = () => [], now = Date.now } = {}) {
    this.directory = directory; this.sensitiveValues = sensitiveValues; this.now = now; this.last = new Map();
  }
  record(snapshot) {
    const record = historyRecord(snapshot, this.sensitiveValues());
    if (!record) return;
    // PnL polling timestamps alone must not rewrite unchanged history every second.
    const comparison = { ...record }; delete comparison.updatedAt;
    const signature = JSON.stringify(comparison);
    if (this.last.get(record.id) === signature) return;
    fs.mkdirSync(this.directory, { recursive: true });
    const name = crypto.createHash('sha256').update(record.id).digest('hex') + '.json';
    const file = path.join(this.directory, name);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, ...record, updatedAt: record.updatedAt || this.now() }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    this.last.set(record.id, signature);
    if (this.last.size > 100) this.last.delete(this.last.keys().next().value);
  }
  list(options = {}) {
    let files;
    try { files = fs.readdirSync(this.directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)); }
    catch (error) { if (error.code === 'ENOENT') files = []; else throw error; }
    let unreadable = 0;
    const records = files.flatMap((name) => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
        if (value.version !== 1 || !value.id || !Array.isArray(value.orders) || !Array.isArray(value.symbols)) throw new Error('Invalid history');
        return [value];
      } catch { unreadable++; return []; }
    });
    const searchable = (value) => String(value || '').toLowerCase().replace(/[.\s-]/g, '');
    const query = searchable(String(options.query || '').slice(0, 100));
    const kind = options.kind === 'orders' ? 'orders' : 'hedges';
    let rows = kind === 'orders' ? records.flatMap((record) => record.orders.map((order) => ({ ...order, dryRun: record.dryRun }))) : records;
    if (query) rows = rows.filter((row) => [row.id, row.hedgeId, row.symbol, ...(row.symbols || []), row.source, row.target, row.exchange, row.orderId, row.clientOrderId].some((value) => searchable(value).includes(query)));
    rows.sort((a, b) => (b.createdAt || b.startedAt || b.updatedAt || 0) - (a.createdAt || a.startedAt || a.updatedAt || 0) || String(b.id || b.clientOrderId).localeCompare(String(a.id || a.clientOrderId)));
    const pages = Math.max(1, Math.ceil(rows.length / 25));
    const page = Math.min(pages - 1, Math.max(0, Math.floor(Number(options.page) || 0)));
    return { kind, rows: rows.slice(page * 25, (page + 1) * 25), page, pages, total: rows.length, unreadable };
  }
}
module.exports = { HistoryStore, historyRecord };
