const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const journalTools = require('./trading/local-stop-journal.cjs');

// Run the real Stop/Start handlers and journal bindings with only local temporary
// files. The mock adapters never execute trades or touch an Electron profile.
const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const between = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
const journalBindings = between('function journalPath()', 'function getLogger()');
const publish = between('function publishTradingState(value,', 'ipcMain.handle("trading:history"');
const start = between('ipcMain.handle("trading:start"', "ipcMain.handle('trading:reset-loss-limit'");
const stop = between('ipcMain.handle("trading:stop"', 'ipcMain.handle("profile:verify"');
const initialJournal = () => ({
  fingerprint: 'fingerprint-for-old-credentials', extraJournalMetadata: 'retained',
  snapshot: {
    id: 'session-1', strategy: 'continuous-intraday', source: 'a', target: 'lbank',
    state: 'emergency', active: true, requiresAttention: true, error: 'Undetectable disconnected',
    startedAt: 123, completedRounds: 0,
    runs: [{ id: 'coin-1', symbol: 'BTCUSDT', state: 'emergency', active: true, margin: 1,
      sourceOrders: [{ leg: 'source', orderId: '1008009351765676', status: 'UNKNOWN', executedQuantity: 0 }],
      targetOrders: [{ leg: 'target', orderId: 'known-fill', status: 'FILLED', executedQuantity: 1 }],
      closeOrders: [{ leg: 'target', orderId: 'pending-close', status: 'NEW', executedQuantity: 0 }],
    }],
  },
});

function fixture(t, { journal = initialJournal(), profile = null, adapters = {}, browser = null,
  credentials = { a: { apiKey: 'different' }, lbank: { profileId: 'different' } }, fingerprint = 'new-credential-fingerprint' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-stop-main-test-'));
  t.after(() => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('hedge-stop-main-test-')) throw new Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'hedge-session.json');
  if (journal) fs.writeFileSync(file, JSON.stringify(journal));
  const ipc = new Map(), history = [], renderer = [];
  let credentialReads = 0, adapterReads = 0, recoveries = 0;
  class MockSession extends EventEmitter {
    start(input) {
      this.state = { id: 'next-session', active: true, state: 'preparing', source: input.source, target: input.target, runs: [] };
      this.emit('state', this.state);
      return this.state;
    }
  }
  const context = vm.createContext({
    ...journalTools, fs, path,
    require: id => {
      if (id === './exchanges/lbank-browser.cjs') return { browser: browser || { cancelQueuedRequests: () => Promise.resolve() } };
      return require(id);
    },
    app: { getPath: name => { assert.equal(name, 'userData'); return directory; } },
    ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
    profileSession: profile, tradingSession: null, localStoppedSnapshot: null, journalFingerprint: null, tradingStopRequest: 0,
    lastTradingLog: '', tradingHistory: null,
    mainWindow: { isDestroyed: () => false, webContents: { send: (_channel, value) => renderer.push(value) } },
    logEvent: () => {}, getTradingHistory: () => ({ record: value => history.push(value) }),
    loadEncryptedCredentials: () => { credentialReads++; return credentials; },
    getAdapter: id => { adapterReads++; return adapters[id] || {}; },
    credentialFingerprint: () => fingerprint,
    recoverSession: () => { recoveries++; throw new Error('Fingerprint mismatch: must not recover for local Stop'); },
    ContinuousHedgeSession: MockSession,
  });
  vm.runInContext(journalBindings + publish + start + stop, context);
  return {
    context, history, renderer, directory, file,
    stop: mode => ipc.get('trading:stop')(null, mode),
    start: () => ipc.get('trading:start')(null, { source: 'a', target: 'lbank', symbols: ['BTCUSDT'] }),
    stored: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    archives: () => fs.readdirSync(path.join(directory, 'manual-stops')).map(name => JSON.parse(fs.readFileSync(path.join(directory, 'manual-stops', name), 'utf8'))),
    reads: () => ({ credentialReads, adapterReads, recoveries }),
  };
}

test('app-only stops a restored journal without authentication, credentials, adapters or fingerprint recovery', async t => {
  for (const profile of [null, { profile: { userCode: 'user-1' } }, { profile: {} }]) {
    const original = initialJournal(), f = fixture(t, { journal: original, profile });
    const result = await f.stop('app-only');
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.state, 'stopped');
    assert.equal(result.snapshot.active, false);
    assert.equal(result.snapshot.manualManagement, true);
    assert.equal(result.snapshot.requiresAttention, false);
    assert.equal(result.snapshot.error, undefined);
    assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
    assert.equal(f.stored().fingerprint, original.fingerprint);
    assert.equal(f.stored().extraJournalMetadata, 'retained');
    const run = f.stored().snapshot.runs[0];
    for (const key of ['sourceOrders', 'targetOrders', 'closeOrders']) assert.deepEqual(run[key], original.snapshot.runs[0][key]);
    assert.equal(run.state, 'stopped');
    assert.equal(f.archives().length, 1);
    assert.equal(f.archives()[0].snapshot.completedRounds, 0);
    assert.equal(f.archives()[0].extraJournalMetadata, 'retained');
    assert.equal(f.archives()[0].snapshot.result, undefined);
    assert.equal(f.renderer.at(-1).active, false);
    if (profile?.profile.userCode) {
      assert.equal(f.history.length, 1);
      assert.equal(f.history[0].id, 'coin-1');
      assert.equal(f.history[0].state, 'stopped');
      assert.equal(f.history[0].manualManagement, true);
      assert.equal(f.history[0].result, undefined);
    }
  }
});

test('live-session local Stop is available while signed out and a market stop is pending', async t => {
  const f = fixture(t), session = new EventEmitter();
  session.state = initialJournal().snapshot;
  session.stopPromise = new Promise(() => {});
  session.stop = mode => {
    assert.equal(mode, 'app-only');
    session.manualStop = true;
    session.state = journalTools.manualStopSnapshot(session.state);
    session.emit('state', session.state);
    return Promise.resolve(session.state);
  };
  f.context.tradingSession = session;
  f.context.journalFingerprint = 'fingerprint-for-old-credentials';
  vm.runInContext('bindTradingSession(tradingSession)', f.context);
  const result = await f.stop('app-only');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.active, false);
  assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
  assert.equal(f.archives().length, 1);
});

test('new Start preserves the complete manual journal and ignores old-session events', async t => {
  const f = fixture(t, { profile: { profile: { userCode: 'user-1' } } });
  await f.stop('app-only');
  const oldSession = new EventEmitter();
  oldSession.state = f.context.localStoppedSnapshot;
  f.context.tradingSession = oldSession;
  vm.runInContext('bindTradingSession(tradingSession)', f.context);
  const result = await f.start();
  assert.equal(result.ok, true);
  assert.equal(f.stored().snapshot.id, 'next-session');
  assert.equal(f.archives().length, 1);
  assert.equal(f.archives()[0].fingerprint, 'fingerprint-for-old-credentials');
  assert.equal(f.archives()[0].snapshot.runs[0].sourceOrders[0].status, 'UNKNOWN');
  const recorded = f.history.length;
  oldSession.emit('state', { ...oldSession.state, active: true, state: 'emergency' });
  oldSession.emit('round', { ...oldSession.state, state: 'completed' });
  assert.equal(f.history.length, recorded);
  assert.equal(f.stored().snapshot.id, 'next-session');
  assert.equal(f.renderer.at(-1).id, 'next-session');
});

test('new Start waits for previous requests while local Stop itself does not', async t => {
  for (const field of ['entryPromise', 'tickPromise', 'reconcilePromise', 'stopPromise', 'runPending', 'monitorPending']) {
    const f = fixture(t, { profile: { profile: { userCode: 'user-1' } } });
    const snapshot = journalTools.manualStopSnapshot(initialJournal().snapshot);
    f.context.tradingSession = { state: snapshot, [field]: true, stop: async () => snapshot };
    assert.equal((await f.stop('app-only')).ok, true);
    const result = await f.start();
    assert.equal(result.ok, false);
    assert.match(result.error, /предыдущие запросы ещё завершаются/);
    assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
  }
});

test('a local stopped journal restores without credentials while its loss limit still blocks new Start', async t => {
  const journal = initialJournal(); journal.snapshot.lossLimitReached = true;
  const f = fixture(t, { journal, profile: { profile: { userCode: 'user-1' } } });
  assert.equal((await f.stop('app-only')).ok, true);
  assert.equal(f.stored().snapshot.requiresAttention, true);
  f.context.localStoppedSnapshot = null;
  const result = await f.start();
  assert.equal(result.ok, false);
  assert.equal(f.context.localStoppedSnapshot.manualManagement, true);
  assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
});

test('pause stops the persisted bot offline before any decision about positions and blocks new Start', async t => {
  for (const profile of [null, { profile: { userCode: 'user-1' } }]) {
    const f = fixture(t, { profile }), original = initialJournal();
    const result = await f.stop('pause');
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.botStopped, true); assert.equal(result.snapshot.active, false);
    assert.equal(result.snapshot.state, 'stopped'); assert.equal(result.snapshot.closeStatus, 'not_requested');
    assert.equal(result.snapshot.requiresAttention, true); assert.equal(result.snapshot.manualStop, false);
    assert.deepEqual(f.stored().snapshot.runs[0].sourceOrders, original.snapshot.runs[0].sourceOrders);
    assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
    assert.equal(f.archives().length, 1);
    if (profile) { assert.equal((await f.start()).ok, false); assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 }); }
  }
});

test('market authentication or original-credential failures leave the bot stopped with a separate close error', async t => {
  for (const profile of [null, { profile: { userCode: 'user-1' } }]) {
    const f = fixture(t, { profile });
    const result = await f.stop('market');
    assert.equal(result.ok, true); assert.equal(result.error, undefined);
    assert.equal(result.snapshot.state, 'stopped'); assert.equal(result.snapshot.active, false);
    assert.equal(result.snapshot.botStopped, true); assert.equal(result.snapshot.closeStatus, 'failed');
    assert.equal(result.snapshot.requiresAttention, true); assert.equal(result.snapshot.error, undefined);
    assert.match(result.snapshot.closeError, profile ? /исходные подключения/ : /Сессия не подтверждена/);
    assert.equal(f.reads().adapterReads, 0); assert.equal(f.reads().recoveries, 0);
    assert.deepEqual(f.stored().snapshot.runs[0].sourceOrders, initialJournal().snapshot.runs[0].sourceOrders);
    assert.equal(f.renderer.at(-1).active, false);
  }
});

test('Retry treats fresh zero positions and zero open orders on both exchanges as confirmed cleanup', async t => {
  let writes = 0;
  const empty = {
    getPositions: async () => [],
    getOpenOrders: async () => [],
    placeOrder: async () => { writes++; },
    cancelOrder: async () => { writes++; },
  };
  const f = fixture(t, {
    profile: { profile: { userCode: 'user-1' } },
    adapters: { a: empty, lbank: empty },
    fingerprint: 'fingerprint-for-old-credentials',
  });
  const result = await f.stop('market');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.state, 'idle');
  assert.equal(result.snapshot.active, false);
  assert.deepEqual(f.stored().snapshot, { state: 'idle', active: false });
  assert.equal(writes, 0);
  assert.deepEqual(f.reads(), { credentialReads: 1, adapterReads: 2, recoveries: 0 });
  assert.equal(f.renderer.at(-1).state, 'idle');
  assert.ok(f.archives().some(journal => journal.snapshot.closeStatus === 'closed'));
});

test('market cleanup waits for the LBank queue fence before fresh reads or close commands', async t => {
  const sequence = [];
  let releaseFence;
  const browser = { cancelQueuedRequests: () => {
    sequence.push('fence:start');
    return new Promise(resolve => { releaseFence = () => { sequence.push('fence:done'); resolve(); }; });
  } };
  const sourceAdapter = {
    getPositions: async () => { sequence.push('read:source'); return [{ symbol: 'BTCUSDT', side: 'long', quantity: 1 }]; },
    getOpenOrders: async () => [],
  };
  const targetAdapter = { getPositions: async () => [], getOpenOrders: async () => [] };
  const f = fixture(t, { profile: { profile: { userCode: 'user-1' } }, browser });
  const session = new EventEmitter();
  session.state = initialJournal().snapshot;
  session.config = { sourceCredentials: {}, targetCredentials: {} };
  session.sourceAdapter = sourceAdapter;
  session.targetAdapter = targetAdapter;
  session.stop = async mode => {
    sequence.push(`stop:${mode}`);
    if (mode === 'pause') session.state = journalTools.pauseSnapshot(session.state);
    else session.state = { ...session.state, state: 'stopped', active: false, botStopped: true, closeStatus: 'closed', requiresAttention: false };
    session.emit('state', session.state);
    return session.state;
  };
  f.context.tradingSession = session;
  f.context.journalFingerprint = 'fingerprint-for-old-credentials';
  vm.runInContext('bindTradingSession(tradingSession)', f.context);
  const pending = f.stop('market');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sequence.includes('read:source'), false);
  assert.equal(sequence.includes('stop:market'), false);
  releaseFence();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.state, 'idle');
  assert.ok(sequence.indexOf('fence:done') < sequence.indexOf('read:source'));
  assert.ok(sequence.indexOf('fence:done') < sequence.indexOf('stop:market'));
});

test('restart acknowledges an old close error without dropping the unresolved safety lock', t => {
  const journal = initialJournal();
  Object.assign(journal.snapshot, {
    state: 'stopped', active: false, botStopped: true, requiresAttention: true,
    closeStatus: 'failed', closeError: 'OKX: no position [51169]', error: undefined,
  });
  const f = fixture(t, { journal, profile: { profile: { userCode: 'user-1' } } });
  vm.runInContext('restoreTradingSession()', f.context);
  assert.equal(f.context.localStoppedSnapshot.closeStatus, 'waiting_confirmation');
  assert.equal(f.context.localStoppedSnapshot.closeError, undefined);
  assert.equal(f.context.localStoppedSnapshot.requiresAttention, true);
  assert.equal(f.stored().snapshot.closeError, undefined);
  assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
});

test('unknown LBank close receipt never turns a successfully stopped bot active again', async t => {
  for (const code of [undefined, 'ORDER_PENDING_HISTORY']) {
    const f = fixture(t, { profile: { profile: { userCode: 'user-1' } } }), session = new EventEmitter();
    session.state = initialJournal().snapshot;
    session.stop = async mode => {
      if (mode === 'pause') {
        session.state = journalTools.pauseSnapshot(session.state); session.emit('state', session.state); return session.state;
      }
      throw Object.assign(new Error('LBank: исход заявки неизвестен; повторная отправка заблокирована'), { code });
    };
    f.context.tradingSession = session; f.context.journalFingerprint = 'fingerprint-for-old-credentials';
    vm.runInContext('bindTradingSession(tradingSession)', f.context);
    const result = await f.stop('market');
    assert.equal(result.ok, true); assert.equal(result.snapshot.botStopped, true); assert.equal(result.snapshot.active, false);
    assert.equal(result.snapshot.state, 'stopped'); assert.equal(result.snapshot.error, undefined);
    assert.equal(result.snapshot.closeStatus, code ? 'waiting_confirmation' : 'failed');
    assert.match(result.snapshot.closeError, /исход заявки неизвестен/);
    assert.equal(f.stored().snapshot.runs[0].sourceOrders[0].status, 'UNKNOWN');
    assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
  }
});

test('explicit market close after manual handoff creates a fresh close-only session instead of a no-op', async t => {
  const f = fixture(t, { profile: { profile: { userCode: 'user-1' } } });
  await f.stop('app-only');
  const original = f.stored();
  const oldSession = new EventEmitter(); oldSession.state = f.context.localStoppedSnapshot; oldSession.manualStop = true;
  oldSession.stop = async () => oldSession.state;
  f.context.tradingSession = oldSession;
  vm.runInContext('bindTradingSession(tradingSession)', f.context);
  f.context.credentialFingerprint = () => 'fingerprint-for-old-credentials';
  let recoveryJournal, marketRequests = 0;
  f.context.recoverSession = journal => {
    recoveryJournal = journal;
    const fresh = new EventEmitter(); fresh.state = journal.snapshot;
    fresh.stop = async mode => {
      assert.equal(mode, 'market'); marketRequests++;
      fresh.state = { ...fresh.state, closeStatus: 'waiting_confirmation', closeError: 'Receipt still indexing' };
      fresh.emit('state', fresh.state); return fresh.state;
    };
    return fresh;
  };
  const result = await f.stop('market');
  assert.equal(result.ok, true); assert.equal(marketRequests, 1);
  assert.notEqual(f.context.tradingSession, oldSession);
  assert.equal(recoveryJournal.snapshot.manualStop, false); assert.equal(recoveryJournal.snapshot.manualManagement, false);
  assert.equal(recoveryJournal.snapshot.botStopped, true); assert.equal(recoveryJournal.snapshot.active, false);
  assert.equal(recoveryJournal.snapshot.runs[0].manualStop, false);
  assert.deepEqual(recoveryJournal.snapshot.runs[0].sourceOrders, original.snapshot.runs[0].sourceOrders);
  assert.equal(oldSession.manualStop, true); assert.equal(oldSession.state.manualManagement, true);
  assert.equal(f.archives().length, 2);
  assert.ok(f.archives().some(journal => journal.snapshot.manualManagement));
  oldSession.emit('state', { ...oldSession.state, active: true, state: 'running' });
  assert.equal(f.stored().snapshot.active, false); assert.equal(f.stored().snapshot.manualManagement, false);
});

test('explicit close after manual Stop waits for old requests without reusing or waking halted engines', async t => {
  const f = fixture(t, { profile: { profile: { userCode: 'user-1' } } });
  await f.stop('app-only');
  const oldSession = { manualStop: true, entryPromise: new Promise(() => {}), state: f.context.localStoppedSnapshot };
  oldSession.stop = async () => oldSession.state;
  f.context.tradingSession = oldSession;
  const result = await f.stop('market');
  assert.equal(result.ok, true); assert.equal(result.snapshot.closeStatus, 'waiting_confirmation');
  assert.equal(result.snapshot.botStopped, true); assert.equal(result.snapshot.active, false);
  assert.equal(f.context.tradingSession, oldSession);
  assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
});

test('a late market-close failure cannot overwrite a newer manual-stop result', async t => {
  const f = fixture(t, { profile: { profile: { userCode: 'user-1' } } }), session = new EventEmitter();
  let rejectClose;
  session.state = initialJournal().snapshot;
  session.stop = async mode => {
    if (mode === 'market') return new Promise((_resolve, reject) => { rejectClose = reject; });
    session.state = mode === 'app-only' ? journalTools.manualStopSnapshot(session.state) : journalTools.pauseSnapshot(session.state);
    session.emit('state', session.state); return session.state;
  };
  f.context.tradingSession = session;
  vm.runInContext('bindTradingSession(tradingSession)', f.context);
  const market = f.stop('market');
  await new Promise(resolve => setImmediate(resolve));
  await f.stop('app-only');
  rejectClose(new Error('late exchange error'));
  const result = await market;
  assert.equal(result.ok, true); assert.equal(result.snapshot.manualManagement, true);
  assert.equal(result.snapshot.closeStatus, 'not_requested'); assert.equal(result.snapshot.closeError, undefined);
  assert.equal(f.stored().snapshot.closeError, undefined); assert.equal(f.stored().snapshot.active, false);
});

test('repeated Stop on a confirmed closed journal needs no authentication or duplicate cleanup and allows Start', async t => {
  for (const lossLimitReached of [false, true]) {
    const journal = initialJournal();
    Object.assign(journal.snapshot, { state: 'stopped', active: false, botStopped: true, closeStatus: 'closed', requiresAttention: lossLimitReached, lossLimitReached, error: undefined });
    journal.snapshot.runs = [];
    const f = fixture(t, { journal });
    for (const mode of ['pause', 'market', 'app-only', 'market', 'pause']) {
      const result = await f.stop(mode);
      assert.equal(result.ok, true); assert.equal(result.snapshot.active, false);
      assert.equal(result.snapshot.closeStatus, lossLimitReached ? 'closed' : undefined);
      assert.equal(result.snapshot.state, lossLimitReached ? 'stopped' : 'idle');
      assert.equal(Boolean(result.snapshot.requiresAttention), lossLimitReached);
    }
    assert.deepEqual(f.reads(), { credentialReads: 0, adapterReads: 0, recoveries: 0 });
    f.context.profileSession = { profile: { userCode: 'user-1' } };
    assert.equal((await f.start()).ok, !lossLimitReached);
    assert.equal(f.reads().recoveries, 0);
  }
});

test('a close-only clone preserves confirmed closure without creating an attention lock', () => {
  for (const lossLimitReached of [false, true]) {
    const original = initialJournal();
    Object.assign(original.snapshot, { closeStatus: 'closed', lossLimitReached, manualManagement: true });
    Object.assign(original.snapshot.runs[0], { closeStatus: 'closed', manualManagement: true });
    const cloned = journalTools.closeOnlyJournal(original);
    assert.equal(cloned.snapshot.closeStatus, 'closed'); assert.equal(cloned.snapshot.requiresAttention, lossLimitReached);
    assert.equal(cloned.snapshot.runs[0].requiresAttention, false);
    assert.deepEqual(cloned.snapshot.runs[0].sourceOrders, original.snapshot.runs[0].sourceOrders);
  }
});
