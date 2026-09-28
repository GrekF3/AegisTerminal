const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ImpulseEngine, StateStore } = require('./engine.cjs');

class FakeHub extends EventEmitter {
  start() { this.started = true; }
  stop() { this.started = false; }
  push(snapshot) { this.emit('market', snapshot); }
}

function fixtureBrowser() {
  const state = { connected: false, hasPosition: false, protectionActive: false, placed: [], canceled: [], protections: [], leverage: [] };
  const browser = {
    state,
    async connect() { state.connected = true; return { asset: 'USDT', available: 1000, total: 1000 }; },
    disconnect() { state.connected = false; },
    async getMarkets() { return [{ symbol: 'TESTUSDT', lastPrice: 100 }]; },
    async getTradingRules() { return { quantityStep: .01, minQuantity: .01, minNotional: 5, maxQuantity: 1000, tickSize: .01, contractSize: 1, maxLeverage: 100 }; },
    async getFeeRates() { return { TESTUSDT: { makerFee: .0002, takerFee: .0006, source: 'account' } }; },
    async getAccount() { return { asset: 'USDT', available: 1000, total: 1000 }; },
    async getPositions() { return state.hasPosition ? [{ symbol: 'TESTUSDT', side: 'long', quantity: 1, id: 'position-1' }] : []; },
    async getOpenOrders() { return []; },
    async configureLeverage(_c, request) { state.leverage.push(request); return request; },
    async placeOrder(_c, order) {
      state.placed.push({ ...order });
      if (order.reduceOnly) state.hasPosition = false;
      return { orderId: order.reduceOnly ? `close-${state.placed.length}` : `entry-${state.placed.length}` };
    },
    async getOrder(_c, order) { return { ...order, status: 'FILLED', executedQty: order.quantity, avgPrice: order.reduceOnly ? 100.1 : order.price, fee: 0.01 }; },
    async cancelOrder(_c, order) { state.canceled.push(order); return { orderId: order.orderId, cancelRequested: true }; },
    async placeProtection(_c, request) { state.protectionActive = true; state.protections.push({ action: 'place', ...request }); return { orderId: 'guard-1', status: 'PENDING' }; },
    async getProtection(_c, request) {
      if (!state.protectionActive) throw Object.assign(new Error('protection not found'), { code: 'PROTECTION_NOT_FOUND', definitive: true });
      return { ...request, status: 'PENDING' };
    },
    async cancelProtection(_c, request) { state.protectionActive = false; state.protections.push({ action: 'cancel', ...request }); return { orderId: request.orderId, cancelRequested: true }; },
    async getClosePlan(_c, request) { return [{ positionId: 'position-1', quantity: request.quantity }]; },
  };
  return browser;
}

function tempDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lbank-impulse-engine-')); }
const reference = { leader: 'binance', hasBinance: true, hasMexc: true, mexcSymbol: 'TEST_USDT', mexcMultiplier: 1 };

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('test condition timed out');
}

test('durable journal and replay remain separate and replay closes with a summary', () => {
  const directory = tempDirectory();
  try {
    const store = new StateStore(directory); store.journal({ type: 'order', orderId: '1' });
    const replay = store.startReplay({ config: { symbol: 'TESTUSDT' } });
    store.recordReplay({ type: 'market', at: 1000, market: { leader: 'binance' } });
    assert.equal(store.endReplay({ reason: 'test' }), replay);
    assert.deepEqual(fs.readFileSync(store.journalFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse), [{ type: 'order', orderId: '1' }]);
    const replayRows = fs.readFileSync(replay, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(replayRows.map(row => row.type), ['meta', 'market', 'end']); assert.equal(replayRows.at(-1).reason, 'test');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('draft fields survive restart and connected symbol search is normalized', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser();
  const engine = new ImpulseEngine({ browser, stateDirectory: directory });
  try {
    const saved = engine.saveDraft({ symbol: 'eth_usdt', nominal: 75.5, leverage: 17, impulsePercent: 0.006, cooldownSeconds: 42, mode: 'live', profileId: 'profile_2' });
    assert.deepEqual({ symbol: saved.settings.symbol, nominal: saved.settings.nominal, leverage: saved.settings.leverage,
      impulsePercent: saved.settings.impulsePercent, cooldownSeconds: saved.settings.cooldownSeconds, mode: saved.settings.mode,
      paperFast: saved.settings.paperFast, profileId: saved.settings.profileId }, {
      symbol: 'ETHUSDT', nominal: 75.5, leverage: 17, impulsePercent: 0.006, cooldownSeconds: 42, mode: 'live', paperFast: false, profileId: 'profile_2' });
    assert.deepEqual(saved.settingsProfile.symbols.ETHUSDT, { nominal: 75.5, leverage: 17, impulsePercent: 0.006, cooldownSeconds: 42 });
    await engine.connect('profile_2');
    assert.deepEqual(await engine.listSymbols(), ['TESTUSDT']);
  } finally {
    await engine.shutdown();
  }
  const restored = new ImpulseEngine({ browser: fixtureBrowser(), stateDirectory: directory });
  try {
    const restoredState = restored.publicState();
    assert.equal(restoredState.settings.symbol, 'ETHUSDT'); assert.equal(restoredState.settings.leverage, 17); assert.equal(restoredState.settings.minimumHoldMs, 2000);
    assert.deepEqual(restoredState.settingsProfile.symbols.ETHUSDT, { nominal: 75.5, leverage: 17, impulsePercent: 0.006, cooldownSeconds: 42 });
  } finally {
    await restored.shutdown(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('global settings and symbol overrides persist independently and can be reset', async () => {
  const directory = tempDirectory(), engine = new ImpulseEngine({ browser: fixtureBrowser(), stateDirectory: directory });
  try {
    let saved = engine.saveDraft({ globalSettings: { minimumHoldMs: 1500, reversalPercent: .04, maxHoldSeconds: 30 } });
    assert.equal(saved.settings.minimumHoldMs, 1500); assert.equal(saved.settings.reversalPercent, .04);
    saved = engine.saveDraft({ symbol: 'TESTUSDT', settingsSymbol: 'TESTUSDT', symbolSettings: { impulsePercent: .03, minimumHoldMs: 2500 } });
    assert.equal(saved.settings.impulsePercent, .03); assert.equal(saved.settings.minimumHoldMs, 2500); assert.equal(saved.settings.maxHoldSeconds, 30);
    saved = engine.saveDraft({ symbol: 'BTCUSDT' });
    assert.equal(saved.settings.impulsePercent, .04); assert.equal(saved.settings.minimumHoldMs, 1500);
    saved = engine.saveDraft({ symbol: 'TESTUSDT', settingsSymbol: 'TESTUSDT', resetSymbolSettings: true });
    assert.equal(saved.settings.impulsePercent, .04); assert.equal(saved.settings.minimumHoldMs, 1500); assert.equal(saved.settingsProfile.symbols.TESTUSDT, undefined);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('switching symbols never inherits the previous coin cooldown', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), engine = new ImpulseEngine({ browser, stateDirectory: directory,
    referenceResolver: async () => reference, hubFactory: () => new FakeHub() });
  browser.getMarkets = async () => [{ symbol: 'TESTUSDT', lastPrice: 100 }, { symbol: 'OTHERUSDT', lastPrice: 100 }];
  browser.getFeeRates = async () => ({
    TESTUSDT: { makerFee: .0002, takerFee: .0006, source: 'account' },
    OTHERUSDT: { makerFee: .0002, takerFee: .0006, source: 'account' },
  });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'paper' });
    engine.gate.closed(1000); assert.equal(engine.gate.canEnter(181000), false);
    await engine.configure({ symbol: 'OTHERUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'paper' });
    assert.equal(engine.gate.canEnter(1000), true);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy flat settings migrate into the active symbol without contaminating global defaults', async () => {
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ symbol: 'ZECUSDT', profileId: 'p1', mode: 'paper', paperFast: false,
    nominal: 50, leverage: 1, impulsePercent: .03, cooldownSeconds: 0 }));
  const engine = new ImpulseEngine({ browser: fixtureBrowser(), stateDirectory: directory });
  try {
    const state = engine.publicState();
    assert.equal(state.settings.symbol, 'ZECUSDT'); assert.equal(state.settings.leverage, 1); assert.equal(state.settings.impulsePercent, .03);
    assert.equal(state.settings.minimumHoldMs, 2000); assert.equal(state.settings.minimumTrailNetPercent, 0);
    assert.equal(state.settingsProfile.global.leverage, 5); assert.equal(state.settingsProfile.symbols.ZECUSDT.leverage, 1);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('ordinary strategy blocks a positive lag that cannot cover both fees', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub(); let clock = 0;
  browser.getFeeRates = async () => ({ TESTUSDT: { makerFee: .01, takerFee: .01, source: 'account' } });
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, now: () => clock, sleeper: async ms => { clock += ms; await Promise.resolve(); },
    referenceResolver: async () => reference, hubFactory: () => hub,
    defaults: { warmupMs: 0, basisHalfLifeMs: 30000, minimumHoldMs: 0, trailingActivationBps: 100, minimumTrailNetBps: -1000,
      reversalBps: 2, reversalHoldMs: 0, cooldownMs: 180000 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'paper' }); await engine.start();
    assert.equal(engine.state.sessionSymbol, 'TESTUSDT');
    assert.equal(engine.state.phase, 'waiting', 'zero warmup must not show a fake basis warmup phase');
    hub.push({ quotes: { binance: { bid: 99.99, ask: 100.01, mid: 100, receivedAt: 0 } }, books: { lbank: { bids: [[98.99, 10]], asks: [[99.01, 10]], receivedAt: 0 } } });
    clock = 1000;
    hub.push({ quotes: { binance: { bid: 100.05, ask: 100.07, mid: 100.06, receivedAt: 1000 } }, books: { lbank: { bids: [[98.8, 10]], asks: [[98.82, 10]], receivedAt: 1000 } } });
    assert.equal(engine.evaluation?.eligible, false, JSON.stringify(engine.evaluation));
    assert.equal(engine.evaluation?.feesCovered, false);
    assert.equal(engine.state.activeOrder, null); assert.equal(engine.state.position, null);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Paper Test confirms a visible synthetic fill only after a fresh book and delay', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(); let clock = 0;
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, now: () => clock, referenceResolver: async () => reference, hubFactory: () => new FakeHub() });
  try {
    await engine.connect('profile_1');
    await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 1, impulsePercent: 0.0001, cooldownSeconds: 0, mode: 'paper', paperFast: true });
    engine.state.activeOrder = { symbol: 'TESTUSDT', side: 'BUY', quantity: 1, price: 100, detectedAt: 0, expiresAt: 1000, status: 'NEW', executedQty: 0, mode: 'paper', paperFast: true };
    engine.latest = { books: { lbank: { bids: [[99.99, 10]], asks: [[100.01, 10]], receivedAt: 1 } } };
    engine.updatePaperFill(); assert.equal(engine.state.activeOrder.status, 'NEW');
    clock = 300; engine.latest.books.lbank.receivedAt = 300; engine.updatePaperFill();
    assert.equal(engine.state.activeOrder.status, 'FILLED'); assert.equal(engine.state.activeOrder.executedQty, 1);
  } finally {
    engine.state.activeOrder = null; await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary Paper takes an aggressive LIMIT only when the visible book covers the full zero-impact quantity', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub(); let clock = 0;
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, now: () => clock, sleeper: async ms => { clock += ms; await Promise.resolve(); },
    referenceResolver: async () => reference, hubFactory: () => hub,
    defaults: { warmupMs: 0, marketEntryImpulseMultiplier: 1, depthSafetyMultiplier: 2, maxEntrySlippageBps: 0 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 100, cooldownSeconds: 0, mode: 'paper' }); await engine.start();
    hub.push({ quotes: { binance: { bid: 99.99, ask: 100.01, mid: 100, receivedAt: 0 } }, books: { lbank: { bids: [[98.99, 20]], asks: [[99.01, 20]], receivedAt: 0 } } });
    clock = 1000;
    hub.push({ quotes: { binance: { bid: 100.05, ask: 100.07, mid: 100.06, receivedAt: clock } }, books: { lbank: { bids: [[98.8, 20]], asks: [[98.82, 20]], receivedAt: clock } } });
    assert.equal(engine.evaluation?.entryType, 'LIMIT', JSON.stringify(engine.evaluation)); assert.equal(engine.evaluation?.postOnly, false);
    assert.equal(engine.evaluation?.entryImpactBps, 0); assert.ok(engine.evaluation?.depthCoverage >= 2);
    await waitFor(() => Boolean(engine.state.position));
    assert.equal(engine.state.position.entryType, 'LIMIT'); assert.equal(engine.state.position.postOnly, false); assert.equal(browser.state.placed.length, 0);
    assert.ok(Math.abs(engine.state.position.entryFee - engine.state.position.avgPrice * engine.state.position.quantity * .0006) < 1e-10);
    await engine.flatten('test_cleanup');
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('automatic Live sizing cannot exceed the configured loss budget even after a deep-book signal', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub();
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub,
    lockFactory: () => ({ release() {} }), defaults: { warmupMs: 0 } });
  try {
    await engine.connect('profile_1');
    await engine.configure({ symbol: 'TESTUSDT', mode: 'live', autoPosition: true, maxLossPercent: 1, adversePercent: .08 });
    const budget = engine.config.automaticBudget;
    assert.equal(engine.config.leverage, 100); assert.equal(budget.riskBudget, 10); assert.equal(budget.hardStopBps, 24);
    assert.ok(budget.plannedLoss <= budget.riskBudget); assert.ok(engine.config.nominal < 3000);
    await engine.start();
    await assert.rejects(engine.beginEntry({ side: 'BUY', quantity: 100, entryPrice: 100, detectedAt: Date.now(), leaderEntry: 100 }),
      error => error.code === 'RISK_LIMIT_EXCEEDED');
    assert.equal(browser.state.placed.length, 0);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('live lifecycle uses isolated leverage, exact protection and reduce-only market close', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub(); let released = 0;
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub,
    lockFactory: () => ({ release() { released++; } }), defaults: { warmupMs: 0 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'live' }); await engine.start();
    assert.deepEqual(browser.state.leverage[0], { symbol: 'TESTUSDT', leverage: 5, marginMode: 'isolated' });
    browser.state.hasPosition = true;
    engine.latest = { quotes: { binance: { bid: 100.09, ask: 100.11, mid: 100.1, receivedAt: Date.now() } }, books: { lbank: { bids: [{ price: 100.09, quantity: 10 }], asks: [{ price: 100.11, quantity: 10 }], receivedAt: Date.now() } } };
    await engine.establishPosition({ symbol: 'TESTUSDT', side: 'BUY', quantity: 1, price: 100, leaderEntry: 100, mode: 'live', orderId: 'entry-1', clientOrderId: 'intent-1' }, { status: 'FILLED', executedQty: 1, avgPrice: 100 });
    assert.equal(engine.state.protection.stopLossPrice, 99.91); assert.equal(engine.state.protection.takeProfitPrice, 101);
    await engine.closePosition('test_close');
    const close = browser.state.placed.find(order => order.reduceOnly);
    assert.equal(close.type, 'MARKET'); assert.equal(close.side, 'SELL'); assert.equal(close.positionId, 'position-1'); assert.equal(close.quantity, 1);
    assert.equal(engine.state.position, null); assert.equal(engine.state.protection, null);
    await engine.pause(); assert.equal(released, 1);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('simultaneous STOP and trailing exit share one exact reduce-only close', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub(); let releasePlan, planCalls = 0;
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub,
    lockFactory: () => ({ release() {} }), defaults: { warmupMs: 0 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'live' }); await engine.start();
    browser.state.hasPosition = true;
    engine.state.position = { symbol: 'TESTUSDT', side: 'BUY', quantity: 1, avgPrice: 100, openedAt: Date.now(), leaderEntry: 100, mode: 'live', entryFeeRate: .0006, entryFee: .06 };
    browser.getClosePlan = async (_credentials, request) => { planCalls++; await new Promise(resolve => { releasePlan = resolve; }); return [{ positionId: 'position-1', quantity: request.quantity }]; };
    const stopped = engine.closePosition('operator_interrupt');
    await waitFor(() => Boolean(releasePlan));
    const trailing = engine.closePosition('trailing_pullback');
    releasePlan(); await Promise.all([stopped, trailing]);
    assert.equal(planCalls, 1);
    assert.equal(browser.state.placed.filter(order => order.reduceOnly).length, 1);
    assert.equal(engine.state.position, null);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unknown entry acknowledgement blocks every retry and preserves recovery state', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub();
  browser.placeOrder = async () => { throw Object.assign(new Error('ack lost'), { definitive: false }); };
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub, lockFactory: () => ({ release() {} }), defaults: { warmupMs: 0 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'live' }); await engine.start();
    await engine.beginEntry({ side: 'BUY', quantity: 1, entryPrice: 99.99, detectedAt: Date.now(), leaderEntry: 100 }).catch(error => engine.handleOperationError(error));
    assert.equal(engine.state.requiresAttention, true); assert.equal(engine.state.activeOrder.clientOrderId.startsWith('imp_'), true); assert.equal(engine.state.phase, 'entry_unknown');
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); assert.equal(saved.activeOrder.clientOrderId, engine.state.activeOrder.clientOrderId);
  } finally { engine.state.activeOrder = null; engine.state.position = null; engine.state.recovery = null; await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unknown cancel acknowledgement is reconciled by order status without a second cancel', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(); let cancelCalls = 0, readCalls = 0;
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => new FakeHub(),
    sleeper: async () => {} });
  browser.cancelOrder = async () => { cancelCalls++; throw Object.assign(new Error('LBank: Request timed out [20300]'), { definitive: false, code: '20300' }); };
  browser.getOrder = async (_credentials, order) => ({ ...order, status: readCalls++ === 0 ? 'NEW' : 'CANCELED', executedQty: 0, avgPrice: null, fee: 0 });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, mode: 'live' });
    const order = { symbol: 'TESTUSDT', side: 'BUY', quantity: 1, price: 100, orderId: 'entry-1', status: 'NEW', mode: 'live' };
    engine.state.activeOrder = order;
    const terminal = await engine.cancelEntry('expired');
    assert.equal(terminal.status, 'CANCELED'); assert.equal(cancelCalls, 1);
  } finally { engine.state.activeOrder = null; await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('STOP during Live preflight prevents a late leverage write and strategy start', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub(); let releaseAccount, lockReleases = 0;
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub,
    lockFactory: () => ({ release() { lockReleases++; } }), defaults: { warmupMs: 0 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'live' });
    browser.getAccount = async () => new Promise(resolve => { releaseAccount = resolve; });
    const starting = engine.start(); await waitFor(() => Boolean(releaseAccount));
    await engine.flatten('test_stop'); releaseAccount({ asset: 'USDT', available: 1000, total: 1000 });
    await assert.rejects(starting, error => error.code === 'START_CANCELED');
    assert.equal(browser.state.leverage.length, 0); assert.equal(engine.state.running, false); assert.equal(engine.state.phase, 'paused'); assert.equal(lockReleases, 1);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unknown protection acknowledgement is reconciled by exact protection fields without a second write', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub();
  const originalGet = browser.getProtection;
  browser.placeProtection = async (_credentials, request) => {
    browser.state.protectionActive = true; browser.state.protections.push({ action: 'place', ...request });
    throw Object.assign(new Error('ack lost'), { definitive: false });
  };
  browser.getProtection = async (credentials, request) => request.orderId
    ? originalGet(credentials, request)
    : { ...request, orderId: 'guard-recovered', status: 'PENDING' };
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub,
    lockFactory: () => ({ release() {} }), defaults: { warmupMs: 0 } });
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'live' }); await engine.start();
    browser.state.hasPosition = true;
    await engine.establishPosition({ symbol: 'TESTUSDT', side: 'BUY', quantity: 1, price: 100, leaderEntry: 100, mode: 'live', orderId: 'entry-1', clientOrderId: 'intent-1' }, { status: 'FILLED', executedQty: 1, avgPrice: 100 });
    assert.equal(engine.state.protection.orderId, 'guard-recovered');
    assert.equal(browser.state.protections.filter(row => row.action === 'place').length, 1);
  } finally { if (engine.state.position) await engine.closePosition('test_cleanup'); await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('NO_POSITION is accepted only after a fresh flat snapshot and never invents PnL', async () => {
  const directory = tempDirectory(), browser = fixtureBrowser(), hub = new FakeHub(); const events = [];
  const engine = new ImpulseEngine({ browser, stateDirectory: directory, referenceResolver: async () => reference, hubFactory: () => hub,
    lockFactory: () => ({ release() {} }), defaults: { warmupMs: 0 } });
  engine.on('event', event => events.push(event));
  try {
    await engine.connect('profile_1'); await engine.configure({ symbol: 'TESTUSDT', nominal: 100, leverage: 5, cooldownSeconds: 180, mode: 'live' }); await engine.start();
    browser.state.hasPosition = true;
    engine.latest = { quotes: { binance: { bid: 100, ask: 100.02, mid: 100.01, receivedAt: Date.now() } }, books: { lbank: { bids: [{ price: 99.99, quantity: 10 }], asks: [{ price: 100.01, quantity: 10 }], receivedAt: Date.now() } } };
    await engine.establishPosition({ symbol: 'TESTUSDT', side: 'BUY', quantity: 1, price: 100, leaderEntry: 100, mode: 'live', orderId: 'entry-1', clientOrderId: 'intent-1' }, { status: 'FILLED', executedQty: 1, avgPrice: 100 });
    const normalPlace = browser.placeOrder;
    browser.placeOrder = async (credentials, order, live) => {
      if (order.reduceOnly) { browser.state.hasPosition = false; throw Object.assign(new Error('no position'), { code: 'NO_POSITION', definitive: true }); }
      return normalPlace(credentials, order, live);
    };
    await engine.closePosition('race_flat');
    const closed = events.filter(event => event.type === 'position' && event.action === 'closed').at(-1);
    assert.equal(engine.state.position, null); assert.equal(closed.result.pnlKnown, false); assert.equal(closed.result.net, null); assert.equal(engine.state.realizedNet, 0);
  } finally { await engine.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});
