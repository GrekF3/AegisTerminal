const crypto = require('node:crypto');
const { HedgeSession } = require('./hedge-session.cjs');
const { AdaptiveHedgeEngine } = require('./adaptive-hedge-engine.cjs');
const { executionPolicy } = require('./execution-policy.cjs');
const { allocation, buildPlan } = require('./hedge-plan.cjs');
const { targetPnlBasis } = require('./pnl-target.cjs');
const { closeRetryDelay } = require('./close-retry.cjs');
const { protectionBudget, feeEstimate } = require('./server-protection.cjs');

function lossLimit(value = 5) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Лимит лузов: целое число от 0; 0 — без ограничения');
  return n;
}
function realizedGross(engine) {
  const result = { source: 0, target: 0, volume: 0 };
  for (const leg of ['source', 'target']) {
    const orders = engine.orders().filter(o => o.leg === leg);
    let opened = 0, closed = 0;
    for (const o of orders) {
      if (!['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(o.status)) throw new Error('Результат заявки ещё не подтверждён');
      const q = Number(o.executedQuantity);
      if (!Number.isFinite(q) || q < 0 || (q > 0 && !(o.averagePrice > 0))) throw new Error('Нет подтверждённой цены исполнения');
      if (o.reduceOnly) closed += q; else opened += q;
      result[leg] += (o.side === 'SELL' ? 1 : -1) * q * (o.averagePrice || 0);
      result.volume += q * (o.averagePrice || 0);
    }
    if (Math.abs(opened - closed) > Math.max(opened, 1e-8) * 1e-8) throw new Error('Пара ещё не закрыта полностью');
  }
  const fees = feeEstimate(engine.snapshot(), engine.orders());
  return { ...result, fees, net: { source: result.source - fees.source, target: result.target - fees.target,
    total: result.source + result.target - fees.total } };
}

// One Start owns a session, not a single order. Entry is serialized across coins;
// the separate monitor keeps watching already-open pairs while a limit is filling.
class ContinuousHedgeSession extends HedgeSession {
  constructor(options) {
    super(options);
    this.autoSchedule = options.autoSchedule !== false;
    this.entryPromise = null; this.tickPromise = null; this.retry = new Map(); this.cursor = 0;
    this.blockEntries = false; this.archived = new Set(); this.pnlMissing = new Map();
    this.reconciliations = new Map(); this.pendingStop = null; this.reconcilePromise = null;
    this.protectionRecoveryPending = false;
  }
  start(input) {
    if (this.entryPromise || this.tickPromise || this.reconcilePromise || this.stopPromise) throw new Error('Предыдущая операция ещё завершается; дождитесь окончания запросов перед новым запуском');
    if (this.state.active || this.state.requiresAttention) throw new Error('Сначала завершите текущую сессию');
    if (input.dryRun !== false || input.liveConfirmation !== 'LIVE_TRADING_CONFIRMED') throw new Error('Автосессия требует подтверждения реальной торговли');
    this.allocations = allocation(input);
    if (input.source === input.target) throw new Error('Выберите две разные биржи');
    const maxLosses = lossLimit(input.maxLosses);
    const hedgePercent = Number(input.hedgePercent ?? 98);
    if (!Number.isFinite(hedgePercent) || hedgePercent <= 0 || hedgePercent > 100) throw new Error('Цель PnL: больше 0 и не выше 100% маржи');
    this.config = { ...input, maxLosses, hedgePercent };
    this.engines = []; this.stopRequested = false; this.manualStop = false; this.botStopped = false; this.appStoppedAt = undefined; this.blockEntries = false; this.retry.clear(); this.archived.clear(); this.pnlMissing.clear();
    this.reconciliations.clear(); this.pendingStop = null;
    this.publish({ id: crypto.randomUUID(), strategy: 'continuous-intraday', source: input.source, target: input.target,
      symbols: this.allocations.map(a => a.symbol), totalMargin: input.totalMargin, hedgePercent, maxLosses, lossCount: 0,
      completedRounds: 0, completedOrders: 0, realizedGross: { source: 0, target: 0 }, tradingVolume: 0,
      realizedNet: { source: 0, target: 0, total: 0 }, estimatedFees: 0, targetGoal: Number(input.totalMargin) * hedgePercent / 100,
      remainingTarget: Number(input.totalMargin) * hedgePercent / 100,
      lossLimitReached: false, startedAt: this.now(), state: 'preparing', active: true, requiresAttention: false,
      dryRun: false, manualStop: false, manualManagement: false, botStopped: false, closeStatus: undefined, closeError: undefined, appStoppedAt: undefined, execution: executionPolicy(this.sourceAdapter, this.targetAdapter, input), totalOrders: this.allocations.length, error: undefined, notice: undefined, result: undefined });
    this.scheduleMonitor();
    return this.state;
  }
  scheduleMonitor() {
    clearTimeout(this.monitorTimer);
    const closingRetry = Boolean(this.pendingStop && this.botStopped && !this.manualStop);
    if (!this.autoSchedule || (!closingRetry && (this.stopRequested || this.state.requiresAttention || !this.state.active))) return;
    this.monitorTimer = setTimeout(() => {
      this.tick().catch(error => this.emergency(error)).finally(() => this.scheduleMonitor());
    }, 1000);
    this.monitorTimer.unref?.();
  }
  emergency(error) {
    if (this.manualStop) return this.state;
    this.pendingStop = null; this.reconciliations.clear();
    this.blockEntries = true;
    for (const engine of this.engines) engine.stopRequested = true;
    if (this.botStopped) return this.publish({ state: 'stopped', active: false, requiresAttention: true, closeStatus: 'failed', closeError: error.message, error: undefined });
    return this.publish({ state: 'emergency', active: true, requiresAttention: true, error: error.message });
  }
  canEnter() { return !this.stopRequested && !this.blockEntries && !this.reconciliations.size && !this.state.lossLimitReached && !this.state.requiresAttention; }
  waitForHistory(engine, error, reason) {
    if (this.stopRequested || this.manualStop) return false;
    if (error.code !== 'ORDER_PENDING_HISTORY') return false;
    const previous = this.reconciliations.get(engine.run.id);
    const since = previous?.since ?? this.now();
    if (this.now() - since >= 300000) return false;
    const failures = (previous?.failures || 0) + 1;
    this.reconciliations.set(engine.run.id, { engine, since, failures, reason, at: this.now() + Math.min(10000, failures * 2000) });
    this.publish({ state: 'waiting_exchange', active: true, requiresAttention: false, error: undefined,
      notice: { code: 'order_reconciliation', level: this.now()-since >= 60000 ? 'warning' : 'info', since,
        message: `${engine.run.symbol}: сверяем исполнение LBank автоматически; новые входы ждут подтверждения.` } });
    return true;
  }
  async reconcileOnce() {
    for (const [id, item] of this.reconciliations) {
      if (this.stopRequested || this.state.requiresAttention) return;
      if (this.now() < item.at) continue;
      try {
        if (item.reason === 'entry_recovered' && !item.engine.botStopped && !item.engine.run.closeOrders.length && typeof item.engine.resumeEntry === 'function') {
          await item.engine.resumeEntry();
          if (this.stopRequested || this.state.requiresAttention) return;
          if (item.engine.state === 'running') {
            if (!item.engine.run.serverProtected) await item.engine.ensureProtection();
            item.engine.run.pnlTarget = targetPnlBasis(item.engine.snapshot(), item.engine.run.effectiveHedgePercent ?? this.config.hedgePercent);
            item.engine.checkpoint();
            this.reconciliations.delete(id); this.retry.delete(item.engine.run.symbol);
            this.publish({ state: 'monitoring', completedOrders: this.state.completedOrders + 1, error: undefined, notice: undefined });
            continue;
          }
        } else {
        // stop() first reads every existing intent. It closes only the journal's
        // confirmed remaining exposure; accepted close intents are never resent.
          await item.engine.stop('market');
        }
        if (this.stopRequested || this.state.requiresAttention) return;
        await this.archive(item.engine, item.reason);
        if (this.stopRequested || this.state.requiresAttention) return;
        this.engines = this.engines.filter(engine => engine !== item.engine);
        this.reconciliations.delete(id);
        for (const leg of ['source', 'target']) this.pnlMissing.delete(`${id}:${leg}`);
        this.publish({ state: 'monitoring', error: undefined, notice: undefined });
        if (this.state.lossLimitReached) { await this.stop('market'); return; }
      } catch (error) {
        if (this.stopRequested || this.state.requiresAttention) return;
        if (!this.waitForHistory(item.engine, error, item.reason)) { this.emergency(error); return; }
      }
    }
  }
  tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.step().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
  async step() {
    if (this.pendingStop && this.now() >= this.pendingStop.at && !this.manualStop) {
      await this.stop(this.state.stopMode || 'market'); return;
    }
    if (this.stopRequested || this.state.requiresAttention) return;
    if(this.protectionRecoveryPending) {
      this.publish({state:'recovering_protection',active:true,requiresAttention:false,error:undefined,
        notice:{code:'protection_recovery',level:'info',message:'Проверяем серверные TP/SL после перезапуска; новые входы временно заблокированы.'}});
      try {
        for(const engine of this.engines) {
          if(engine.state!=='running' || engine.run.serverProtected!==true) throw new Error(`${engine.run.symbol}: журнал не подтверждает защищённую открытую пару`);
          await engine.ensureProtection();
        }
        this.protectionRecoveryPending=false;this.blockEntries=false;
        this.publish({state:'monitoring',active:true,requiresAttention:false,error:undefined,notice:undefined});
      } catch(error) { this.protectionRecoveryPending=false;this.emergency(error); }
      return;
    }
    if (this.reconciliations.size && !this.reconcilePromise) {
      // History reads can take seconds. Other running coins must keep receiving
      // their ordinary PnL checks while this single-flight recovery is pending.
      this.reconcilePromise = this.reconcileOnce().catch(error => this.emergency(error)).finally(() => { this.reconcilePromise = null; });
    }
    const ready = await this.monitorOnce();
    if (!ready || !this.canEnter() || this.entryPromise) return;
    for (let n = 0; n < this.allocations.length; n++) {
      const index = (this.cursor + n) % this.allocations.length;
      const item = this.allocations[index];
      if (this.engines.some(e => e.run?.symbol === item.symbol) || (this.retry.get(item.symbol)?.at || 0) > this.now()) continue;
      this.cursor = (index + 1) % this.allocations.length;
      this.entryPromise = this.enter(item).catch(e => this.emergency(e)).finally(() => { this.entryPromise = null; });
      break;
    }
  }
  waitFor(item, error) {
    const failures = (this.retry.get(item.symbol)?.failures || 0) + 1;
    const at = this.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
    this.retry.set(item.symbol, { failures, at });
    this.publish({ state: 'waiting_retry', active: true, currentSymbol: item.symbol, nextRetryAt: at, error: error.message });
  }
  async enter(item) {
    let engine;
    try {
      const c = this.config;
      const plan = await buildPlan({ ...c, symbols: [item.symbol], totalMargin: item.margin, leverageBySymbol: { [item.symbol]: item.leverage } }, this.sourceAdapter, this.targetAdapter);
      if (!this.canEnter()) return;
      const leg = plan.legs[0];
      if (leg.impact.impactPercent > 0.01 && !c.acceptImpact) throw new Error(`${item.symbol}: ожидаем стакан с потерями входа не выше 0.01%`);
      this.publish({ state: 'configuring_leverage', currentSymbol: item.symbol, plan, error: undefined, nextRetryAt: undefined });
      await this.sourceAdapter.configureLeverage(c.sourceCredentials, { ...leg, side: leg.targetSide === 'BUY' ? 'SELL' : 'BUY' }, { allowLiveTrading: true });
      if (!this.canEnter()) return;
      await this.targetAdapter.configureLeverage(c.targetCredentials, { ...leg, side: leg.targetSide }, { allowLiveTrading: true });
      if (!this.canEnter()) return;
      // Re-read all sizing and market inputs after leverage changes, before the first order.
      const fresh = (await buildPlan({ ...c, symbols: [item.symbol], totalMargin: item.margin, leverageBySymbol: { [item.symbol]: item.leverage } }, this.sourceAdapter, this.targetAdapter)).legs[0];
      if (!this.canEnter()) return;
      if (fresh.targetSide !== leg.targetSide) throw new Error(`${item.symbol}: тренд изменился, пересчитываем вход`);
      if (fresh.impact.impactPercent > 0.01 && !c.acceptImpact) throw new Error(`${item.symbol}: ожидаем подходящую ликвидность`);
      const protection = protectionBudget({ requestedPercent: c.hedgePercent, leverage: fresh.leverage, feeRates: fresh.feeRates });
      engine = new AdaptiveHedgeEngine({ sourceAdapter: this.sourceAdapter, targetAdapter: this.targetAdapter, sleep: this.sleep, now: this.now });
      this.engines.push(engine);
      engine.on('state', value => this.publish({ ...(!this.stopRequested && !this.blockEntries && !this.reconciliations.has(value.id) ? { state: value.state, currentSymbol: item.symbol } : {}) }));
      await engine.start({ ...c, ...fresh, requestedHedgePercent: c.hedgePercent,
        effectiveHedgePercent: protection.effectiveNetPercent, protectionMoveRatio: protection.moveRatio,
        protectionBudget: protection });
      if (!this.canEnter()) return;
      await engine.ensureProtection();
      if (!this.canEnter()) return;
      engine.run.pnlTarget = targetPnlBasis(engine.snapshot(), protection.effectiveNetPercent);
      engine.run.protectionBudget = protection;
      engine.checkpoint();
      this.retry.delete(item.symbol);
      this.publish({ state: 'monitoring', completedOrders: this.state.completedOrders + 1, error: undefined });
    } catch (error) {
      if (this.stopRequested) return;
      if (engine) {
        if (engine.snapshot().active) {
          if (this.waitForHistory(engine, error, 'entry_recovered')) return;
          // A balanced pair must never remain unprotected because one venue
          // rejected TP/SL. Unwind its confirmed owned exposure immediately.
          try {
            await engine.stop('market');
            await this.archive(engine,'protection_setup_failed');
            this.engines=this.engines.filter(item=>item!==engine);
            if(this.canEnter())this.waitFor(item,error);
          } catch(closeError) { this.emergency(closeError); }
          return;
        }
        // Engine recovered both legs, but a real losing fill still counts.
        await this.archive(engine, 'entry_recovered');
        this.engines = this.engines.filter(e => e !== engine);
        if (this.state.lossLimitReached) { await this.stop('market'); return; }
      }
      if (this.canEnter()) this.waitFor(item, error);
    }
  }
  async archive(engine, reason) {
    if (this.manualStop) return;
    if (engine.run.roundRecorded || this.archived.has(engine.run.id)) return;
    if (engine.archivePromise) return engine.archivePromise;
    engine.archivePromise = this.recordRound(engine, reason);
    try { return await engine.archivePromise; } finally { engine.archivePromise = null; }
  }
  async recordRound(engine, reason) {
    for (const order of engine.orders()) {
      if (this.manualStop) return;
      if (order.executedQuantity > 0 && !(order.averagePrice > 0)) await engine.readOrder(order);
    }
    if (this.manualStop) return;
    const pnl = realizedGross(engine);
    const loss = pnl.net.target < -1e-8;
    const count = this.state.lossCount + Number(loss);
    const limit = this.config.maxLosses > 0 && count >= this.config.maxLosses;
    // History must be durable before dropping the finished run from the live journal.
    this.emit('round', { ...this.state, id: engine.run.id, sessionId: this.state.id, symbols: [engine.run.symbol], totalMargin: engine.run.margin,
      state: 'completed', active: false, startedAt: engine.run.startedAt, updatedAt: this.now(), reason,
      lossCount: count, outcome: loss ? 'loss' : pnl.net.target > 1e-8 ? 'win' : 'flat', runs: [engine.snapshot()],
      result: { targetProfit: pnl.net.target, sourcePnl: pnl.net.source, netPnl: pnl.net.total, estimatedFees: pnl.fees.total, tradingVolume: pnl.volume, provisional: true } });
    // Counter and marker enter the same atomic session snapshot. Recovery must not
    // count a closed run again if a crash preceded removal from the live engine list.
    engine.run.roundRecorded = true;
    this.archived.add(engine.run.id);
    // Bounded memory. A run is removed immediately after this call, so only recent IDs are needed.
    if (this.archived.size > 100) this.archived.delete(this.archived.values().next().value);
    const realizedNet = { source: Number(this.state.realizedNet?.source || 0) + pnl.net.source,
      target: Number(this.state.realizedNet?.target || 0) + pnl.net.target,
      total: Number(this.state.realizedNet?.total || 0) + pnl.net.total };
    const targetGoal = Number(this.state.targetGoal || Number(this.config.totalMargin) * this.config.hedgePercent / 100);
    this.publish({ lossCount: count, lossLimitReached: this.state.lossLimitReached || limit, completedRounds: this.state.completedRounds + 1,
      realizedGross: { source: this.state.realizedGross.source + pnl.source, target: this.state.realizedGross.target + pnl.target },
      realizedNet, estimatedFees: Number(this.state.estimatedFees || 0) + pnl.fees.total,
      remainingTarget: Math.max(0, targetGoal - realizedNet.target), tradingVolume: this.state.tradingVolume + pnl.volume });
    if (limit) this.blockEntries = true;
  }
  async monitorOnce() {
    if (this.stopRequested) return false;
    const running = this.engines.filter(e => e.state === 'running');
    if (!running.length) return true;
    let positions;
    try { positions = await Promise.all([this.sourceAdapter.getPositions(this.config.sourceCredentials), this.targetAdapter.getPositions(this.config.targetCredentials)]); }
    catch (error) {
      if (!this.stopRequested) this.publish(error.code==='SNAPSHOT_REFRESH_PENDING'
        ? {state:'waiting_exchange',error:undefined,notice:{code:'position_sync',level:'info',message:'Обновляем позиции после исполнения заявки…'}}
        : {state:'waiting_exchange',error:error.message});
      return false;
    }
    if (this.stopRequested || this.blockEntries) return false;
    const total = { source: 0, target: 0 }, missing = [];
    const close = [];
    for (const engine of running) {
      const run = engine.snapshot(), pnl = {};
      for (const [index, leg] of ['source', 'target'].entries()) {
        const found = positions[index].filter(p => p.symbol === run.symbol && p.side === (run[leg + 'Side'] === 'BUY' ? 'long' : 'short') && p.isOwn !== false);
        const quantity = found.reduce((sum, p) => sum + Number(p.quantity), 0);
        if (!found.length || found.some(p => !(Number(p.quantity) > 0)) || !Number.isFinite(quantity) || Math.abs(quantity - run.hedgedQuantity) > run.quantity * 1e-6) {
          if (run.serverProtected) { if (!close.includes(engine)) close.push(engine); pnl[leg] = null; total[leg] = null; continue; }
          this.emergency(new Error(run.symbol + ': позиция изменена вне сессии. Новые входы остановлены; нужна сверка.')); return false;
        }
        const protection=(run.protections||[]).find(item=>item.leg===leg && ['ACTIVE','LIVE','NEW'].includes(String(item.status).toUpperCase()));
        const stopPrice=Number(protection?.stopLossPrice), long=run[leg+'Side']==='BUY';
        const boundaryCrossed=stopPrice>0 && found.some(position=>Number(position.markPrice)>0 && (long?Number(position.markPrice)<=stopPrice:Number(position.markPrice)>=stopPrice));
        const liquidationOutsideStop=stopPrice>0 && found.some(position=>Number(position.liquidationPrice)>0 && (long?Number(position.liquidationPrice)>=stopPrice:Number(position.liquidationPrice)<=stopPrice));
        if((boundaryCrossed||liquidationOutsideStop) && !close.includes(engine)) close.push(engine);
        const key = `${run.id}:${leg}`;
        if (found.some(p => !Number.isFinite(p.unrealizedPnl))) {
          if (!this.pnlMissing.has(key)) this.pnlMissing.set(key, this.now());
          missing.push({symbol:run.symbol,exchange:this.config[leg],leg,since:this.pnlMissing.get(key)});
          pnl[leg]=null; total[leg]=null;
        } else {
          this.pnlMissing.delete(key); pnl[leg]=found.reduce((sum, p) => sum + p.unrealizedPnl, 0);
          if(total[leg]!==null) total[leg]+=pnl[leg];
        }
      }
      // Percent applies to the actually filled target entry margin, symmetrically
      // for TP and SL. Missing source PnL cannot disable a known target threshold.
      const basis = targetPnlBasis(run, run.effectiveHedgePercent ?? this.config.hedgePercent);
      engine.run.pnlTarget = basis;
      if (Number.isFinite(pnl.target) && Math.abs(pnl.target) >= basis.threshold && !close.includes(engine)) close.push(engine);
    }
    const since=missing.length?Math.min(...missing.map(item=>item.since)):undefined;
    const delayed=since!=null && this.now()-since>=15000;
    this.publish({ state: missing.length?'waiting_pnl':this.reconciliations.size?'waiting_exchange':'monitoring', currentPnl: total, error: undefined,
      notice:missing.length?{code:'pnl_pending',level:delayed?'warning':'info',since,
        message:delayed?'PnL задерживается. Новые входы ждут актуальных данных.':'Синхронизация PnL…',exchanges:[...new Set(missing.map(item=>item.exchange))]}:this.reconciliations.size?this.state.notice:undefined });
    for (const engine of close) {
      if (this.stopRequested) return false;
      try {
        await engine.stop('market');
        if (this.manualStop) return false;
        await this.archive(engine, 'pnl_threshold');
        if (this.manualStop) return false;
        this.engines = this.engines.filter(e => e !== engine);
        for(const leg of ['source','target']) this.pnlMissing.delete(`${engine.run.id}:${leg}`);
        this.publish({ state: 'monitoring', notice: undefined, currentPnl: undefined });
      } catch (error) {
        if (this.manualStop) return false;
        if (!this.waitForHistory(engine, error, 'pnl_threshold')) this.emergency(error);
        return false;
      }
      if (this.state.lossLimitReached) {
        // Do not await entryPromise here: it may be handling this same limit.
        this.stop('market').catch(error => this.emergency(error));
        return false;
      }
      if (Number(this.state.realizedNet?.target) >= Number(this.state.targetGoal)) {
        this.blockEntries = true;
        const remaining = this.engines.filter(item => item.state === 'running');
        for (const open of remaining) { await open.stop('market'); await this.archive(open, 'session_goal'); }
        this.engines = this.engines.filter(item => !remaining.includes(item));
        if (Number(this.state.realizedNet?.target) >= Number(this.state.targetGoal)) {
          this.stopRequested = true;
          this.botStopped = true;
          this.appStoppedAt = this.now();
          this.publish({ state: 'completed', active: false, botStopped: true, closeStatus: 'closed', stopMode: 'market',
            remainingTarget: 0, result: { targetProfit: this.state.realizedNet.target, sourcePnl: this.state.realizedNet.source,
              netPnl: this.state.realizedNet.total, estimatedFees: this.state.estimatedFees, tradingVolume: this.state.tradingVolume } });
          return false;
        }
        this.blockEntries = false;
      }
    }
    return missing.length===0;
  }
  async stop(mode = 'app-only') {
    if (!['app-only', 'market', 'pause'].includes(mode)) throw new Error('Неизвестный способ остановки');
    if (mode === 'app-only') return this.stopLocally();
    if (mode === 'pause') return this.pause();
    if (this.manualStop) return this.state;
    if (this.stopPromise) return this.stopPromise;
    if (this.state.closeStatus === 'closed') return this.state;
    if (this.pendingStop && this.now() < this.pendingStop.at) return this.state;
    this.pause('closing');
    this.stopPromise = (async () => {
      // Entry checks stopRequested after every awaited preflight step. Existing engines
      // are stopped immediately; do not wait for the target's ordinary fill timeout.
      const results = await Promise.allSettled(this.engines.map(e => e.stop(mode)));
      if (this.manualStop) return this.state;
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
      if (errors.length) {
        const since = this.pendingStop?.since ?? this.now();
        const delays = errors.map(closeRetryDelay);
        if (delays.every(delay => delay !== null) && this.now() - since < 300000) {
          const delay = Math.max(...delays);
          const limited = errors.some(error => Number(error.httpStatus || error.status) === 429);
          this.pendingStop = { since, at: this.now() + delay };
          this.publish({ state: 'stopped', active: false, requiresAttention: true, closeStatus: 'waiting_confirmation', closeError: undefined, error: undefined,
            notice: { code: limited ? 'close_rate_limit' : 'order_reconciliation', level: 'info', since,
              message: limited ? `Биржа ограничила частоту запросов. Продолжим сверку и закрытие автоматически через ${Math.ceil(delay / 1000)} с. Бот остановлен.` : 'Бот остановлен. Сверяем исполнение ранее принятого ордера; закрытие ещё не подтверждено.' } });
          this.scheduleMonitor();
          return this.state;
        }
        return this.emergency(new Error([...new Set(errors.map(error => error.message))].join('; ')));
      }
      this.pendingStop = null; this.reconciliations.clear();
      if (mode === 'market') for (const engine of [...this.engines]) {
        try { await this.archive(engine, this.state.lossLimitReached ? 'loss_limit' : 'user_stop'); }
        catch (error) { return this.emergency(error); }
        if (this.manualStop) return this.state;
      }
      const limited = this.state.lossLimitReached;
      return this.publish({ state: limited ? 'loss_limit' : 'stopped', active: false, requiresAttention: limited, stopMode: mode,
        closeStatus: 'closed', closeError: undefined, error: undefined,
        notice: limited ? { code: 'loss_limit', level: 'warning', message: `Лимит лузов достигнут: ${this.state.lossCount}/${this.config.maxLosses} на целевой бирже за сессию. Новые входы заблокированы до сброса администратором.` } : undefined });
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}
module.exports = { ContinuousHedgeSession, lossLimit, realizedGross };
