'use strict';

const { EventEmitter } = require('node:events');
const { safeError } = require('./engine.cjs');

class PortfolioSupervisor extends EventEmitter {
  constructor({ engine, analyzer, now = () => Date.now(), minCooldownMs = 180_000, maxCooldownMs = 300_000 } = {}) {
    super(); if (!engine || !analyzer) throw new Error('PortfolioSupervisor требует engine и analyzer');
    this.engine = engine; this.analyzer = analyzer; this.now = now; this.minCooldownMs = minCooldownMs; this.maxCooldownMs = maxCooldownMs;
    this.running = false; this.operation = null; this.timer = null; this.rotationTimer = null; this.current = null; this.nextEntryAt = Number(analyzer.store?.data?.nextLiveAt) || null;
    this.waitingReason = 'paused'; this.error = null; this.lastTrade = null; this.cycleSymbols = new Set();
  }

  emitProtocol(type, payload = {}) { const value = { v: 1, type, at: this.now(), ...payload }; this.emit('event', value); return value; }
  publicState() { return { running: this.running, current: this.current, nextEntryAt: this.nextEntryAt,
    waitingReason: this.waitingReason, error: this.error, lastTrade: this.lastTrade }; }
  publish() { this.emitProtocol('portfolio', { portfolio: this.publicState() }); return this.publicState(); }

  async start() {
    if (this.running) return this.publicState();
    if (!this.engine.state?.connected) throw new Error('Сначала подключите профиль LBank');
    if (this.engine.settings?.mode !== 'live' && this.engine.state?.mode !== 'live') throw new Error('Для автоторговли выберите Live в настройках');
    this.running = true; this.error = null; this.waitingReason = 'selecting_candidate'; this.publish(); this.schedule(0); return this.publicState();
  }

  schedule(delayMs = 0) {
    clearTimeout(this.timer); if (!this.running) return;
    this.timer = setTimeout(() => { this.timer = null; void this.advance(); }, Math.max(0, delayMs)); this.timer.unref?.();
  }

  async advance() {
    if (!this.running || this.operation) return;
    const wait = Math.max(0, Number(this.nextEntryAt || 0) - this.now());
    if (wait > 0) { this.waitingReason = 'global_cooldown'; this.publish(); this.schedule(Math.min(wait, 5000)); return; }
    const candidate = this.nextCandidate();
    if (!candidate) { this.waitingReason = 'no_validated_candidate'; this.current = null; this.publish(); this.schedule(15_000); return; }
    const gate = this.analyzer.store.canTrade(candidate.symbol);
    if (!gate.allowed) { this.waitingReason = gate.reason; this.publish(); this.schedule(15_000); return; }
    this.cycleSymbols.add(candidate.symbol);
    this.operation = this.activate(candidate);
    try { await this.operation; }
    catch (error) {
      // A delisted/non-standard contract must not stop the whole portfolio.
      // Skip it for this cycle and immediately continue with the next coin.
      this.error = safeError(error); this.waitingReason = 'candidate_skipped'; this.current = null; this.publish();
      if (this.running) this.schedule(1000);
    }
    finally { this.operation = null; }
  }

  nextCandidate() {
    const candidates = typeof this.analyzer.liveCandidates === 'function'
      ? this.analyzer.liveCandidates()
      : [this.analyzer.bestCandidate()].filter(Boolean);
    if (!candidates.length) return null;
    let candidate = candidates.find(row => !this.cycleSymbols.has(row.symbol));
    if (!candidate) { this.cycleSymbols.clear(); candidate = candidates[0]; }
    return candidate;
  }

  async activate(candidate) {
    if (this.engine.state.running) await this.engine.pause();
    this.error = null;
    const dynamic = this.analyzer.store.settingsFor(candidate.symbol, candidate.leader);
    this.current = { symbol: candidate.symbol, leader: candidate.leader, thresholdBps: dynamic.thresholdBps,
      priority: candidate.priority, selectedAt: this.now() };
    this.waitingReason = 'configuring'; this.publish();
    await this.engine.configure({ symbol: candidate.symbol, mode: 'live', paperFast: false, autoPosition: true, reserveFraction: .1,
      impulsePercent: dynamic.impulsePercent, cooldownSeconds: 0, warmupSeconds: 0, entryLifetimeMs: 1200, trailingActivationPercent: dynamic.activeLagBps / 100,
      reversalPercent: dynamic.trailBps / 100, adversePercent: dynamic.emergencyBps / 100,
      maxHoldSeconds: Math.round(dynamic.maxHoldMs / 1000) });
    if (!this.running) return;
    await this.engine.start(); this.waitingReason = 'trading'; this.publish();
  }

  onEngineEvent(event) {
    const context = this.current || (this.engine.config?.mode === 'live' && this.engine.config?.symbol
      ? { symbol: this.engine.config.symbol, leader: this.engine.reference?.leader, thresholdBps: this.engine.config.impulseBps, manual: true }
      : null);
    if (!context) return;
    if (event.type === 'protection' && event.action === 'failed') this.analyzer.store.noteProtectionFailure(context.symbol);
    if (this.current && event.type === 'order' && ['unfilled', 'rejected'].includes(event.action)) this.rotateAfterUnfilled();
    if (event.type === 'position' && event.action === 'closed') {
      const result = event.result || {};
      // A supervisor context only exists for automatic Live trading or a manual Live configuration.
      // The closed event normally carries the position mode as well, but accounting must not disappear
      // if a recovered/legacy journal event omits that optional field.
      if (result.pnlKnown !== false && Number.isFinite(Number(result.net))) {
        const position = event.position || this.engine.state?.position || {};
        const notional = Number(position.avgPrice || 0) * Number(position.quantity || 0);
        const net = Number(result.net), netBps = notional > 0 ? net / notional * 10_000 : 0;
        this.analyzer.store.recordTrade({ symbol: context.symbol, leader: context.leader,
          thresholdBps: context.thresholdBps, gross: Number(result.gross || 0), fees: Number(result.fees || 0), net, netBps,
          heldMs: Math.max(0, this.now() - Number(position.openedAt || this.now())), live: true,
          riskEligible: !['manual_flatten', 'shutdown'].includes(String(event.reason || '')), reason: event.reason });
        this.lastTrade = { at: this.now(), symbol: context.symbol, net, netBps, reason: event.reason };
      }
      const cooldownMs = this.analyzer.store.nextCooldownMs(this.minCooldownMs, this.maxCooldownMs);
      this.nextEntryAt = this.now() + cooldownMs; this.analyzer.store.data.nextLiveAt = this.nextEntryAt; this.analyzer.store.save();
      this.waitingReason = 'global_cooldown'; this.publish();
      if (!this.running) return;
      Promise.resolve().then(() => this.engine.pause()).catch(error => {
        this.running = false; this.error = safeError(error); this.publish();
      }).finally(() => { this.current = null; if (this.running) this.schedule(Math.min(cooldownMs, 5000)); });
    }
    if (event.type === 'error' && event.fatal) { this.running = false; this.waitingReason = 'error'; this.error = event.error || null; this.publish(); }
  }

  rotateAfterUnfilled() {
    if (!this.running || !this.current || this.rotationTimer) return;
    // Defer until the engine has cleared its own operation promise; calling
    // pause synchronously from the order event would wait on that same promise.
    this.rotationTimer = setTimeout(async () => {
      this.rotationTimer = null;
      if (!this.running || this.engine.state.position || this.engine.state.activeOrder) return;
      try {
        if (this.engine.state.running) await this.engine.pause();
        this.current = null; this.error = null; this.waitingReason = 'selecting_candidate'; this.publish(); this.schedule(0);
      } catch (error) {
        this.running = false; this.waitingReason = 'error'; this.error = safeError(error); this.publish();
      }
    }, 0);
    this.rotationTimer.unref?.();
  }

  async pause({ touchEngine = true } = {}) {
    this.running = false; clearTimeout(this.timer); clearTimeout(this.rotationTimer); this.timer = this.rotationTimer = null; this.waitingReason = 'paused';
    if (touchEngine && (this.engine.state.running || this.engine.state.activeOrder)) await this.engine.pause();
    this.publish(); return this.publicState();
  }

  cooldownRemainingMs() { return Math.max(0, Number(this.nextEntryAt || 0) - this.now()); }

  async shutdown() { return this.pause({ touchEngine: false }); }
}

module.exports = { PortfolioSupervisor };
