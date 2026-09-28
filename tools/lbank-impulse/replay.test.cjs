const test = require('node:test');
const assert = require('node:assert/strict');
const { runReplay } = require('./replay.cjs');

function venue(mid, ageMs = 0, depth = 10) {
  return { bid: mid - .01, ask: mid + .01, mid, ageMs, bids: [{ price: mid - .01, quantity: depth }], asks: [{ price: mid + .01, quantity: depth }] };
}

function fixture() {
  const meta = { type: 'meta', version: 1, config: { symbol: 'TESTUSDT', nominal: 100, cooldownSeconds: 0 }, rules: { tickSize: .01, quantityStep: .01, minQuantity: .01, minNotional: 5, maxQuantity: 1000 },
    fees: { makerFee: .0002, takerFee: .0006 }, reference: { leader: 'binance' },
    defaults: { warmupMs: 0, minimumHoldMs: 0, trailingActivationBps: 100, reversalBps: 2, reversalHoldMs: 0 } };
  const market = (at, leaderMid, lbankMid, customLbank) => ({ type: 'market', at, market: { venues: { binance: venue(leaderMid), lbank: customLbank || venue(lbankMid) } } });
  return [meta,
    market(0, 100, 99), market(1000, 100.06, 98.8),
    // Later books drive the exit; the aggressive LIMIT fills against the visible ask at signal time.
    market(1010, 100.06, 98.78, { bid: 98.77, ask: 98.79, mid: 98.78, ageMs: 0, bids: [{ price: 98.77, quantity: 10 }], asks: [{ price: 98.79, quantity: 10 }] }),
    market(1100, 100.1, 99), market(1200, 100.07, 99), market(1350, 100.07, 99)];
}

test('replay recomputes a conservative fill and confirmed reversal without look-ahead', () => {
  const rows = fixture(), report = runReplay(rows);
  assert.equal(report.orders, 1); assert.equal(report.fills, 1); assert.equal(report.fillRate, 1);
  assert.equal(report.decisions.find(row => row.type === 'close').reason, 'trailing_pullback');
  const prefix = runReplay(rows.slice(0, 4));
  assert.deepEqual(prefix.decisions.filter(row => ['order', 'fill'].includes(row.type)), report.decisions.slice(0, 2));
  assert.ok(report.maxHoldMs <= 15000); assert.ok(Number.isFinite(report.netPnl));
});

test('replay rejects time travel and an aggressive LIMIT can fill at the visible ask', () => {
  const rows = fixture(); rows[2].at = -1;
  assert.throws(() => runReplay(rows), /временной порядок/);
  const touched = fixture(); touched[2].market.venues.lbank = { ...venue(98.81), bid: 98.8, ask: 98.81, mid: 98.805,
    bids: [{ price: 98.8, quantity: 100 }], asks: [{ price: 98.81, quantity: 100 }] };
  const report = runReplay(touched.slice(0, 3)); assert.equal(report.fills, 1);
});

test('replay honors the configured impulse percent', () => {
  const rows = fixture(); rows[0].config.impulsePercent = 1;
  const report = runReplay(rows);
  assert.equal(report.orders, 0); assert.equal(report.fills, 0);
});

test('fees block ordinary Paper and Live entries while explicit Paper Test may bypass them', () => {
  const rows = fixture(); rows[0].config.mode = 'paper'; rows[0].config.paperFast = false; rows[0].fees = { makerFee: .1, takerFee: .1 };
  assert.equal(runReplay(rows).orders, 0);
  rows[0].config.mode = 'live';
  assert.equal(runReplay(rows).orders, 0);
  rows[0].config.mode = 'paper'; rows[0].config.paperFast = true;
  assert.equal(runReplay(rows).orders, 1);
});

test('replay uses the same depth-safe aggressive LIMIT route and taker entry fee as the live engine', () => {
  const rows = fixture();
  const report = runReplay(rows, { config: { marketEntryImpulseMultiplier: 1, maxEntrySlippagePercent: 0, depthSafetyMultiplier: 2 } });
  const order = report.decisions.find(row => row.type === 'order'), fill = report.decisions.find(row => row.type === 'fill');
  assert.equal(order.entryType, 'LIMIT'); assert.equal(order.executionReason, 'aggressive_limit_ready'); assert.equal(order.postOnly, false);
  assert.equal(fill.entryType, 'LIMIT'); assert.equal(fill.postOnly, false);
  assert.ok(report.fees > fill.price * fill.quantity * rows[0].fees.takerFee);
});

test('discretionary pullback waits for configured net profitability', () => {
  const rows = fixture();
  let report = runReplay(rows, { config: { minimumTrailNetPercent: 0 } });
  assert.equal(report.decisions.find(row => row.type === 'close').reason, 'trailing_pullback');
  report = runReplay(rows, { config: { minimumTrailNetPercent: 1 } });
  assert.equal(report.decisions.find(row => row.type === 'close').reason, 'end_of_replay');
});
