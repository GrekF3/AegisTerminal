'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdaptivePortfolioStore } = require('./adaptive-portfolio.cjs');

function fixture(nowValue = Date.parse('2026-09-15T12:00:00Z')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lbank-adaptive-'));
  let now = nowValue;
  const store = new AdaptivePortfolioStore({ file: path.join(directory, 'portfolio.json'), now: () => now, maxRecentTrades: 100 });
  return { directory, store, setNow: value => { now = value; } };
}

test('threshold policy explores the bounded 0.02 to 0.08 percent arms before exploiting', () => {
  const { directory, store } = fixture();
  try {
    const seen = new Set();
    for (let index = 0; index < 7; index++) {
      const threshold = store.settingsFor('TESTUSDT', 'binance').thresholdBps; seen.add(threshold);
      store.recordAttempt({ symbol: 'TESTUSDT', thresholdBps: threshold });
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8]);
    const settings = store.settingsFor('TESTUSDT');
    assert.ok(settings.thresholdBps >= 2 && settings.thresholdBps <= 8);
    assert.ok(settings.trailBps >= 1.5 && settings.trailBps <= 4);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('five live losses stop a symbol for the UTC day and three cap days demote it fully', () => {
  const { directory, store, setNow } = fixture();
  try {
    for (let day = 15; day <= 17; day++) {
      setNow(Date.parse(`2026-09-${day}T12:00:00Z`));
      for (let loss = 0; loss < 5; loss++) store.recordTrade({ symbol: 'LOSSUSDT', thresholdBps: 3, net: -1, netBps: -2, live: true });
      assert.equal(store.canTrade('LOSSUSDT').allowed, false);
      setNow(Date.parse(`2026-09-${day + 1}T00:00:01Z`)); store.ensure('LOSSUSDT');
    }
    const row = store.ranked([{ symbol: 'LOSSUSDT', leader: 'binance', liquidityScore: 99 }])[0];
    assert.equal(row.capStreak, 3); assert.equal(row.priorityDemoted, true); assert.equal(row.blockedReason, null);
    assert.equal(store.canTrade('LOSSUSDT').allowed, true); assert.ok(row.priority < -90_000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('trade journal is bounded and local state reloads', () => {
  const { directory, store } = fixture();
  try {
    for (let index = 0; index < 130; index++) store.recordTrade({ symbol: 'KEEPUSDT', thresholdBps: 4, net: index % 2 ? 1 : -1, netBps: index % 2 ? 2 : -2 });
    assert.equal(store.data.recentTrades.length, 100);
    const reloaded = new AdaptivePortfolioStore({ file: store.file });
    assert.equal(reloaded.ensure('KEEPUSDT').lifetime.trades, 130);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('global cooldown always lands inside the requested 3 to 5 minute range', () => {
  const { directory, store } = fixture();
  try { const value = store.nextCooldownMs(); assert.ok(value >= 180_000 && value <= 300_000); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('one profitable Paper trade is enough to enter the Live candidate queue', () => {
  const { directory, store } = fixture();
  try {
    store.recordAttempt({ symbol: 'READYUSDT', leader: 'binance', thresholdBps: 3 });
    store.recordTrade({ symbol: 'READYUSDT', leader: 'binance', thresholdBps: 3, net: .1, netBps: 2 });
    const row = store.ranked([{ symbol: 'READYUSDT', leader: 'binance', liquidityScore: 50 }])[0];
    assert.equal(row.eligibleForLive, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a manually closed live trade stays in PnL history but does not consume the daily loss limit', () => {
  const { directory, store } = fixture();
  try {
    const entity = store.recordTrade({ symbol: 'MANUALUSDT', thresholdBps: 3, net: -1, netBps: -10,
      live: true, riskEligible: false, reason: 'manual_flatten' });
    assert.equal(entity.live.losses, 1); assert.equal(entity.daily.losses, 0);
    assert.equal(store.canTrade('MANUALUSDT').allowed, true);
    assert.equal(store.data.recentTrades.at(-1).riskEligible, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
