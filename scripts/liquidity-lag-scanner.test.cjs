const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDepth, commonSymbol, SampleStat, socketPayload, lbankTickerRows } = require('./liquidity-lag-scanner.cjs');

test('scanner normalizes common futures symbols without changing assets', () => {
  assert.equal(commonSymbol('BTC_USDT'), 'BTCUSDT');
  assert.equal(commonSymbol('1000PEPE-USDT'), '1000PEPEUSDT');
});

test('depth metrics preserve best prices, spread, quote depth and imbalance', () => {
  const result = normalizeDepth([[99, 2], [98, 3]], [[101, 4], [102, 5]]);
  assert.equal(result.bid, 99); assert.equal(result.ask, 101); assert.equal(result.mid, 100);
  assert.equal(result.spreadBps, 200); assert.equal(result.depth50Usd, 0);
  const tight = normalizeDepth([[99.99, 2], [99.9, 3]], [[100.01, 4], [100.1, 5]]);
  assert.ok(tight.depth25Usd > 0); assert.ok(tight.imbalance25 < 0);
});

test('LBank object depth uses its volume field', () => {
  const result = normalizeDepth([{ price: '99.99', volume: '2' }], [{ price: '100.01', volume: '3' }]);
  assert.equal(result.topBidUsd, 199.98);
  assert.ok(Math.abs(result.topAskUsd - 300.03) < 1e-9);
});

test('sample statistics keep exact aggregates and stable percentiles', () => {
  const stat = new SampleStat(10); [1, 2, 3, 4, 5].forEach(value => stat.add(value));
  assert.deepEqual(stat.json(), { count: 5, min: 1, median: 3, p90: 5, max: 5, mean: 3 });
});

test('scanner accepts JSON frames and ignores text heartbeats', () => {
  assert.equal(socketPayload(Buffer.from('pong')), null);
  assert.deepEqual(socketPayload(Buffer.from('{"channel":"pong"}')), { channel: 'pong' });
});

test('LBank ticker keeps both snapshot arrays and live update objects', () => {
  assert.deepEqual(lbankTickerRows({ z: 3, d: [{ a: 'BTCUSDT', i: '100' }] }), [{ a: 'BTCUSDT', i: '100' }]);
  assert.deepEqual(lbankTickerRows({ z: 4, d: { a: 'BTCUSDT', i: '101' } }), [{ a: 'BTCUSDT', i: '101' }]);
});
