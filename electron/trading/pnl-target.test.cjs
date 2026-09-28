const test = require('node:test');
const assert = require('node:assert/strict');
const { targetPnlBasis } = require('./pnl-target.cjs');

const run = { symbol: 'BTCUSDT', margin: 10, leverage: 1, hedgedQuantity: .0001,
  targetOrders: [{ leg: 'target', executedQuantity: .0001, averagePrice: 79484.9 }], sourceOrders: [], closeOrders: [] };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('95% is based on filled entry margin, not the 10 USDT allocation', () => {
  const basis = targetPnlBasis(run, 95);
  near(basis.margin, 7.94849); near(basis.threshold, 7.5510655);
  near(basis.entryPrice, 79484.9); assert.equal(basis.percent, 95);
  near(targetPnlBasis({ ...run, leverage: 20 }, 95).threshold, basis.threshold / 20);
});

test('target replacements and partial fills use weighted prices, excluding closing orders', () => {
  const basis = targetPnlBasis({ ...run, leverage: 10, hedgedQuantity: 2, targetOrders: [
    { leg: 'target', executedQuantity: .5, averagePrice: 100 },
    { leg: 'target', executedQuantity: 0, averagePrice: null },
    { leg: 'target', executedQuantity: 1.5, averagePrice: 102 },
  ], closeOrders: [{ leg: 'target', reduceOnly: true, executedQuantity: 1, averagePrice: 110 }] }, 95);
  near(basis.entryPrice, 101.5); near(basis.margin, 20.3); near(basis.threshold, 19.285);
});

test('missing fills or averages cannot produce a guessed TP/SL threshold', () => {
  for (const patch of [{ leverage: 0 }, { leverage: Infinity }, { hedgedQuantity: 2 }, { hedgedQuantity: undefined },
    { targetOrders: [] }, { targetOrders: [{ leg: 'target', executedQuantity: .0001, averagePrice: null }] },
    { targetOrders: [{ leg: 'target', executedQuantity: NaN, averagePrice: 100 }] }]) {
    assert.throws(() => targetPnlBasis({ ...run, ...patch }, 95));
  }
  for (const percent of [0, -95, 101, Infinity, NaN]) assert.throws(() => targetPnlBasis(run, percent));
});
