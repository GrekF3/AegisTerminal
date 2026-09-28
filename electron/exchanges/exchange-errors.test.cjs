const test = require('node:test');
const assert = require('node:assert/strict');
const { categoryFor, exchangeApiError, classifyTransportError } = require('./exchange-errors.cjs');
const { closeRetryDelay } = require('../trading/close-retry.cjs');

test('verified close and order-state codes are normalized for every venue', () => {
  const cases = [
    ['binance', -2024, 'NO_POSITION'],
    ['bybit', 110034, 'NO_POSITION'],
    ['okx', 51169, 'NO_POSITION'],
    ['bitget', 25227, 'NO_POSITION'],
    ['mexc', 2009, 'NO_POSITION'],
    ['gateio', 'POSITION_EMPTY', 'NO_POSITION'],
    ['lbank', 31, 'NO_POSITION'],
    ['binance', -2013, 'ORDER_NOT_FOUND'],
    ['bybit', 110008, 'ALREADY_FINAL'],
    ['okx', 51400, 'ORDER_NOT_FOUND'],
    ['bitget', 50066, 'POSITION_CLOSING'],
    ['mexc', 2041, 'ALREADY_FINAL'],
    ['gateio', 'ORDER_FINISHED', 'ALREADY_FINAL'],
  ];
  for (const [exchange, code, category] of cases) assert.equal(categoryFor(exchange, code), category, `${exchange} ${code}`);
});

test('known rejections are definitive, but documented unknown outcomes remain fail-closed', () => {
  const absent = exchangeApiError('okx', 51169, "Order failed because you don't have any positions");
  assert.equal(absent.code, 'NO_POSITION');
  assert.equal(absent.exchangeCode, '51169');
  assert.equal(absent.definitive, true);
  assert.match(absent.message, /OKX:.*51169/);

  for (const [exchange, code] of [['binance', -1007], ['okx', 50004], ['bitget', 40010], ['bybit', 10000]]) {
    const error = exchangeApiError(exchange, code, 'status unknown');
    assert.equal(error.definitive, false, `${exchange} ${code}`);
  }
  assert.equal(exchangeApiError('mexc', 987654, 'new code').definitive, false);
  assert.equal(exchangeApiError('lbank', 987654, 'unobserved code').definitive, false);
  assert.equal(exchangeApiError('lbank', 31, 'amount exceeds available').exchangeCode, '31');
});

test('HTTP business errors retain transport metadata and their raw venue code', () => {
  const source = Object.assign(new Error('Gate.io: empty (HTTP 400)'), {
    exchangeCode: 'POSITION_EMPTY', httpStatus: 400, endpoint: 'https://api.gateio.ws/api/v4/futures/usdt/orders',
  });
  const error = classifyTransportError('gateio', source);
  assert.equal(error.code, 'NO_POSITION');
  assert.equal(error.exchangeCode, 'POSITION_EMPTY');
  assert.equal(error.httpStatus, 400);
  assert.equal(error.endpoint, source.endpoint);
});

test('only reconcilable close states are scheduled for a later read-and-retry cycle', () => {
  assert.equal(closeRetryDelay(exchangeApiError('bitget', 50066, 'position is closing')), 1000);
  assert.equal(closeRetryDelay(exchangeApiError('binance', -1003, 'rate limit')), 5000);
  assert.equal(closeRetryDelay(exchangeApiError('okx', 51169, 'no position')), null);
  assert.equal(closeRetryDelay(exchangeApiError('bybit', 110007, 'margin insufficient')), null);
});
