const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { installLBankOrderEvents, readLBankOrderEvent } = require('./lbank-order-events.cjs');

const identity = 'a'.repeat(64), otherIdentity = 'b'.repeat(64);
const order = { orderId: '1008009397092400', symbol: 'BTCUSDT', quantity: .0025, side: 'BUY' };
const event = (overrides = {}) => ({ orderSysID: order.orderId, instrumentID: order.symbol, volume: .0025, volumeTraded: .0025,
  orderStatus: '1', direction: '0', tradePrice: 79142.7, updateTime: 123, ...overrides });

function pageFixture({ available = true } = {}) {
  const listeners = new Set(); let subscriptions = 0, unsubscriptions = 0;
  const observer = { observeMessage(callback) { subscriptions++; listeners.add(callback); return () => { unsubscriptions++; listeners.delete(callback); }; },
    start() { throw new Error('Must not open sockets'); }, subscribe() { throw new Error('Must not subscribe private channels'); } };
  const require = id => { assert.equal(String(id), 'unexpected-module-id'); return { A: observer }; };
  require.m = available ? { 'unexpected-module-id': () => 'observeMessage WS_MESSAGES_PARSED_BATCH' } : {};
  const chunks = []; chunks.push = args => args[2](require);
  const context = vm.createContext({ self: { webpackChunk_N_E: chunks }, Date, Math });
  const install = vm.runInContext(`(${installLBankOrderEvents.toString()})`, context);
  const read = vm.runInContext(`(${readLBankOrderEvent.toString()})`, context);
  return { context, install, read,
    emit: (row, fields = {}) => { for (const callback of listeners) callback({ topic: 12, type: 4, data: [row], ...fields }); },
    subscriptions: () => subscriptions, unsubscriptions: () => unsubscriptions,
    size: scope => vm.runInContext(`self[Symbol.for('hedge.lbank.order-events.v1')].scopes.get(${JSON.stringify(scope)}).orders.size`, context),
  };
}

test('passive observer discovers the module semantically, installs once and retains exact sanitized terminal receipts', () => {
  const f = pageFixture();
  assert.equal(f.install('scope', identity).state, 'ready');
  assert.equal(f.install('scope', identity).state, 'ready'); assert.equal(f.subscriptions(), 1);
  f.emit(event({ accountID: 'PRIVATE_ACCOUNT', token: 'PRIVATE_TOKEN' }));
  const result = f.read('scope', identity, order);
  assert.equal(result.state, 'matched'); assert.equal(result.row.OrderSysID, order.orderId);
  assert.equal(result.row.VolumeTraded, .0025); assert.equal(result.row.TradePrice, 79142.7);
  assert.equal(typeof result.receivedAt, 'number'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  result.row.OrderStatus = '4';
  assert.equal(f.read('scope', identity, order).row.OrderStatus, '1', 'read returns a copy');
});

test('terminal execution remains available after stale NEW and regressing partial messages', () => {
  const f = pageFixture(); f.install('s', identity);
  f.emit(event({ orderStatus: '2', volumeTraded: .001 }));
  f.emit(event({ orderStatus: '4', volumeTraded: 0, tradePrice: 0 }));
  assert.equal(f.read('s', identity, order).row.VolumeTraded, .001);
  f.emit(event());
  f.emit(event({ orderStatus: '2', volumeTraded: .001 }));
  f.emit(event({ orderStatus: '4', volumeTraded: 0 }));
  assert.equal(f.read('s', identity, order).row.OrderStatus, '1');
  assert.equal(f.read('s', identity, order).row.VolumeTraded, .0025);
});

test('contradictory terminal states, quantities or prices stay unresolved instead of guessing a fill', () => {
  for (const changed of [{ orderStatus: '6', volumeTraded: 0 }, { tradePrice: 79000 }, { volume: .003, volumeTraded: .003 }]) {
    const f = pageFixture(); f.install('s', identity); f.emit(event()); f.emit(event(changed));
    assert.equal(f.read('s', identity, order).state, 'conflict');
    f.emit(event()); assert.equal(f.read('s', identity, order).state, 'conflict');
  }
});

test('receipt identity, symbol, direction and quantity must exactly match the requested order', () => {
  const f = pageFixture(); f.install('s', identity); f.emit(event());
  for (const args of [{ ...order, side: 'SELL' }, { ...order, symbol: 'ETHUSDT' }, { ...order, quantity: .002 }, { ...order, quantity: true }, { ...order, orderId: 9007199254740992 }]) assert.equal(f.read('s', identity, args).state, 'conflict');
  assert.equal(f.read('s', otherIdentity, order).state, 'conflict');
  assert.equal(f.read('other-scope', identity, order).state, 'unavailable');
  assert.equal(f.install('s', otherIdentity).state, 'mismatch');
  assert.equal(f.read('s', identity, order).state, 'matched');
});

test('invalid events and public deals cannot become private-order execution proof', () => {
  const f = pageFixture(); f.install('s', identity);
  f.emit(event(), { topic: 4 }); f.emit(event(), { type: 1 });
  for (const changed of [{ orderSysID: 9007199254740992 }, { volumeTraded: -.1 }, { volumeTraded: .003 }, { volumeTraded: .001 }, { volume: true }, { direction: 'NET' }, { instrumentID: 'BTC' }]) f.emit(event(changed));
  assert.equal(f.read('s', identity, order).state, 'missing');
  f.emit(event(), { type: 3 }); assert.equal(f.read('s', identity, order).state, 'matched');
});

test('cache bounds order rows and disconnects observers belonging to evicted scopes', () => {
  const f = pageFixture(); f.install('first', identity);
  for (let i = 0; i < 2002; i++) f.emit(event({ orderSysID: `order-${i}` }));
  assert.equal(f.size('first'), 2000);
  assert.equal(f.read('first', identity, { ...order, orderId: 'order-0' }).state, 'missing');
  for (let i = 0; i < 4; i++) f.install(`scope-${i}`, identity);
  assert.equal(f.unsubscriptions(), 1);
  assert.equal(f.read('first', identity, order).state, 'unavailable');
});

test('missing observer and unbound account fail closed without initiating another connection', () => {
  const f = pageFixture({ available: false });
  assert.equal(f.install('s', identity).state, 'unavailable');
  assert.equal(f.install('s', null).state, 'unavailable');
  assert.equal(f.read('s', identity, order).state, 'unavailable'); assert.equal(f.subscriptions(), 0);
});

test('real browser integration installs immediately after account bind and before every retained command', async () => {
  const page = pageFixture();
  const commands = [], evaluations = [];
  const module = { exports: {} };
  const execute = async function(operation, args, expectedIdentity, requestContext) {
    self.commands.push({ operation, expectedIdentity, requestContext, observerReady: self[Symbol.for('hedge.lbank.order-events.v1')]?.read(requestContext.scope, expectedIdentity, args).state });
    if (operation === 'account') return { ok: true, identity: 'a'.repeat(64), value: { available: 10 } };
    return { ok: true, value: { orderId: args.orderId || '1008009397092400', clientOrderId: args.clientOrderId } };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'lbank-browser.cjs'), 'utf8'), {
    module, URL, URLSearchParams, Buffer, setTimeout,
    require(name) {
      if (name === './lbank-web-sdk.cjs') return { executeFuturesCommand: execute };
      return require(name);
    },
  });
  page.context.self.commands = commands;
  const { LBankBrowser } = module.exports, browser = new LBankBrowser();
  const credentials = { connectionMode: 'undetectable', undetectableProfileId: 'fixture' };
  browser.connection = { closed: false, send: async (_name, args) => { evaluations.push(args.expression); return { result: { value: await vm.runInContext(args.expression, page.context) } }; } };
  browser.sessionId = 'session'; browser.key = browser.configKey(credentials);
  await browser.getAccount(credentials);
  assert.equal(page.subscriptions(), 1, 'listener exists before getAccount resolves');
  page.emit(event());
  assert.equal(page.read(browser.requestScope, identity, order).state, 'matched');
  await browser.getOrder(credentials, order);
  assert.equal(commands.at(-1).observerReady, 'matched');
  assert.equal(commands.at(-1).requestContext.requireOrderEvents, true);
  assert.equal(page.subscriptions(), 1);
  assert.equal(evaluations.length, 3, 'account plus post-bind install, then one retained read');
});
