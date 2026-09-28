const { EventEmitter } = require("events");
const { HedgeEngine } = require("./hedge-engine.cjs");
const { allocation, buildPlan } = require("./hedge-plan.cjs");
const { targetPnlBasis } = require('./pnl-target.cjs');
const crypto = require("crypto");

function shuffle(values, random = Math.random) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

class HedgeSession extends EventEmitter {
  constructor({ sourceAdapter, targetAdapter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, now = Date.now }) {
    super(); Object.assign(this, { sourceAdapter, targetAdapter, sleep, random, now });
    this.engines = []; this.state = { state: "idle", active: false }; this.stopRequested = false;
    this.runPromise = null; this.stopPromise = null; this.monitorTimer = null; this.monitorPending = false;
    this.manualStop = false; this.botStopped = false; this.runPending = false;
  }
  publish(patch) {
    // Already-dispatched requests may still resolve. Keep their order receipts,
    // but never let a late callback restart or fail a locally stopped session.
    if (this.manualStop) {
      const resetLossLimit = patch.lossLimitReached === false && patch.requiresAttention === false;
      patch = { state: 'stopped', active: false, requiresAttention: !resetLossLimit && this.state.lossLimitReached === true,
        ...(resetLossLimit ? { lossLimitReached: false } : {}),
        stopMode: 'app-only', manualStop: true, manualManagement: true, botStopped: true, closeStatus: 'not_requested', closeError: undefined, appStoppedAt: this.appStoppedAt,
        error: undefined, notice: { code: 'manual_stop', level: 'info', message: 'Бот остановлен. Позиции и заявки на биржах остаются под вашим управлением.' } };
    } else if (this.botStopped) {
      // Stopping the strategy and settling exchange exposure are independent.
      // Late entry/read/close callbacks may update receipts, never restart it.
      const closeStatus = patch.closeStatus || this.state.closeStatus || 'not_requested';
      const finished = closeStatus === 'closed' && ['completed', 'loss_limit'].includes(patch.state);
      patch = { ...patch, state: finished ? patch.state : 'stopped', active: false, botStopped: true,
        appStoppedAt: this.appStoppedAt, closeStatus, error: undefined };
    }
    this.state = { ...this.state, ...patch, runs: this.engines.map((engine) => engine.snapshot()), updatedAt: this.now() };
    this.emit("state", this.state); return this.state;
  }
  start(input) {
    if (this.state.active || this.state.requiresAttention) throw new Error("Сначала завершите текущий хедж");
    if (this.runPending || this.stopPromise || this.monitorPending) throw new Error('Предыдущие запросы ещё завершаются; бот остановлен, новый запуск пока недоступен');
    const allocations = allocation(input);
    if (input.source === input.target) throw new Error("Выберите две разные биржи");
    if (input.dryRun === false && input.liveConfirmation !== "LIVE_TRADING_CONFIRMED") throw new Error("Live trading требует подтверждения");
    const hedgePercent = Number(input.hedgePercent ?? 98);
    if (!Number.isFinite(hedgePercent) || hedgePercent <= 0 || hedgePercent > 100) throw new Error("Цель PnL должна быть больше 0 и не выше 100% маржи");
    this.config = { ...input, hedgePercent };
    this.stopRequested = false; this.manualStop = false; this.botStopped = false; this.appStoppedAt = undefined; this.engines = [];
    this.publish({ id: crypto.randomUUID(), source: input.source, target: input.target, symbols: allocations.map((item) => item.symbol), totalMargin: Number(input.totalMargin), startedAt: this.now(), state: "preparing", active: true, requiresAttention: false, manualStop: false, manualManagement: false, botStopped: false, closeStatus: undefined, closeError: undefined, appStoppedAt: undefined, dryRun: input.dryRun !== false, totalOrders: allocations.length, completedOrders: 0, error: undefined, result: undefined, currentPnl: undefined });
    this.runPending = true;
    this.runPromise = this.run(allocations).finally(() => { this.runPending = false; });
    return this.state;
  }
  async run(allocations) {
    const c = this.config;
    try {
      let plan;
      if (c.dryRun === false) plan = await buildPlan(c, this.sourceAdapter, this.targetAdapter, this.random);
      else {
        const legs = [];
        for (const item of allocations) {
          const book = await this.targetAdapter.getDepth(item.symbol, 5, c.targetCredentials);
          const price = Number(book.bids?.[0]?.price);
          if (!(price > 0)) throw new Error(item.symbol + ": нет цены даже для симуляции");
          legs.push({ ...item, price, quantity: item.notional / price, targetSide: this.random() < 0.5 ? "BUY" : "SELL" });
        }
        plan = { legs };
      }
      if (this.stopRequested) return this.state;
      this.publish({ plan });
      if (plan.legs.some((leg) => leg.impact?.impactPercent > 0.01) && c.acceptImpact !== true) throw new Error("Потери по стакану выше 0.01%. Проверьте расчёт и подтвердите предупреждение.");
      if (c.dryRun === false) {
        this.publish({ state: "configuring_leverage" });
        // A rejection on either venue happens BEFORE opening any position.
        for (const leg of plan.legs) {
          if (this.stopRequested) return this.state;
          await this.sourceAdapter.configureLeverage(c.sourceCredentials, { ...leg, side: leg.targetSide === "BUY" ? "SELL" : "BUY" }, { allowLiveTrading: true });
          if (this.stopRequested) return this.state;
          await this.targetAdapter.configureLeverage(c.targetCredentials, { ...leg, side: leg.targetSide }, { allowLiveTrading: true });
        }
      }
      for (const leg of shuffle(plan.legs, this.random)) {
        if (this.stopRequested) break;
        // Recheck source liquidity just before sending the first leg of this coin.
        if (c.dryRun === false) {
          const { marketImpact } = require("./hedge-plan.cjs");
          const impact = marketImpact(await this.sourceAdapter.getDepth(leg.symbol, 100, c.sourceCredentials), leg.targetSide === "BUY" ? "SELL" : "BUY", leg.quantity);
          if (impact.insufficientDepth || (impact.impactPercent > 0.01 && !c.acceptImpact)) throw new Error(leg.symbol + ": ликвидность изменилась, запуск прерван");
        }
        if (this.stopRequested) break;
        const engine = new HedgeEngine({ sourceAdapter: this.sourceAdapter, targetAdapter: this.targetAdapter, sleep: this.sleep, now: this.now });
        this.engines.push(engine);
        engine.on("state", (value) => this.publish({ state: value.state, currentSymbol: leg.symbol }));
        await engine.start({ ...c, ...leg });
        if (!this.stopRequested) this.publish({ completedOrders: this.state.completedOrders + 1 });
      }
      if (!this.stopRequested) {
        this.publish({ state: c.dryRun === false ? "monitoring" : "running", active: true, currentSymbol: undefined, error: undefined });
        if (c.dryRun === false) this.scheduleMonitor();
      }
    } catch (error) {
      if (this.stopRequested) return this.state;
      const exposed = this.engines.some((e) => e.snapshot().active);
      this.publish({ state: exposed ? "emergency" : "error", active: exposed, requiresAttention: exposed, error: error.message });
    }
    return this.state;
  }
  scheduleMonitor() {
    clearTimeout(this.monitorTimer);
    if (this.stopRequested) return;
    this.monitorTimer = setTimeout(async () => {
      if (this.stopRequested) return;
      this.monitorPending = true;
      try { await this.monitorOnce(); } finally { this.monitorPending = false; this.scheduleMonitor(); }
    }, 1000);
    this.monitorTimer.unref?.();
  }
  async monitorOnce() {
    if (this.stopRequested) return;
    const c = this.config;
    try {
      const [source, target] = await Promise.all([this.sourceAdapter.getPositions(c.sourceCredentials), this.targetAdapter.getPositions(c.targetCredentials)]);
      if (this.stopRequested) return;
      const pnl = { source: 0, target: 0 };
      for (const leg of ["source", "target"]) {
        for (const engine of this.engines) {
          const run = engine.snapshot();
          const matches = (leg === "source" ? source : target).filter((p) => p.symbol === run.symbol && p.side === (run[leg + "Side"] === "BUY" ? "long" : "short"));
          if (matches.length !== 1 || Math.abs(matches[0].quantity - run.hedgedQuantity) > run.quantity * 1e-6) throw new Error(run.symbol + ": состав позиции изменился вне хеджа. Проверьте обе биржи.");
          if (!Number.isFinite(matches[0].unrealizedPnl)) throw new Error(run.symbol + ": биржа не вернула PnL");
          pnl[leg] += matches[0].unrealizedPnl;
        }
      }
      const targetProfit = this.engines.reduce((sum, engine) => sum + targetPnlBasis(engine.snapshot(), c.hedgePercent).threshold, 0);
      this.publish({ state: "monitoring", active: true, currentPnl: pnl, targetProfit, error: undefined, requiresAttention: false });
      if (Math.abs(pnl.target) >= targetProfit) {
        const stopped = await this.stop("market");
        if (!this.manualStop && stopped.closeStatus === 'closed') this.publish({ state: "completed", active: false, result: { targetProfit: pnl.target, sourcePnl: pnl.source, netPnl: pnl.target + pnl.source, tradingVolume: this.confirmedVolume(), provisional: true } });
      }
    } catch (error) {
      if (!this.stopRequested) this.publish({ state: "monitoring_stale", active: true, requiresAttention: true, error: error.message });
      // A network failure must not silently stop monitoring an open hedge.
    }
  }
  confirmedVolume() {
    const orders = this.engines.flatMap((e) => e.orders());
    if (orders.some((o) => o.executedQuantity > 0 && !(o.averagePrice > 0))) return null;
    return orders.reduce((sum, o) => sum + o.executedQuantity * (o.averagePrice || 0), 0);
  }
  stopLocally() {
    this.stopRequested = true; this.manualStop = true; this.botStopped = true; this.blockEntries = true;
    this.appStoppedAt ??= this.now();
    clearTimeout(this.monitorTimer); this.pendingStop = null; this.reconciliations?.clear();
    // Each engine's local stop is synchronous up to its returned resolved Promise.
    // Never await an existing entry, read, cancel or market-close operation here.
    for (const engine of this.engines) engine.stop('app-only').catch(() => {});
    return this.publish({});
  }
  pause(closeStatus = this.state.closeStatus || 'not_requested') {
    if (this.manualStop) return this.state;
    this.stopRequested = true; this.botStopped = true; this.blockEntries = true;
    this.appStoppedAt ??= this.now();
    clearTimeout(this.monitorTimer);
    for (const engine of this.engines) engine.pause();
    return this.publish({ state: 'stopped', active: false, closeStatus, stopMode: closeStatus === 'not_requested' ? 'pause' : 'market',
      requiresAttention: Boolean(this.state.lossLimitReached || this.engines.some(engine => engine.orders().length && engine.run.closeStatus !== 'closed')),
      closeError: closeStatus === 'closing' ? undefined : this.state.closeError, error: undefined, notice: undefined });
  }
  async stop(mode = "app-only") {
    if (!["app-only", "market", "pause"].includes(mode)) throw new Error("Неизвестный способ остановки");
    if (mode === 'app-only') return this.stopLocally();
    if (mode === 'pause') return this.pause();
    if (this.manualStop) return this.state;
    if (this.stopPromise) return this.stopPromise;
    if (this.state.closeStatus === 'closed') return this.state;
    this.pause('closing');
    this.stopPromise = (async () => {
      await this.runPromise;
      if (this.manualStop) return this.state;
      const results = await Promise.allSettled(this.engines.map((engine) => engine.stop(mode)));
      if (this.manualStop) return this.state;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) return this.publish({ requiresAttention: true, closeStatus: 'failed', closeError: failures.map((r) => r.reason.message).join("; ") });
      return this.publish({ state: "stopped", active: false, requiresAttention: false, closeStatus: 'closed', closeError: undefined, stopMode: mode, error: undefined });
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}
module.exports = { HedgeSession, shuffle };
