const test = require('node:test');
const assert = require('node:assert/strict');
const { decimalString, decodeBinance, decodeLbank, decodeMexc, resolveReference } = require('./market-streams.cjs');

test('public stream decoders normalize books and current ticker shapes', () => {
  assert.equal(decimalString(1e-7), '0.0000001');
  assert.equal(decodeBinance({ data: { e: 'bookTicker', s: 'BTCUSDT', b: '99', B: '2', a: '101', A: '3', E: 1000 } }, 'BTCUSDT', 1000)[0].bid, 99);
  const lb = decodeLbank({ x: 3, z: 4, w: 1000, b: [['99', '2']], s: [['101', '3']] }, 'BTCUSDT', .01, 1000)[0];
  assert.deepEqual(lb.book.bids, [['99', .02]]); assert.deepEqual(lb.book.asks, [['101', .03]]);
  const mx = decodeMexc({ channel: 'push.depth.full', symbol: 'BTC_USDT', ts: 1000, data: { bids: [[99, 2]], asks: [[101, 3]] } }, 'BTCUSDT', .001, 1000)[0];
  assert.deepEqual(mx.book.bids, [[99, .002]]);
});

test('Binance takes precedence and MEXC is retained for diagnostics', async () => {
  const fetcher = async url => url.includes('binance')
    ? { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }] }
    : { data: [{ symbol: 'BTC_USDT', state: 0, contractSize: .001 }] };
  assert.deepEqual(await resolveReference('btc_usdt', fetcher), { leader: 'binance', hasBinance: true, hasMexc: true, mexcSymbol: 'BTC_USDT', mexcMultiplier: .001 });
});

test('MEXC becomes leader only when Binance contract is absent', async () => {
  const fetcher = async url => url.includes('binance') ? { symbols: [] } : { data: [{ symbol: 'FOO_USDT', state: 0, contractSize: 10 }] };
  assert.equal((await resolveReference('FOOUSDT', fetcher)).leader, 'mexc');
});

test('MEXC stock aliases remain available as diagnostics for a Binance-led symbol', async () => {
  const fetcher = async url => url.includes('binance')
    ? { symbols: [{ symbol: 'SNDKUSDT', status: 'TRADING' }] }
    : { data: [{ symbol: 'SNDKSTOCK_USDT', baseCoinName: 'SNDK', quoteCoin: 'USDT', state: 0, contractSize: .001 }] };
  const reference = await resolveReference('SNDKUSDT', fetcher);
  assert.deepEqual(reference, { leader: 'binance', hasBinance: true, hasMexc: true, mexcSymbol: 'SNDKSTOCK_USDT', mexcMultiplier: .001 });
  const event = decodeMexc({ channel: 'push.depth.full', symbol: 'SNDKSTOCK_USDT', ts: 1000, data: { bids: [[1570, 20]], asks: [[1571, 30]] } }, 'SNDKUSDT', .001, 1000, reference.mexcSymbol)[0];
  assert.deepEqual(event.book.bids, [[1570, .02]]);
});
