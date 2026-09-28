'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PortfolioScanner } = require('../../scripts/lbank-all-coins-paper.cjs');
const { AdaptivePortfolioStore } = require('./adaptive-portfolio.cjs');
const { defaultStateDirectory, safeError } = require('./engine.cjs');

function compactJsonl(file, maxLines = 5000) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const lines = text.split(/\r?\n/).filter(Boolean); if (lines.length <= maxLines) return;
  const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${lines.slice(-maxLines).join('\n')}\n`); fs.renameSync(temporary, file);
}

class PortfolioAnalyzer extends EventEmitter {
  constructor({ stateDirectory = defaultStateDirectory(), scannerFactory = options => new PortfolioScanner(options),
    emitEveryMs = 4000, rediscoverMs = 6 * 60 * 60 * 1000, retryMs = 30_000,
    compactEveryMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    super(); this.directory = path.join(stateDirectory, 'analyzer'); fs.mkdirSync(this.directory, { recursive: true });
    this.outputDir = path.join(this.directory, 'current'); this.store = new AdaptivePortfolioStore({ file: path.join(this.directory, 'portfolio.json'), now });
    this.scannerFactory = scannerFactory; this.emitEveryMs = emitEveryMs; this.rediscoverMs = rediscoverMs; this.retryMs = retryMs;
    this.compactEveryMs = compactEveryMs; this.now = now;
    this.scanner = null; this.running = false; this.starting = false; this.paused = false; this.error = null; this.startedAt = null;
    this.emitTimer = null; this.sweepTimer = null; this.refreshTimer = null; this.retryTimer = null; this.compactTimer = null; this.last = null;
  }

  emitProtocol(type, payload = {}) { const value = { v: 1, type, at: this.now(), ...payload }; this.emit('event', value); return value; }

  publicState() {
    return { running: this.running, starting: this.starting, paused: this.paused, error: this.error,
      startedAt: this.startedAt, outputDir: this.outputDir, ...(this.last || { universe: {}, totals: {}, rows: [], recentTrades: [] }) };
  }

  async start() {
    if (this.running || this.starting) return this.publicState();
    this.paused = false; this.starting = true; this.error = null; this.emitProtocol('analyzer_state', { analyzer: this.publicState() });
    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
      const scanner = this.scannerFactory({ durationMs: 365 * 24 * 60 * 60 * 1000, outputDir: this.outputDir, movementBps: 2,
        paper: { adaptive: this.store, nominal: 50, impulseBps: 3, cooldownMs: 0, warmupMs: 0,
          makerFee: .00016, takerFee: .0004, depthSafetyMultiplier: 2, maxEntrySpreadBps: 5, depthRequestsPerMinute: 120 } });
      this.scanner = scanner; await scanner.discover();
      if (this.paused) { await scanner.finish('paused_during_start'); return this.publicState(); }
      scanner.queues = {}; scanner.startDepthQueues(); scanner.startStreams(); scanner.status();
      this.running = true; this.starting = false; this.startedAt ||= this.now();
      this.sweepTimer = setInterval(() => scanner.sweepEvents(), 500); this.sweepTimer.unref?.();
      this.emitTimer = setInterval(() => this.publish(), this.emitEveryMs); this.emitTimer.unref?.();
      this.compactTimer = setInterval(() => this.compactLogs(), this.compactEveryMs); this.compactTimer.unref?.();
      this.refreshTimer = setTimeout(() => void this.restart(), this.rediscoverMs); this.refreshTimer.unref?.();
      this.publish(); return this.publicState();
    } catch (error) {
      this.running = false; this.starting = false; this.error = safeError(error); this.emitProtocol('analyzer_state', { analyzer: this.publicState() });
      if (!this.paused) { this.retryTimer = setTimeout(() => void this.start(), this.retryMs); this.retryTimer.unref?.(); }
      return this.publicState();
    }
  }

  buildSnapshot() {
    if (!this.scanner?.paper) return this.publicState();
    const paper = this.scanner.paper.summary(false), scannerSnapshot = this.scanner.snapshot(false), liquidityRows = [
      ...(scannerSnapshot.rankings?.lbankBinance || []), ...(scannerSnapshot.rankings?.lbankMexc || []),
    ];
    const liquidity = new Map();
    for (const row of liquidityRows) {
      const old = liquidity.get(row.symbol);
      if (!old || Number(row.liquidityScore || 0) > Number(old.liquidityScore || 0)) liquidity.set(row.symbol, row);
    }
    const merged = paper.rows.map(row => {
      const market = liquidity.get(row.symbol) || {};
      const lag = market.lag?.binanceToLbank?.median ?? market.lag?.lbankBehindMexcMs
        ?? market.lag?.mexcToLbank?.median ?? market.lag?.lbankToMexc?.median ?? null;
      return { ...row, liquidityScore: market.liquidityScore ?? 0, turnover24h: market.turnover24h ?? null,
        depth25Usd: market.depth25Usd ?? null, spreadBps: market.worstSpreadBps ?? null,
        changesPerMinute: market.activityChangesPerMinute ?? null, lagMs: lag };
    });
    const adaptive = this.store.snapshot(merged);
    const rows = adaptive.rows.map(row => ({
      symbol: row.symbol, leader: row.leader, phase: row.phase, thresholdBps: row.thresholdBps,
      priority: row.priority, eligibleForLive: row.eligibleForLive, blockedReason: row.blockedReason,
      priorityDemoted: row.priorityDemoted,
      adaptiveTrades: row.adaptiveTrades,
      adaptiveWinRate: row.adaptiveWinRate, adaptiveFillRate: row.adaptiveFillRate,
      adaptiveNet: row.adaptiveNet, dailyLosses: row.dailyLosses, capStreak: row.capStreak, lagMs: row.lagMs,
    }));
    return { universe: scannerSnapshot.universe, counters: scannerSnapshot.counters,
      totals: { ...adaptive.totals, runTrades: paper.totals.trades, runNet: paper.totals.net, openPositions: paper.totals.openPositions },
      rows, recentTrades: adaptive.recentTrades.slice(-50), generatedAt: adaptive.generatedAt };
  }

  publish() {
    if (!this.running) return this.publicState();
    try { this.last = this.buildSnapshot(); this.store.save(); this.emitProtocol('analyzer', { analyzer: this.publicState() }); }
    catch (error) { this.error = safeError(error); this.emitProtocol('analyzer_state', { analyzer: this.publicState() }); }
    return this.publicState();
  }

  liveCandidates() { return (this.last?.rows || []).filter(row => row.eligibleForLive && !row.blockedReason); }

  bestCandidate() { return this.liveCandidates()[0] || null; }

  setFeeRows(rows) {
    if (!rows || typeof rows !== 'object') return;
    if (this.scanner?.paper) this.scanner.paper.options.feeRows = rows;
  }

  async restart() {
    if (this.paused) return this.publicState();
    await this.stopScanner('rediscover'); this.paused = false; return this.start();
  }

  compactLogs() {
    for (const file of ['paper-trades.jsonl', 'lag-events.jsonl', 'depth-snapshots.jsonl']) compactJsonl(path.join(this.outputDir, file));
  }

  async stopScanner(reason) {
    clearInterval(this.emitTimer); clearInterval(this.sweepTimer); clearInterval(this.compactTimer);
    clearTimeout(this.refreshTimer); clearTimeout(this.retryTimer);
    this.emitTimer = this.sweepTimer = this.compactTimer = this.refreshTimer = this.retryTimer = null;
    const scanner = this.scanner; this.scanner = null; this.running = false; this.starting = false;
    if (scanner) { try { await scanner.finish(reason); } catch (error) { this.error = safeError(error); } }
    this.compactLogs();
  }

  async pause() { this.paused = true; await this.stopScanner('paused'); this.emitProtocol('analyzer_state', { analyzer: this.publicState() }); return this.publicState(); }
  async shutdown() { this.paused = true; await this.stopScanner('shutdown'); return this.publicState(); }
}

module.exports = { PortfolioAnalyzer, compactJsonl };
