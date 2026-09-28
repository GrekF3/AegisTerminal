'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const DEFAULT_THRESHOLDS = Object.freeze([2, 3, 4, 5, 6, 7, 8]);

function utcDay(at = Date.now()) { return new Date(at).toISOString().slice(0, 10); }

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function emptyTotals() {
  return { attempts: 0, signals: 0, orders: 0, fills: 0, trades: 0, wins: 0, losses: 0, breakeven: 0,
    gross: 0, fees: 0, net: 0, netBps: 0, heldMs: 0 };
}

function addTotals(target, input = {}) {
  for (const key of ['attempts', 'signals', 'orders', 'fills', 'trades', 'wins', 'losses', 'breakeven']) {
    target[key] = Math.max(0, Number(target[key] || 0) + Number(input[key] || 0));
  }
  for (const key of ['gross', 'fees', 'net', 'netBps', 'heldMs']) target[key] = Number(target[key] || 0) + Number(input[key] || 0);
  return target;
}

function previousUtcDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() - 1); return utcDay(date.getTime());
}

function hashUnit(value) {
  const bytes = crypto.createHash('sha256').update(String(value)).digest();
  return bytes.readUInt32BE(0) / 0xffffffff;
}

function wilsonLower(wins, trades, z = 1.2815515655446004) {
  if (!(trades > 0)) return 0;
  const p = wins / trades, z2 = z * z, denominator = 1 + z2 / trades;
  return Math.max(0, (p + z2 / (2 * trades) - z * Math.sqrt((p * (1 - p) + z2 / (4 * trades)) / trades)) / denominator);
}

function armScore(arm, totalAttempts) {
  const trades = Number(arm.trades || 0), attempts = Number(arm.attempts || 0), fills = Number(arm.fills || 0);
  if (!attempts) return Infinity;
  const meanNetBps = trades ? Number(arm.netBps || 0) / trades : -2;
  const confidenceWinRate = wilsonLower(Number(arm.wins || 0), trades);
  const fillRate = attempts ? fills / attempts : 0;
  const exploration = Math.sqrt(2 * Math.log(Math.max(2, totalAttempts + 1)) / attempts);
  return meanNetBps + confidenceWinRate * 4 + fillRate * 1.5 + exploration * 3;
}

function normalizeThresholds(values) {
  const result = [...new Set((Array.isArray(values) ? values : DEFAULT_THRESHOLDS).map(finite)
    .filter(value => value >= 2 && value <= 8).map(value => Math.round(value * 10) / 10))].sort((a, b) => a - b);
  return result.length ? result : [...DEFAULT_THRESHOLDS];
}

class AdaptivePortfolioStore {
  constructor({ file, now = () => Date.now(), thresholdsBps = DEFAULT_THRESHOLDS, maxRecentTrades = 2000,
    dailyLossLimit = 5, demoteAfterCapStreak = 3 } = {}) {
    if (!file) throw new Error('AdaptivePortfolioStore требует путь к локальному состоянию');
    this.file = path.resolve(file); this.now = now; this.thresholds = normalizeThresholds(thresholdsBps);
    this.maxRecentTrades = Math.max(100, Number(maxRecentTrades) || 2000);
    this.dailyLossLimit = Math.max(1, Number(dailyLossLimit) || 5); this.demoteAfterCapStreak = Math.max(1, Number(demoteAfterCapStreak) || 3);
    this.data = this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value?.version === 1 && value.symbols && typeof value.symbols === 'object') return value;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { version: 1, createdAt: this.now(), updatedAt: this.now(), symbols: {}, recentTrades: [] };
  }

  save() { this.data.updatedAt = this.now(); atomicWrite(this.file, this.data); }

  ensure(symbol, leader = null) {
    symbol = String(symbol || '').toUpperCase();
    let entity = this.data.symbols[symbol];
    if (!entity) {
      const arms = {}; for (const threshold of this.thresholds) arms[String(threshold)] = emptyTotals();
      entity = this.data.symbols[symbol] = { symbol, leader, createdAt: this.now(), updatedAt: this.now(), selectedThresholdBps: null,
        lifetime: emptyTotals(), live: emptyTotals(), daily: { day: utcDay(this.now()), ...emptyTotals(), capHit: false },
        capStreak: 0, lastCapDay: null, arms, protectionFailures: 0, quarantineReason: null };
    }
    if (leader) entity.leader = leader;
    for (const threshold of this.thresholds) entity.arms[String(threshold)] ||= emptyTotals();
    this.rollDay(entity); return entity;
  }

  rollDay(entity) {
    const today = utcDay(this.now()); if (entity.daily?.day === today) return;
    const old = entity.daily || { day: null, capHit: false };
    if (old.capHit) {
      entity.capStreak = entity.lastCapDay === previousUtcDay(old.day) ? Number(entity.capStreak || 0) + 1 : 1;
      entity.lastCapDay = old.day;
    } else if (Number(old.trades || 0) > 0) entity.capStreak = 0;
    entity.daily = { day: today, ...emptyTotals(), capHit: false }; entity.updatedAt = this.now();
  }

  selectThreshold(symbol, leader = null) {
    const entity = this.ensure(symbol, leader), arms = this.thresholds.map(threshold => ({ threshold, arm: entity.arms[String(threshold)] }));
    const untested = arms.filter(row => Number(row.arm.attempts || 0) === 0);
    let selected;
    if (untested.length) {
      const seed = `${symbol}:${utcDay(this.now())}:${entity.lifetime.attempts || 0}`;
      selected = untested[Math.min(untested.length - 1, Math.floor(hashUnit(seed) * untested.length))].threshold;
    } else {
      const totalAttempts = arms.reduce((sum, row) => sum + Number(row.arm.attempts || 0), 0);
      selected = arms.map(row => ({ ...row, score: armScore(row.arm, totalAttempts) }))
        .sort((a, b) => b.score - a.score || a.threshold - b.threshold)[0].threshold;
    }
    entity.selectedThresholdBps = selected; entity.updatedAt = this.now(); return selected;
  }

  settingsFor(symbol, leader = null) {
    const entity = this.ensure(symbol, leader);
    const savedThreshold = entity.selectedThresholdBps == null ? null : finite(entity.selectedThresholdBps);
    const thresholdBps = savedThreshold ?? this.selectThreshold(symbol, leader);
    return { thresholdBps, impulsePercent: thresholdBps / 100,
      activeLagBps: Math.max(2, thresholdBps * .8), trailBps: Math.max(1.5, Math.min(4, thresholdBps * .65)),
      emergencyBps: Math.max(3, thresholdBps), maxHoldMs: Math.round(45_000 + thresholdBps * 3_750) };
  }

  recordAttempt({ symbol, leader, thresholdBps, signal = true } = {}) {
    const entity = this.ensure(symbol, leader), threshold = finite(thresholdBps) ?? this.selectThreshold(symbol, leader);
    const arm = entity.arms[String(threshold)] ||= emptyTotals();
    addTotals(entity.lifetime, { attempts: 1, signals: signal ? 1 : 0 }); addTotals(arm, { attempts: 1, signals: signal ? 1 : 0 });
    entity.updatedAt = this.now(); return this.selectThreshold(symbol, leader);
  }

  recordTrade({ symbol, leader, thresholdBps, gross = 0, fees = 0, net = 0, netBps = 0, heldMs = 0,
    fill = true, live = false, riskEligible = live, reason = null } = {}) {
    const entity = this.ensure(symbol, leader);
    const explicitThreshold = thresholdBps == null ? null : finite(thresholdBps);
    const savedThreshold = entity.selectedThresholdBps == null ? null : finite(entity.selectedThresholdBps);
    const threshold = explicitThreshold ?? savedThreshold ?? this.selectThreshold(symbol, leader);
    const arm = entity.arms[String(threshold)] ||= emptyTotals(), result = net > 1e-12 ? 'win' : net < -1e-12 ? 'loss' : 'breakeven';
    const delta = { fills: fill ? 1 : 0, trades: 1, wins: result === 'win' ? 1 : 0, losses: result === 'loss' ? 1 : 0,
      breakeven: result === 'breakeven' ? 1 : 0, gross, fees, net, netBps, heldMs };
    addTotals(entity.lifetime, delta); addTotals(arm, delta);
    if (live) {
      addTotals(entity.live, delta);
      if (riskEligible) {
        addTotals(entity.daily, delta);
        if (entity.daily.losses >= this.dailyLossLimit) entity.daily.capHit = true;
      }
    }
    this.data.recentTrades.push({ at: this.now(), symbol: entity.symbol, leader: entity.leader, thresholdBps: threshold,
      live, riskEligible: Boolean(riskEligible), result, gross, fees, net, netBps, heldMs, reason });
    if (this.data.recentTrades.length > this.maxRecentTrades) this.data.recentTrades.splice(0, this.data.recentTrades.length - this.maxRecentTrades);
    entity.updatedAt = this.now(); this.selectThreshold(symbol, leader); this.save(); return entity;
  }

  noteProtectionFailure(symbol) {
    const entity = this.ensure(symbol); entity.protectionFailures = Number(entity.protectionFailures || 0) + 1;
    entity.quarantineReason = 'protection_failed'; entity.updatedAt = this.now(); this.save();
  }

  clearQuarantine(symbol) { const entity = this.ensure(symbol); entity.quarantineReason = null; entity.updatedAt = this.now(); this.save(); }

  canTrade(symbol) {
    const entity = this.ensure(symbol);
    if (entity.quarantineReason) return { allowed: false, reason: entity.quarantineReason };
    if (Number(entity.daily.losses || 0) >= this.dailyLossLimit) return { allowed: false, reason: 'daily_loss_limit' };
    return { allowed: true, reason: null };
  }

  priority(symbol, simulation = {}) {
    const entity = this.ensure(symbol, simulation.leader), allowed = this.canTrade(symbol);
    const stats = entity.lifetime, trades = Number(stats.trades || 0), attempts = Number(stats.attempts || 0);
    const meanNetBps = trades ? Number(stats.netBps || 0) / trades : -3;
    const confidence = wilsonLower(Number(stats.wins || 0), trades), fillRate = attempts ? Number(stats.fills || 0) / attempts : 0;
    const liquidity = Math.max(0, Math.min(100, Number(simulation.liquidityScore || 0)));
    let score = meanNetBps * 5 + confidence * 30 + fillRate * 8 + Math.log1p(trades) * 3 + liquidity * .18;
    const priorityDemoted = Number(entity.capStreak || 0) >= this.demoteAfterCapStreak;
    if (priorityDemoted) score -= 100_000;
    if (!allowed.allowed) score -= 10_000;
    return { score, allowed: allowed.allowed, blockedReason: allowed.reason, priorityDemoted, meanNetBps, confidenceWinRate: confidence, fillRate };
  }

  nextCooldownMs(minMs = 180_000, maxMs = 300_000) {
    const low = Math.max(0, Number(minMs) || 0), high = Math.max(low, Number(maxMs) || low);
    return Math.round(low + hashUnit(`${this.now()}:${this.data.updatedAt}:${this.data.recentTrades.length}`) * (high - low));
  }

  ranked(simulationRows = []) {
    return simulationRows.map(row => {
      const entity = this.ensure(row.symbol, row.leader), settings = this.settingsFor(row.symbol, row.leader), priority = this.priority(row.symbol, row);
      const stats = entity.lifetime, trades = Number(stats.trades || 0);
      return { ...row, ...settings, priority: priority.score, eligibleForLive: priority.allowed && trades >= 1 && priority.meanNetBps >= -.5,
        blockedReason: priority.blockedReason, priorityDemoted: priority.priorityDemoted, adaptiveTrades: trades, adaptiveWins: stats.wins, adaptiveLosses: stats.losses,
        adaptiveNet: stats.net, adaptiveNetBps: stats.netBps, meanNetBps: priority.meanNetBps,
        adaptiveWinRate: trades ? Number(stats.wins || 0) / trades : null, adaptiveFillRate: priority.fillRate,
        dailyLosses: Number(entity.daily.losses || 0), dailyLossLimit: this.dailyLossLimit, capStreak: Number(entity.capStreak || 0),
        quarantineReason: entity.quarantineReason || null };
    }).sort((a, b) => b.priority - a.priority || b.adaptiveTrades - a.adaptiveTrades || String(a.symbol).localeCompare(String(b.symbol)));
  }

  snapshot(simulationRows = []) {
    const rows = this.ranked(simulationRows); return { version: 1, generatedAt: new Date(this.now()).toISOString(),
      thresholdsBps: this.thresholds, dailyLossLimit: this.dailyLossLimit,
      totals: rows.reduce((sum, row) => { sum.symbols++; sum.trades += Number(row.adaptiveTrades || 0); sum.net += Number(row.adaptiveNet || 0);
        if (row.eligibleForLive) sum.liveReady++; if (row.blockedReason) sum.blocked++; return sum; }, { symbols: 0, trades: 0, net: 0, liveReady: 0, blocked: 0 }),
      rows, recentTrades: this.data.recentTrades.slice(-200) };
  }
}

module.exports = { AdaptivePortfolioStore, DEFAULT_THRESHOLDS, armScore, utcDay, wilsonLower };
