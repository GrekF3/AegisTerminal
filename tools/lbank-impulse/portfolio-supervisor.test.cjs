'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PortfolioSupervisor } = require('./portfolio-supervisor.cjs');

function fixture() {
  const calls = [], engine = { state: { connected: true, mode: 'live', running: false }, settings: { mode: 'live' },
    async configure(value) { calls.push(['configure', value]); }, async start() { calls.push(['start']); this.state.running = true; },
    async pause() { calls.push(['pause']); this.state.running = false; } };
  const trades = [], store = { data: {}, save() {}, canTrade: () => ({ allowed: true }), settingsFor: () => ({ thresholdBps: 3, impulsePercent: .03, activeLagBps: 2.4, trailBps: 1.95, emergencyBps: 3, maxHoldMs: 60_000 }),
    recordTrade: row => trades.push(row), nextCooldownMs: () => 180_000, noteProtectionFailure() {} };
  const candidate = { symbol: 'PONSUSDT', leader: 'binance', priority: 12, eligibleForLive: true };
  const analyzer = { store, liveCandidates: () => [candidate], bestCandidate: () => candidate };
  return { calls, trades, engine, analyzer, supervisor: new PortfolioSupervisor({ engine, analyzer, now: () => 1_000_000 }) };
}

test('portfolio activation uses max-position mode and adaptive symbol settings', async () => {
  const { calls, supervisor } = fixture(); supervisor.running = true; await supervisor.advance();
  assert.equal(calls[0][0], 'configure'); assert.equal(calls[0][1].autoPosition, true); assert.equal(calls[0][1].impulsePercent, .03);
  assert.deepEqual(calls[1], ['start']); assert.equal(supervisor.current.symbol, 'PONSUSDT');
});

test('closed live trade is recorded and starts the global cooldown', async () => {
  const { trades, supervisor } = fixture(); supervisor.running = true; supervisor.current = { symbol: 'PONSUSDT', leader: 'binance', thresholdBps: 3 };
  supervisor.onEngineEvent({ type: 'position', action: 'closed', reason: 'trailing_pullback', position: { avgPrice: 100, quantity: 1, openedAt: 999_000 },
    result: { pnlKnown: true, gross: 1, fees: .5, net: .5 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trades.length, 1); assert.equal(trades[0].live, true); assert.equal(supervisor.nextEntryAt, 1_180_000);
  assert.equal(supervisor.waitingReason, 'global_cooldown');
});

test('portfolio rotates through every eligible coin before starting a new cycle', async () => {
  const { analyzer, supervisor } = fixture();
  analyzer.liveCandidates = () => [
    { symbol: 'ONEUSDT', leader: 'binance', priority: 20, eligibleForLive: true },
    { symbol: 'TWOUSDT', leader: 'binance', priority: 10, eligibleForLive: true },
  ];
  assert.equal(supervisor.nextCandidate().symbol, 'ONEUSDT');
  supervisor.cycleSymbols.add('ONEUSDT');
  assert.equal(supervisor.nextCandidate().symbol, 'TWOUSDT');
  supervisor.cycleSymbols.add('TWOUSDT');
  assert.equal(supervisor.nextCandidate().symbol, 'ONEUSDT');
});

test('invalid candidate is skipped without stopping the portfolio', async () => {
  const { engine, analyzer, supervisor } = fixture();
  analyzer.liveCandidates = () => [
    { symbol: 'BADUSDT', leader: 'binance', priority: 20, eligibleForLive: true },
    { symbol: 'GOODUSDT', leader: 'binance', priority: 10, eligibleForLive: true },
  ];
  engine.configure = async value => { if (value.symbol === 'BADUSDT') throw new Error('unsupported contract'); };
  supervisor.running = true; supervisor.schedule = () => {};
  await supervisor.advance();
  assert.equal(supervisor.running, true); assert.equal(supervisor.waitingReason, 'candidate_skipped');
  assert.equal(supervisor.nextCandidate().symbol, 'GOODUSDT');
});

test('an unfilled order rotates immediately to the next coin without trade cooldown', async () => {
  const { engine, supervisor } = fixture();
  supervisor.running = true; supervisor.current = { symbol: 'ONEUSDT', leader: 'binance' };
  engine.state.running = true; supervisor.schedule = () => {};
  supervisor.onEngineEvent({ type: 'order', action: 'unfilled', order: { symbol: 'ONEUSDT', executedQty: 0 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(engine.state.running, false); assert.equal(supervisor.current, null);
  assert.equal(supervisor.waitingReason, 'selecting_candidate'); assert.equal(supervisor.nextEntryAt, null);
});
