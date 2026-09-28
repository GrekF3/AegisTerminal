const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore, historyRecord } = require('./history-store.cjs');

function withStore(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-history-test-'));
  try { fn(new HistoryStore(directory), directory); }
  finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('hedge-history-test-')) throw new Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
test('history survives restart, upserts orders, paginates and searches', () => withStore((store, directory) => {
  const snapshot = { id: 'run-0', source: 'okx', target: 'gateio', symbols: ['BTCUSDT'], startedAt: 1, state: 'waiting_target', runs: [{ id: 'leg', targetOrder: { leg: 'target', symbol: 'BTCUSDT', clientOrderId: 'order-1', status: 'NEW', executedQuantity: 0, createdAt: 2 } }] };
  store.record(snapshot);
  snapshot.runs[0].targetOrder.status = 'FILLED'; snapshot.runs[0].targetOrder.executedQuantity = 1;
  store.record(snapshot);
  for (let i = 1; i < 30; i++) store.record({ id: 'run-' + i, symbols: ['ETHUSDT'], startedAt: i + 5, state: 'stopped' });
  const restarted = new HistoryStore(directory);
  assert.equal(restarted.list().rows.length, 25); assert.equal(restarted.list({ page: 1 }).rows.length, 5);
  assert.equal(restarted.list({ query: 'btc' }).total, 1);
  assert.equal(restarted.list({ query: 'Gate.io' }).total, 1);
  const orders = restarted.list({ kind: 'orders', query: 'order-1' });
  assert.equal(orders.total, 1); assert.equal(orders.rows[0].status, 'FILLED'); assert.equal(orders.rows[0].exchange, 'gateio');
}));
test('history whitelists fields and removes credentials from errors', () => {
  const value = historyRecord({ id: 'test', sourceCredentials: { apiKey: 'private-value' }, error: 'private-value proxy=http://user:pass@host', closeError: 'private-value failed', botStopped: true, closeStatus: 'failed', result: { netPnl: -1, provisional: true, secret: 'hidden' }, runs: [{ id: 'leg', targetOrder: { leg: 'target', secret: 'hidden', clientOrderId: 'ok' } }] }, ['private-value']);
  assert.equal(JSON.stringify(value).includes('private-value'), false); assert.equal(JSON.stringify(value).includes('hidden'), false);
  assert.equal(value.result.provisional, true); assert.equal(value.result.netPnl, -1);
  assert.equal(value.botStopped, true); assert.equal(value.closeStatus, 'failed'); assert.match(value.closeError, /failed$/);
});
test('corrupt records are reported, not overwritten or shown as empty success', () => withStore((store, directory) => {
  fs.writeFileSync(path.join(directory, 'a'.repeat(64) + '.json'), '{bad');
  assert.equal(store.list().unreadable, 1); assert.equal(store.list().total, 0);
}));

test('manual Stop is durable history with unchanged order statuses and no invented result', () => withStore((store, directory) => {
  store.record({ id: 'manual', state: 'stopped', active: false, manualManagement: true, stopMode: 'app-only', appStoppedAt: 123,
    runs: [{ id: 'coin', symbol: 'BTCUSDT', sourceOrders: [{ leg: 'source', orderId: 'unknown-order', status: 'UNKNOWN', executedQuantity: 0 }],
      targetOrders: [{ leg: 'target', orderId: 'filled-order', status: 'FILLED', executedQuantity: 1 }], closeOrders: [] }] });
  const record = new HistoryStore(directory).list().rows[0];
  assert.equal(record.manualManagement, true); assert.equal(record.appStoppedAt, 123);
  assert.equal(record.state, 'stopped'); assert.equal(record.active, false); assert.equal(record.result, undefined);
  assert.equal(record.orders.find(order => order.orderId === 'unknown-order').status, 'UNKNOWN');
  assert.equal(record.orders.find(order => order.orderId === 'filled-order').status, 'FILLED');
}));
