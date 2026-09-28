const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PortfolioPaper, inferTick } = require('./lbank-all-coins-paper.cjs');

function fixture() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbank-all-paper-'));
  const scanner = {
    outputDir, lbankMexc: ['TESTUSDT'], lbankBinance: ['TESTUSDT'],
    markets: { lbank: new Map([['TESTUSDT', {}]]), mexc: new Map([['TESTUSDT', {}]]), binance: new Map([['TESTUSDT', {}]]) },
    quotes: new Map(), latestDepth: new Map(), queues: { lbank: { enqueue() {} } },
  };
  const paper = new PortfolioPaper(scanner, { warmupMs: 0, minimumHoldMs: 0, activeLagBps: 3, trailBps: 2,
    impulseBps: 3, cooldownMs: 0, maxEntrySlippageBps: 0, marketImpulseMultiplier: 2, depthSafetyMultiplier: 2 });
  paper.initialize(); return { outputDir, scanner, paper, state: paper.states.get('TESTUSDT') };
}

test('all-coins Paper uses a full depth-backed fill and the ZEC pullback exit', () => {
  const { outputDir, scanner, paper, state } = fixture(), now = Date.now();
  try {
    scanner.quotes.set('binance:TESTUSDT', { price: 100.1, receivedAt: now });
    scanner.quotes.set('lbank:TESTUSDT', { price: 98.9, receivedAt: now });
    state.history.push({ at: now - 1000, price: 100 }, { at: now, price: 100.1 }); state.lastLeaderAt = now;
    state.basis.value = Math.log(.99); state.basis.firstAt = now - 1000; state.basis.lastAt = now;
    state.pending = { token: 'paper-1', detectedAt: now, expiresAt: now + 1000, side: 'BUY', impulseBps: 10,
      expectedFair: 99.099, leaderEntry: 100.1 };
    const entryBook = { bids: [{ price: 98.9, quantity: 100 }], asks: [{ price: 98.91, quantity: 100 }], mid: 98.905, receivedAt: now };
    paper.processEntryBook(state, entryBook);
    assert.equal(state.position?.entryType, 'LIMIT'); assert.equal(state.position?.postOnly, false); assert.equal(state.stats.fills, 1);

    state.tracker.minimumHoldMs = 0;
    state.tracker.observe({ leaderPrice: 100.2, lbankPrice: 99, lagBps: 8 }, now + 10);
    const reason = state.tracker.observe({ leaderPrice: 100.17, lbankPrice: 99.15, lagBps: 1 }, now + 20);
    assert.equal(reason, 'trailing_pullback');
    state.awaitingExit = { token: 'exit-1', reason, startedAt: now + 20 };
    paper.processExitBook(state, { bids: [{ price: 99.14, quantity: 100 }], asks: [{ price: 99.16, quantity: 100 }], receivedAt: now + 20 });
    assert.equal(state.position, null); assert.equal(state.stats.trades, 1); assert.ok(state.stats.fees > 0);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('tick inference uses the smallest observed positive book step', () => {
  assert.equal(inferTick({ bids: [[99.98, 1], [99.97, 1]], asks: [[100.01, 1], [100.03, 1]], mid: 100 }), .01);
});

test('open Paper positions are managed from the executable LBank book, not its last trade', () => {
  const { outputDir, scanner, paper, state } = fixture(), now = Date.now();
  try {
    scanner.quotes.set('binance:TESTUSDT', { price: 100, receivedAt: now + 100 });
    // Deliberately contradictory last trade: it must not drive a position exit.
    scanner.quotes.set('lbank:TESTUSDT', { price: 101, receivedAt: now + 100 });
    state.basis.value = 0; state.basis.firstAt = now - 1000; state.basis.lastAt = now;
    paper.establish(state, { side: 'BUY', quantity: 1, price: 100, leaderEntry: 100,
      entryType: 'MARKET', entryFeeRate: 0, tickSize: .01 }, now);
    state.positionBook = { bid: 99.89, ask: 99.91, mid: 99.9, receivedAt: now + 100 };
    let exitReason = null; paper.requestExit = (_state, reason) => { exitReason = reason; };
    paper.monitorPosition(state, now + 100);
    assert.equal(exitReason, 'hard_stop');
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});
