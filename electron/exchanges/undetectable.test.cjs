const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { localUrl, listProfiles, isFuturesPage, CdpConnection } = require('./undetectable.cjs');
const { LBankBrowser, readFuturesAccount, readFuturesRecords } = require('./lbank-browser.cjs');
const { testExchangeAccounts } = require('./connection-pool.cjs');
const credentials = { connectionMode: 'undetectable', undetectableProfileId: 'test' };
test('protocol failures preserve safe method/code/reason, without leaking source or credentials', async () => {
  class Socket extends EventTarget {
    readyState = 1;
    send(payload) { this.last = JSON.parse(payload); }
    reply(error) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({id:this.last.id,error})})); }
  }
  const socket = new Socket(), connection = new CdpConnection(socket);
  const pending = connection.send('Runtime.evaluate', {expression:'PRIVATE_SOURCE'});
  socket.reply({code:-32000,message:'Promise was collected',data:'PRIVATE_DATA'});
  await assert.rejects(pending, e => e.cdpReason==='promise_collected' && e.cdpCode===-32000 && e.cdpMethod==='Runtime.evaluate' && !JSON.stringify(e).includes('PRIVATE') && /освободил/.test(e.message));
  const unknown = connection.send('Runtime.evaluate');
  socket.reply({code:-32000,message:'PRIVATE_TOKEN https://private.example/?secret=123',data:'PRIVATE'});
  await assert.rejects(unknown,e => /ошибка протокола/.test(e.message) && !e.message.includes('PRIVATE') && e.definitive!==true);
  assert.equal(connection.pending.size,0);
});
test('CDP events are delivered only to active listeners and never consume command responses', async () => {
  class Socket extends EventTarget { readyState = 1; send(payload) { this.last = JSON.parse(payload); } }
  const socket = new Socket(), connection = new CdpConnection(socket), events = [];
  const unsubscribe = connection.onEvent(value => events.push(value));
  socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({method:'Network.requestWillBeSent',sessionId:'tab',params:{requestId:'1'}})}));
  assert.equal(events.length,1); assert.equal(events[0].sessionId,'tab');
  const pending = connection.send('Network.enable');
  socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({id:socket.last.id,result:{enabled:true}})}));
  assert.deepEqual(await pending,{enabled:true}); assert.equal(events.length,1);
  unsubscribe();
  socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({method:'Network.loadingFinished',params:{requestId:'1'}})}));
  assert.equal(events.length,1);
});
test('CDP and API reject remote hosts, userinfo, tokens and missing ports', () => {
  for (const url of ['https://example.com:99', 'http://127.0.0.1', 'http://user:pass@127.0.0.1:99', 'ws://127.0.0.1:99/?token=abc', 'file:///tmp']) assert.throws(() => localUrl(url, true));
  assert.equal(localUrl('http://127.0.0.1:25325/'), 'http://127.0.0.1:25325');
  assert.equal(isFuturesPage('https://www.lbank.com/trade/btc_usdt'), false);
  assert.equal(isFuturesPage('https://evil.test/futures/btcusdt'), false);
  assert.equal(isFuturesPage('https://www.lbank.com/futures/btcusdt'), true);
});
test('listing profiles performs exactly one read, with redirects forbidden', async () => {
  const seen = [];
  const list = await listProfiles(undefined, async (url, options) => { seen.push([url, options.redirect]); return { ok: true, text: async () => JSON.stringify({ code: 0, status: 'success', data: { test: { name: 'Test', status: 'Started', debug_port: 9999 } } }) }; });
  assert.deepEqual(seen, [['http://127.0.0.1:25325/list', 'error']]); assert.equal(list[0].endpoint, 'http://127.0.0.1:9999');
});
test('automatic connection pool never attaches Undetectable even with saved settings', async () => {
  let calls = 0;
  const result = await testExchangeAccounts(['lbank'], { lbank: credentials }, () => ({ getAccount: () => { calls++; } }));
  assert.equal(calls, 0); assert.equal(result.lbank.manual, true);
});
test('account reads cannot auto-connect; stopped profiles are never launched', async () => {
  let connections = 0;
  const b = new LBankBrowser({ profiles: async () => [{ id: 'test', status: 'Available' }], connect: async () => { connections++; } });
  await assert.rejects(b.getAccount(credentials), /вручную/);
  await assert.rejects(b.connect(credentials), /Сначала запустите/);
  assert.equal(connections, 0);
});
test('manual attach selects Futures only and disconnect leaves the browser running', async () => {
  const calls = []; let disconnected = false;
  const b = new LBankBrowser({ profiles: async () => [{ id: 'test', status: 'Started', endpoint: 'ws://127.0.0.1:9999/devtools/browser/test' }], connect: async () => ({ closed: false,
    close: () => { disconnected = true; }, send: async (method, params) => { calls.push(method); if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'future', type: 'page', url: 'https://www.lbank.com/futures/btcusdt' }, { targetId: 'spot', type: 'page', url: 'https://www.lbank.com/trade/btc_usdt' }] }; if (method === 'Target.attachToTarget') { assert.equal(params.targetId, 'future'); return { sessionId: 's' }; } return { result: { value: params.expression.includes('hedge_sdk_') ? { ok: true, value: { total: 0, available: 0 }, identity:'a'.repeat(64) } : true } }; }
  }) });
  assert.deepEqual(await b.connect(credentials), { total: 0, available: 0 }); b.disconnect();
  assert.equal(disconnected, true); assert.equal(calls.includes('Browser.close'), false); assert.equal(calls.includes('Target.createTarget'), false);
  await assert.rejects(b.getAccount(credentials), /вручную/);
});
test('browser account uses verified SettlementGroup parameters and returns no private identifiers', async () => {
  const account = async params => { const endpoint = '/cfd/query/v1.0/Account'; assert.equal(params.SettlementGroup, 'SwapU'); assert.equal(params.isSubAccount, 0); return { data: [{ Currency: 'USDT', Available: '12.34', Balance: '20', UserID: 'private', secret: 'never-return' }] }; };
  // Preserve the exact endpoint literal expected by the page module locator.
  const api = { account };
  account.toString = () => 'function(params){ return read("/cfd/query/v1.0/Account",params); }';
  const require = () => api; require.m = { 1: () => '/cfd/query/v1.0/Account /cfd/cff/v1/SendOrderInsert' };
  const value = await vm.runInNewContext(`(${readFuturesAccount.toString()})()`, { location: { origin: 'https://www.lbank.com', pathname: '/futures/btcusdt' }, self: { webpackChunk_N_E: { push: () => {} } } }).catch(() => null);
  assert.equal(value.ok, false);
  const chunks = []; chunks.push = chunk => chunk[2](require);
  const result = await vm.runInNewContext(`(${readFuturesAccount.toString()})()`, { location: { origin: 'https://www.lbank.com', pathname: '/futures/btcusdt' }, self: { webpackChunk_N_E: chunks } });
  assert.equal(result.ok, true); assert.equal(result.account.available, 12.34); assert.equal(JSON.stringify(result).includes('private'), false);
});

test('disconnect during profile listing cannot attach later; new instance never restores a connection', async () => {
  let release, calls = 0;
  const b = new LBankBrowser({ profiles: () => new Promise(resolve => { release = resolve; }), connect: async () => { calls++; } });
  const pending = b.connect(credentials);
  b.disconnect(); release([{id:'test',status:'Started',endpoint:'ws://127.0.0.1:9999'}]);
  await assert.rejects(pending, /отменено/); assert.equal(calls, 0);
  const restarted = new LBankBrowser();
  assert.equal(restarted.isConnected(credentials), false);
  await assert.rejects(restarted.getPositions(credentials), /вручную/);
});

function pageApi(api) {
  const require = () => api;
  require.m = { 1: () => '/cfd/query/v1.0/Account /cfd/cff/v1/SendOrderInsert' };
  const chunks = []; chunks.push = chunk => chunk[2](require);
  return { location: { origin:'https://www.lbank.com',pathname:'/futures/btcusdt' }, self:{webpackChunk_N_E:chunks} };
}
function sdkMethod(path, result, calls) {
  const fn = async params => { calls.push([path,params]); return result; };
  fn.toString = () => `function(p){return read(${JSON.stringify(path)},p)}`;
  return fn;
}
test('read-only records cover ordinary and conditional orders and omit private fields', async () => {
  const calls = [];
  const api = {
    order: sdkMethod('/cfd/query/v1.0/Order', {data:[{InstrumentID:'BTCUSDT',Direction:'0',OrderSysID:'203224940138643900',VolumeRemain:'2',Price:'80000',OrderPriceType:'0',OrderStatus:'4',AccountID:'PRIVATE'}]}, calls),
    trigger: sdkMethod('/cfd/query/v1.0/TriggerOrder', {data:[]}, calls),
    catalog: {cfdAggV1Instrument: async () => [{instrument:{instrumentID:'BTCUSDT',volumeMultiple:'0.001',isInverse:0}}]},
  };
  const result = await vm.runInNewContext(`(${readFuturesRecords.toString()})('orders')`, pageApi(api));
  assert.equal(result.ok,true); assert.equal(result.records.length,1); assert.equal(result.records[0].quantity,.002);
  assert.equal(result.records[0].id,'lbank:0:203224940138643900'); assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  assert.deepEqual(calls.map(c => c[1].TriggerOrderType),[undefined,'3','12']);
});
test('unknown and truncated record responses remain errors, not fake empty lists', async () => {
  for (const value of [{error:'unauthorized'},Array(1000).fill({})]) {
    const api = {positions:sdkMethod('/cfd/query/v1.0/Position',value,[])};
    const result = await vm.runInNewContext(`(${readFuturesRecords.toString()})('positions')`,pageApi(api));
    assert.equal(result.ok,false);
  }
});
test('position units normalize with contract multiplier and missing PnL stays unknown', async () => {
  const api = {positions:sdkMethod('/cfd/query/v1.0/Position',[{InstrumentID:'BTCUSDT',Direction:'1',Position:'2',OpenPrice:'80000',AccountID:'PRIVATE'}],[]),
    catalog:{cfdAggV1Instrument:async()=>[{instrument:{instrumentID:'BTCUSDT',volumeMultiple:'.001',isInverse:0},marketData:{markedPrice:'80100'}}]}};
  const result = await vm.runInNewContext(`(${readFuturesRecords.toString()})('positions')`,pageApi(api));
  assert.equal(result.ok,true); assert.equal(result.records[0].quantity,.002); assert.equal(result.records[0].side,'short');
  assert.equal(result.records[0].unrealizedPnl,null); assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
