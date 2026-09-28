const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lbank = require('./lbank.cjs');

// Exercise production signing/routing without a real key, browser or exchange.
function fixture(request, browser = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'lbank.cjs'), 'utf8'), {
    module, URL, URLSearchParams, Buffer,
    require(name) {
      if (name === './transport.cjs') return { requestJson: request };
      if (name === './lbank-browser.cjs') return { manualMode: c => c?.connectionMode === 'undetectable', browser };
      return require(name);
    },
  });
  return module.exports;
}

test('LBank signs GET account with required JSON headers and one request', async () => {
  const calls = [];
  const adapter = fixture(async (url, options) => {
    calls.push({ url: new URL(url), options });
    return { result: 'true', success: true, data: { asset: 'USDT', availableBalance: '0', equity: '100' } };
  });
  const account = await adapter.getAccount({ apiKey: 'test-api', secret: 'test-secret' });
  assert.equal(account.available, 0);
  assert.equal(account.total, 100);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url.origin, 'https://lbkperp.lbank.com');
  assert.equal(url.pathname, '/cfd/openApi/v1/prv/account');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.headers.accept, 'application/json');
  const signed = Object.fromEntries(url.searchParams);
  delete signed.sign;
  for (const key of ['timestamp', 'echostr', 'signature_method']) signed[key] = options.headers[key];
  assert.equal(url.searchParams.get('sign'), lbank.sign(signed, 'test-secret'));
  assert.equal(url.searchParams.has('secret'), false);
});

test('private API 403 directs to supported profile connection without changing mode or retrying', async () => {
  let calls = 0, browserCalls = 0;
  const denial = Object.assign(new Error('HTTP 403'), { code: 'API_ACCESS_DENIED', httpStatus: 403, endpoint: 'https://lbkperp.lbank.com/cfd/openApi/v1/prv/account' });
  const adapter = fixture(async () => { calls++; throw denial; }, { getAccount: async () => { browserCalls++; } });
  const credentials = { connectionMode: 'official', apiKey: 'test-api', secret: 'test-secret' };
  await assert.rejects(adapter.getAccount(credentials), error => {
    assert.equal(error, denial);
    assert.equal(error.code, 'LBANK_PRIVATE_API_ACCESS_DENIED');
    assert.equal(error.httpStatus, 403);
    assert.match(error.message, /Undetectable · CDP/);
    assert.notEqual(error.definitive, true);
    return true;
  });
  assert.equal(credentials.connectionMode, 'official');
  assert.equal(calls, 1);
  assert.equal(browserCalls, 0);
});

test('LBank treats string false as API failure, never a connected zero balance', async () => {
  const adapter = fixture(async () => ({ result: 'false', msg: 'API access unavailable' }));
  await assert.rejects(adapter.getAccount({ apiKey: 'test', secret: 'test' }), /API access unavailable/);
});

test('account connection requires real USDT available and total values', () => {
  for (const payload of [null, {}, { data: [] }, { data: [{ asset: 'BTC', available: 1, balance: 1 }] },
    { data: { available: '', balance: '1' } }, { data: { available: true, balance: 1 } },
    { data: { available: 1, balance: 'NaN' } }, { data: { balance: 1 } }]) {
    assert.throws(() => lbank.normalizeAccount(payload), error => error.code === 'LBANK_ACCOUNT_INVALID_RESPONSE');
  }
  const account = lbank.normalizeAccount({ data: [{ asset: 'BTC', available: '9', balance: '9' }, { asset: 'USDT', available: '0', balance: '0' }] });
  assert.equal(account.available, 0);
  assert.equal(account.total, 0);
});

test('manual mode connects through the selected browser and passes own-position close plans', async () => {
  const credentials = { connectionMode: 'undetectable', undetectableProfileId: 'test-profile' };
  const request = { symbol: 'BTCUSDT', side: 'SELL', quantity: 0.03 };
  const expected = [{ positionId: 'first', quantity: 0.01 }, { positionId: 'second', quantity: 0.02 }];
  const adapter = fixture(() => { throw new Error('Official API must not be used'); }, {
    getAccount: async c => { assert.equal(c, credentials); return { available: 10 }; },
    getClosePlan: async (c, r) => { assert.equal(c, credentials); assert.equal(r, request); return expected; },
  });
  assert.equal((await adapter.getAccount(credentials)).available, 10);
  assert.equal(await adapter.getClosePlan(credentials, request), expected);
});
