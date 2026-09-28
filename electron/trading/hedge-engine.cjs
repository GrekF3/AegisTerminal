const { EventEmitter } = require("events");
const crypto = require("crypto");
const { floorToStep } = require("../exchanges/order-sizing.cjs");
const { runOrders } = require('./run-orders.cjs');
const { bracketForSide } = require('./server-protection.cjs');
const CLOSED = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
const opposite = (side) => side === "BUY" ? "SELL" : "BUY";
const quantityOf = (order) => Number(order?.executedQuantity || 0);

class HedgeEngine extends EventEmitter {
  constructor({ sourceAdapter, targetAdapter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
    super(); Object.assign(this, { sourceAdapter, targetAdapter, sleep, now });
    this.state = "idle"; this.run = null; this.stopRequested = false; this.manualStop = false; this.botStopped = false; this.startPromise = null; this.stopPromise = null;
  }
  snapshot() { const state = this.manuallyStopped() || this.botStopped ? 'stopped' : this.state; return { ...this.run, state, active: !["idle", "stopped", "error", "completed"].includes(state) }; }
  transition(state, patch = {}) {
    // A local stop owns the rest of this run, including late network callbacks.
    // Keep their confirmed journal updates without reactivating the bot.
    if (this.manuallyStopped()) {
      state = 'stopped';
      patch = { ...patch, manualStop: true, manualManagement: true, botStopped: true, closeStatus: 'not_requested', closeError: undefined, stopMode: 'app-only', stopProgress: { phase: 'done' }, error: undefined, errorCode: undefined };
      delete patch.closedQuantity;
    } else if (this.botStopped) {
      state = 'stopped';
      patch = { ...patch, botStopped: true, error: undefined, errorCode: undefined };
    }
    this.state = state; this.run = { ...this.run, ...patch, updatedAt: this.now() };
    this.emit("state", this.snapshot()); return this.snapshot();
  }
  async start(input) {
    this.assertEntryAllowed();
    if (this.run) throw new Error("Этот торговый цикл уже использован");
    const { symbol, quantity, price, targetSide } = input;
    if (!/^[A-Z0-9]{4,24}$/.test(symbol) || !(quantity > 0) || !(price > 0) || !["BUY", "SELL"].includes(targetSide)) throw new Error("Некорректные параметры хеджа");
    this.config = { ...input, marginMode: require('./margin-mode.cjs').marginMode(input.marginMode), sourceSide: opposite(targetSide) };
    if (input.dryRun === false) {
      if (input.liveConfirmation !== "LIVE_TRADING_CONFIRMED") throw new Error("Live trading требует отдельного подтверждения");
      for (const adapter of [this.sourceAdapter, this.targetAdapter]) {
        if (!["placeOrder", "getOrder", "cancelOrder"].every((method) => typeof adapter?.[method] === "function")) throw new Error("Live trading недоступен: нет полного набора place/status/cancel");
      }
    }
    this.run = { id: crypto.randomUUID(), symbol, quantity, marginMode: this.config.marginMode, leverage: input.leverage, margin: input.margin, targetSide, sourceSide: opposite(targetSide), hedgedQuantity: 0, dryRun: input.dryRun !== false, startedAt: this.now(), targetOrder: null, sourceOrders: [], closeOrders: [], protections: [], feeRates: input.feeRates, requestedHedgePercent: input.requestedHedgePercent, effectiveHedgePercent: input.effectiveHedgePercent, protectionMoveRatio: input.protectionMoveRatio };
    this.transition("preparing");
    this.startPromise = this.execute().catch(async (error) => {
      if (this.manuallyStopped() || this.botStopped) return this.snapshot();
      this.transition("emergency", { error: error.message, errorCode: error.code });
      // Never compensate while the outcome of an earlier request is unknown.
      if (error.code !== 'ORDER_PENDING_HISTORY' && !this.stopRequested && this.orders().every((o) => o.status !== "UNKNOWN")) {
        try { await this.settle("market"); this.transition("error", { error: error.message + ". Открытые ноги закрыты, исполнения подтверждены." }); }
        catch (recoveryError) {
          if (this.manuallyStopped()) return this.snapshot();
          this.transition("emergency", { error: error.message + ". Требуется проверка: " + recoveryError.message, errorCode: recoveryError.code });
          if (recoveryError.code === 'ORDER_PENDING_HISTORY') throw recoveryError;
        }
      }
      if (this.manuallyStopped()) return this.snapshot();
      throw error;
    });
    return this.startPromise;
  }
  orders() { return runOrders(this.run); }
  opened(leg) { return this.orders().filter(o => o.leg === leg && !o.reduceOnly).reduce((sum, o) => sum + quantityOf(o), 0); }
  venue(leg) { return { adapter: this[leg + "Adapter"], credentials: this.config[leg + "Credentials"] }; }
  checkpoint() { return this.transition(this.state); }
  manuallyStopped() { return this.manualStop || this.run?.manualStop === true; }
  assertNotManuallyStopped() {
    if (this.manuallyStopped()) throw Object.assign(new Error('Бот остановлен: позиции и заявки переданы под ручное управление'), { code: 'LOCAL_STOP_REQUESTED' });
  }
  assertEntryAllowed() {
    this.assertNotManuallyStopped();
    if (this.stopRequested || this.botStopped) throw Object.assign(new Error('Бот остановлен: новый вход отменён'), { code: 'BOT_STOPPED' });
  }
  pause(closeStatus = this.run?.closeStatus || 'not_requested') {
    this.stopRequested = true; this.botStopped = true;
    if (!this.run) return this.snapshot();
    return this.transition('stopped', { botStopped: true, closeStatus, closeError: closeStatus === 'closing' ? undefined : this.run.closeError });
  }
  async submit(leg, type, quantity, side, reduceOnly = false, options = {}) {
    this.assertNotManuallyStopped();
    if (!reduceOnly) this.assertEntryAllowed();
    const config = this.config;
    const { adapter, credentials } = this.venue(leg);
    const clientOrderId = (config[leg] === "gateio" ? "t-" : "") + "h" + crypto.randomBytes(12).toString("hex");
    const order = { leg, symbol: config.symbol, clientOrderId, quantity, side, type, reduceOnly, status: "UNKNOWN", executedQuantity: 0, createdAt: this.now(), ...(options.positionId ? { positionId: options.positionId } : {}), ...(type === 'LIMIT' ? { price: options.price ?? config.price, postOnly: options.postOnly === true } : {}) };
    // Old journals had cross defaults. Never reinterpret an existing run as isolated.
    const legacyMode=config[leg]==='mexc'?(Number(credentials?.openType||1)===1?'isolated':'cross'):'cross';
    const request = { ...order, marginMode: config.marginMode || (reduceOnly ? legacyMode : 'isolated'), volume: quantity, leverage: config.leverage, ...(options.deadline != null ? { expiresAt: options.deadline } : {}) };
    const prepared = adapter.prepareOrder ? await adapter.prepareOrder(request, credentials) : request;
    this.assertNotManuallyStopped();
    if (!reduceOnly) this.assertEntryAllowed();
    // A slow preparation must not start a maker attempt after its risk deadline.
    if (options.deadline != null && this.now() >= options.deadline) return null;
    if (Math.abs(Number(prepared.baseQuantity ?? prepared.quantity) - quantity) > quantity * 1e-8) throw new Error(config.symbol + ": биржа округляет объём ноги; равный хедж невозможен");
    if (reduceOnly) this.run.closeOrders.push(order);
    else if (leg === "target") { if (this.run.targetOrders) this.run.targetOrders.push(order); else this.run.targetOrder = order; }
    else this.run.sourceOrders.push(order);
    this.checkpoint(); // Persist intent before it can reach an exchange.
    this.assertNotManuallyStopped();
    try {
      const placed = await adapter.placeOrder(credentials, prepared, { allowLiveTrading: true });
      Object.assign(order, { orderId: placed.orderId, clientOrderId: placed.clientOrderId || clientOrderId, status: "NEW" });
    } catch (error) {
      Object.assign(order, { errorCode: error.code, ...(error.exchangeCode != null ? { exchangeCode: String(error.exchangeCode) } : {}) });
      if (error.definitive === true) { order.status = "REJECTED"; this.checkpoint(); throw error; }
      // The request may have reached the venue. Preserve UNKNOWN and never
      // launch follow-up reconciliation after the user takes manual control.
      if (this.manuallyStopped()) { this.checkpoint(); this.assertNotManuallyStopped(); }
      if (this.botStopped && !reduceOnly) { this.checkpoint(); this.assertEntryAllowed(); }
      try { await this.readOrder(order); }
      catch (readError) {
        this.checkpoint();
        if (readError.code === 'ORDER_PENDING_HISTORY' && order.orderId) throw readError;
        throw new Error(error.message + ". Исход заявки неизвестен; повторная отправка заблокирована (" + clientOrderId + ").");
      }
    }
    this.checkpoint(); this.assertNotManuallyStopped(); if (!reduceOnly) this.assertEntryAllowed(); return order;
  }
  async readOrder(order) {
    this.assertNotManuallyStopped();
    if (order.status === "REJECTED") return order;
    const { adapter, credentials } = this.venue(order.leg);
    let failure, otherFailures = 0;
    const historyDeadline = this.now() + 15000;
    for (let attempt = 0; attempt < 32; attempt++) {
      this.assertNotManuallyStopped();
      if (this.botStopped && this.run.closeStatus === 'not_requested') this.assertEntryAllowed();
      try {
        const status = await adapter.getOrder(credentials, order);
        const executed = Number(status?.executedQty ?? status?.executedQuantity);
        if (!Number.isFinite(executed) || executed < 0 || executed > order.quantity * (1 + 1e-8)) throw new Error("Некорректный исполненный объём ордера");
        if (String(status.status).toUpperCase() === "FILLED" && Math.abs(executed - order.quantity) > order.quantity * 1e-8) throw new Error("FILLED не совпадает с полным объёмом заявки; исполнение требует проверки");
        if (executed + order.quantity * 1e-10 < order.executedQuantity) throw new Error("Биржа вернула устаревший статус ордера");
        if(status.orderId!=null) {
          const exactId=typeof status.orderId==='string' && status.orderId.length>0 ? status.orderId : Number.isSafeInteger(status.orderId) && status.orderId>0 ? String(status.orderId) : null;
          if(!exactId || (order.orderId!=null && String(order.orderId)!==exactId)) throw new Error('Подтверждение относится к другому или неточному ID ордера');
          order.orderId=exactId; // Persist exact ID recovered from the original request receipt.
        }
        const average = Number(status.avgPrice || status.avgPx || status.priceAvg || status.fill_price || status.dealAvgPrice || 0);
        Object.assign(order, { status: String(status.status).toUpperCase(), executedQuantity: executed, averagePrice: average > 0 ? average : null, updatedAt: this.now() });
        this.run.hedgedQuantity = Math.min(this.opened('source'), this.opened('target'));
        this.checkpoint(); this.assertNotManuallyStopped(); return order;
      } catch (error) {
        failure = error;
        if (Number(error.httpStatus || error.status) === 429 || error.code === 'SNAPSHOT_REFRESH_PENDING') throw error;
        if (error.code === 'ORDER_PENDING_HISTORY') {
          if (error.orderId != null) {
            const id = typeof error.orderId === 'string' && error.orderId.length > 0 ? error.orderId : null;
            if (!id || (order.orderId != null && String(order.orderId) !== id)) throw new Error('Сверка относится к другому или неточному ID ордера');
            order.orderId = id;
            this.checkpoint();
          }
          this.assertNotManuallyStopped();
          // Read-only reconciliation while the accepted order moves from the
          // active book to indexed history. Never resubmit or infer a zero fill.
          if (this.now() >= historyDeadline || attempt === 31) break;
          await this.sleep(Math.min(1000, Math.max(300, Number(error.retryAfterMs) || 500)));
        } else {
          this.assertNotManuallyStopped();
          if (++otherFailures >= 3) break;
          await this.sleep(300);
        }
      }
    }
    throw failure;
  }
  async confirmMarket(order) {
    await this.confirmTerminal(order);
    if (Math.abs(order.executedQuantity - order.quantity) <= order.quantity * 1e-8) return order;
    throw new Error(order.symbol + ": маркет-ордер исполнен не полностью (" + order.executedQuantity + "/" + order.quantity + ")");
  }
  async confirmTerminal(order) {
    this.assertNotManuallyStopped();
    for (let attempt = 0; attempt < 30; attempt++) {
      await this.readOrder(order);
      if (CLOSED.has(order.status)) return order;
      await this.sleep(300);
    }
    throw new Error(order.symbol + ": конечный результат ордера не подтверждён");
  }
  averageEntry(leg) {
    const orders = this.orders().filter(order => order.leg === leg && !order.reduceOnly && order.executedQuantity > 0);
    const quantity = orders.reduce((sum, order) => sum + Number(order.executedQuantity), 0);
    const notional = orders.reduce((sum, order) => sum + Number(order.executedQuantity) * Number(order.averagePrice || 0), 0);
    if (!(quantity > 0) || !(notional > 0)) throw new Error(`${this.run.symbol}: цена входа ${leg} не подтверждена`);
    return { quantity, price: notional / quantity };
  }
  positionSide(leg) { return this.config[`${leg}Side`] === 'BUY' ? 'long' : 'short'; }
  async reconcilePosition(leg, journalRemaining, reason = 'position_snapshot', exchangeError = null) {
    const { adapter, credentials } = this.venue(leg);
    if (typeof adapter.getPositions !== 'function') return { quantity: journalRemaining, supported: false };
    const all = await adapter.getPositions(credentials);
    if (!Array.isArray(all)) throw new Error(`${this.config[leg]}: снимок позиций имеет неверный формат`);
    const tolerance = Math.max(this.run.quantity * 1e-8, 1e-12);
    const own = all.filter(position => position.symbol === this.run.symbol && position.isOwn !== false);
    const oppositeQuantity = own.filter(position => position.side !== this.positionSide(leg))
      .reduce((sum, position) => sum + Number(position.quantity || 0), 0);
    if (!Number.isFinite(oppositeQuantity) || oppositeQuantity > tolerance) {
      throw Object.assign(new Error(`${this.run.symbol}: на ${this.config[leg]} найдена встречная позиция вне текущей ноги; автоматическое закрытие остановлено`), { code: 'POSITION_RECONCILIATION_MISMATCH' });
    }
    const quantity = own.filter(position => position.side === this.positionSide(leg))
      .reduce((sum, position) => sum + Number(position.quantity || 0), 0);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > journalRemaining + tolerance) {
      throw Object.assign(new Error(`${this.run.symbol}: фактическая позиция ${leg} (${quantity}) не совпадает с остатком журнала (${journalRemaining})`), { code: 'POSITION_RECONCILIATION_MISMATCH' });
    }
    const externallyClosed = journalRemaining - quantity;
    if (externallyClosed > tolerance) {
      const protection = [...(this.run.protections || [])].reverse().find(item => item.leg === leg);
      const observedPrice = Number(protection?.actualPrice || protection?.triggerPrice);
      const fallbackPrice = Number(this.averageEntry(leg).price);
      const averagePrice = observedPrice > 0 ? observedPrice : fallbackPrice;
      this.run.closeOrders.push({
        leg, symbol: this.run.symbol,
        clientOrderId: `observed-${exchangeError?.exchangeCode || protection?.orderId || 'position'}-${crypto.randomBytes(6).toString('hex')}`,
        orderId: protection?.orderId, quantity: externallyClosed, side: opposite(this.config[`${leg}Side`]),
        type: 'RECONCILIATION', reduceOnly: true, status: 'FILLED', executedQuantity: externallyClosed,
        averagePrice, createdAt: protection?.createdAt || this.now(), updatedAt: this.now(),
        observedClosed: true, nativeProtection: observedPrice > 0, provisionalPrice: !(observedPrice > 0),
        reconciliationReason: reason, exchangeCode: exchangeError?.exchangeCode,
      });
      this.checkpoint();
    }
    return { quantity, supported: true };
  }
  async ensureProtection() {
    if (this.run.dryRun) return [];
    if (!(this.config.protectionMoveRatio > 0)) throw new Error(`${this.run.symbol}: безопасный диапазон TP/SL не рассчитан`);
    const created = [];
    // Both venues receive the same absolute market boundaries, rounded only to
    // their own ticks. This minimizes the interval where one exchange has
    // triggered but the opposite leg has not.
    const protectionReference=this.averageEntry('target').price;
    for (const leg of ['source', 'target']) {
      this.assertEntryAllowed();
      const { adapter, credentials } = this.venue(leg);
      if (!adapter.supportsNativeProtection || !['placeProtection', 'getProtection', 'cancelProtection'].every(method => typeof adapter[method] === 'function')) {
        throw new Error(`${this.config[leg]}: серверные reduce-only TP/SL не поддерживаются; вход запрещён`);
      }
      const protectionVerificationAttempts = Math.min(40, Math.max(12, Number(adapter.protectionVerificationAttempts) || 12));
      const entry = this.averageEntry(leg);
      if (Math.abs(entry.quantity - this.run.hedgedQuantity) > this.run.quantity * 1e-8) throw new Error(`${this.run.symbol}: защита не совпадает с объёмом ноги`);
      this.run.protections ||= [];
      let protection=this.run.protections.find(item=>item.leg===leg && !['CANCELED','TRIGGERED','FILLED','REJECTED','FAILED'].includes(String(item.status).toUpperCase()));
      if(!protection) {
        const clientOrderId = `p${crypto.randomBytes(12).toString('hex')}`;
        const prices = bracketForSide({ side: this.config[`${leg}Side`], referencePrice: protectionReference,
          moveRatio: this.config.protectionMoveRatio, tickSize: this.config[`${leg}Rules`]?.tickSize, clientOrderId });
        protection = { leg, symbol: this.run.symbol, quantity: entry.quantity, side: this.config[`${leg}Side`],
          clientOrderId, ...prices, status: 'UNKNOWN', createdAt: this.now() };
        this.run.protections.push(protection);
        this.checkpoint();
      }
      const prices={takeProfitPrice:Number(protection.takeProfitPrice),stopLossPrice:Number(protection.stopLossPrice)};
      let verified=null;
      if(protection.placementAttemptedAt || protection.orderId) {
        try { verified=await adapter.getProtection(credentials,protection); }
        catch(error) {
          if(error.code==='PROTECTION_NOT_FOUND') throw new Error(`${this.config[leg]}: журнал содержит отправку TP/SL, но биржа её не подтверждает; повторная отправка заблокирована (${protection.clientOrderId})`);
          throw error;
        }
      } else {
        protection.placementAttemptedAt=this.now();this.checkpoint();
        try {
          const placed=await adapter.placeProtection(credentials, { ...protection, marginMode: this.config.marginMode,
            leverage: this.config.leverage }, { allowLiveTrading: true });
          Object.assign(protection, { orderId: placed.orderId, clientOrderId: placed.clientOrderId || protection.clientOrderId });
          this.checkpoint();
        } catch (error) {
          if (error.definitive === true) { protection.status = 'REJECTED'; this.checkpoint(); throw error; }
          // Query the exact journaled specification. Never submit a second TP/SL
          // while the first request may have reached the exchange.
          for(let attempt=0;attempt<protectionVerificationAttempts;attempt++) {
            try { verified=await adapter.getProtection(credentials, protection);break; }
            catch(reconcileError) {
              if(reconcileError.code!=='PROTECTION_NOT_FOUND') { this.checkpoint();throw new Error(`${this.config[leg]}: исход серверного TP/SL неизвестен; повторная отправка заблокирована (${protection.clientOrderId})`); }
              if(attempt<protectionVerificationAttempts-1) await this.sleep(250);
            }
          }
          if(!verified?.orderId) { this.checkpoint();throw new Error(`${this.config[leg]}: TP/SL не найден после неизвестного ответа; повторная отправка заблокирована (${protection.clientOrderId})`); }
          protection.orderId=verified.orderId;this.checkpoint();
        }
      }
      for (let attempt = 0; attempt < protectionVerificationAttempts; attempt++) {
        if(!verified) {
          try { verified = await adapter.getProtection(credentials, protection); }
          catch(error) { if(error.code!=='PROTECTION_NOT_FOUND') throw error; }
        }
        const status = String(verified?.status || '').toUpperCase();
        if (['ACTIVE', 'LIVE', 'NEW'].includes(status)) break;
        if (['REJECTED', 'FAILED', 'CANCELED'].includes(status)) throw new Error(`${this.config[leg]}: серверный TP/SL не активирован (${status})`);
        verified=null;await this.sleep(250);
      }
      if (!verified || !['ACTIVE', 'LIVE', 'NEW'].includes(String(verified.status).toUpperCase())) throw new Error(`${this.config[leg]}: серверный TP/SL не подтверждён`);
      const tolerance = Math.max(Number(this.config[`${leg}Rules`]?.tickSize || 0) * 0.51, 1e-10);
      if (Math.abs(Number(verified.takeProfitPrice) - prices.takeProfitPrice) > tolerance || Math.abs(Number(verified.stopLossPrice) - prices.stopLossPrice) > tolerance) {
        throw new Error(`${this.config[leg]}: подтверждённые TP/SL отличаются от расчёта`);
      }
      if (Math.abs(Number(verified.quantity) - entry.quantity) > Math.max(1e-12,entry.quantity*1e-8)) throw new Error(`${this.config[leg]}: серверный TP/SL не покрывает весь объём позиции`);
      Object.assign(protection, verified, { status: 'ACTIVE', verifiedAt: this.now() });
      this.checkpoint(); created.push(protection);
    }
    this.run.serverProtected = created.length === 2;
    this.checkpoint();
    return created;
  }
  async cancelProtections() {
    for (const protection of this.run?.protections || []) {
      if (['CANCELED', 'TRIGGERED', 'FILLED', 'REJECTED', 'FAILED', 'INACTIVE'].includes(String(protection.status).toUpperCase())) continue;
      const { adapter, credentials } = this.venue(protection.leg);
      let current;
      try { current = await adapter.getProtection(credentials, protection); }
      catch(error) {
        if(['PROTECTION_NOT_FOUND','ORDER_NOT_FOUND','ALREADY_FINAL','NO_POSITION'].includes(error.code)) { Object.assign(protection,{status:'INACTIVE'});this.checkpoint();continue; }
        current = null;
      }
      if (current && ['TRIGGERED', 'FILLED', 'CANCELED', 'FAILED', 'REJECTED'].includes(String(current.status).toUpperCase())) {
        Object.assign(protection, current); this.checkpoint(); continue;
      }
      try { await adapter.cancelProtection(credentials, protection, { allowLiveTrading: true }); }
      catch(error) {
        // "Already gone" is only a reason to read again, never proof of cancellation.
        if (!['ORDER_NOT_FOUND', 'ALREADY_FINAL', 'NO_POSITION'].includes(error.code)) throw error;
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        try { current = await adapter.getProtection(credentials, protection); }
        catch(error) {
          if(['PROTECTION_NOT_FOUND','ORDER_NOT_FOUND','ALREADY_FINAL','NO_POSITION'].includes(error.code)) { current={...protection,status:'CANCELED'};break; }
          throw error;
        }
        const status = String(current?.status || '').toUpperCase();
        if (['CANCELED', 'TRIGGERED', 'FILLED', 'FAILED', 'REJECTED'].includes(status)) break;
        await this.sleep(200);
      }
      if (!current || !['CANCELED', 'TRIGGERED', 'FILLED', 'FAILED', 'REJECTED'].includes(String(current.status).toUpperCase())) throw new Error(`${this.config[protection.leg]}: отмена серверного TP/SL не подтверждена`);
      Object.assign(protection, current); this.checkpoint();
    }
  }
  async execute() {
    this.assertEntryAllowed();
    const c = this.config;
    if (this.run.dryRun) {
      const simulated = { symbol: c.symbol, status: "FILLED", executedQuantity: c.quantity, quantity: c.quantity, averagePrice: c.price, createdAt: this.now() };
      this.run.targetOrder = { ...simulated, clientOrderId: `sim-target-${this.run.id}`, type: "LIMIT", leg: "target", side: c.targetSide };
      this.run.sourceOrders = [{ ...simulated, clientOrderId: `sim-source-${this.run.id}`, type: "MARKET", leg: "source", side: c.sourceSide }];
      return this.transition("running", { hedgedQuantity: c.quantity });
    }
    this.transition("placing_target");
    const target = await this.submit("target", "LIMIT", c.quantity, c.targetSide);
    this.transition("waiting_target");
    const deadline = this.now() + (c.timeoutMs || 60_000);
    while (!this.stopRequested) {
      await this.readOrder(target);
      if (this.stopRequested) return this.snapshot();
      const delta = target.executedQuantity - this.run.hedgedQuantity;
      const hedgeQuantity = c.sourceQuantityStep ? floorToStep(delta, c.sourceQuantityStep) : delta;
      if (hedgeQuantity > c.quantity * 1e-10) {
        this.transition("hedging_source");
        const source = await this.submit("source", "MARKET", hedgeQuantity, c.sourceSide);
        await this.confirmMarket(source);
        this.transition("waiting_target");
      }
      if (CLOSED.has(target.status)) {
        if (target.status !== "FILLED" || Math.abs(target.executedQuantity - this.run.hedgedQuantity) > c.quantity * 1e-8) throw new Error("Целевая заявка завершилась без полного равного хеджа");
        return this.transition("running");
      }
      if (this.now() >= deadline) throw new Error("Истёк таймаут целевой лимитки");
      await this.sleep(c.pollMs || 500);
    }
    return this.snapshot();
  }
  async cancelAndRead(order) {
    this.assertNotManuallyStopped();
    // A confirmed terminal fill cannot grow. Re-reading every historical
    // replacement on Stop would flood the API and delay closing real exposure.
    if (CLOSED.has(order.status)) return order;
    const { adapter, credentials } = this.venue(order.leg);
    // Recover a missing ID before any action. Accepted market orders need status
    // reconciliation, not a cancel. For a known limit ID, a broken read endpoint
    // must not prevent the best-effort cancellation that stops further fills.
    if (!order.orderId || order.type === 'MARKET') {
      await this.readOrder(order);
      if (CLOSED.has(order.status)) return order;
    }
    if (order.type !== 'MARKET') {
      this.assertNotManuallyStopped();
      try { await adapter.cancelOrder(credentials, order, { allowLiveTrading: true }); } catch { /* Could have filled concurrently. */ }
    }
    // Some venues acknowledge cancel before their order state becomes terminal.
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.readOrder(order);
      if (CLOSED.has(order.status)) return order;
      if (attempt < 5) await this.sleep(200);
    }
    throw new Error(order.symbol + ": отмена остатка не подтверждена");
  }
  async settle(mode) {
    this.assertNotManuallyStopped();
    if (this.run.dryRun) return this.transition("stopped", { stopMode: mode, closeStatus: 'closed', closeError: undefined });
    this.transition("stopping", { stopMode: mode, stopProgress: {phase:'reconciling'} });
    await this.cancelProtections();
    for (const order of this.orders()) {
      if(!CLOSED.has(order.status)) this.transition('stopping',{stopProgress:{phase:'canceling',leg:order.leg,symbol:order.symbol,orderId:order.orderId}});
      await this.cancelAndRead(order);
    }
    if (mode === "market") {
      for (const leg of ["target", "source"]) {
        const opened = this.opened(leg);
        const closed = this.run.closeOrders.filter((o) => o.leg === leg).reduce((s, o) => s + quantityOf(o), 0);
        let remaining = opened - closed;
        // A TP/SL, liquidation, ADL or manual action may have changed the position
        // while the app was off. The exchange snapshot, not an error message, is
        // the authority for the remaining reduce-only quantity.
        const { adapter, credentials } = this.venue(leg);
        if (remaining > this.run.quantity * 1e-8) remaining = (await this.reconcilePosition(leg, remaining)).quantity;
        if (remaining > this.run.quantity * 1e-8) {
          this.transition('stopping',{stopProgress:{phase:'closing',leg,symbol:this.run.symbol}});
          const side = opposite(this.config[leg + "Side"]);
          this.assertNotManuallyStopped();
          const plan = adapter.getClosePlan ? await adapter.getClosePlan(credentials, { symbol: this.run.symbol, side, quantity: remaining }) : [{ quantity: remaining }];
          this.assertNotManuallyStopped();
          const total = Array.isArray(plan) ? plan.reduce((sum, part) => sum + Number(part.quantity), 0) : NaN;
          if (!Number.isFinite(total) || Math.abs(total - remaining) > remaining * 1e-8 || !plan.length || plan.some(part => !(Number(part.quantity) > 0))) throw new Error('План закрытия не совпадает с собственным объёмом сессии');
          for (const part of plan) {
            let close;
            try { close=await this.submit(leg, "MARKET", Number(part.quantity), side, true, { positionId: part.positionId }); }
            catch(error) {
              if (error.code !== 'NO_POSITION') throw error;
              const actual = await this.reconcilePosition(leg, remaining, 'exchange_reports_no_position', error);
              if (actual.quantity <= this.run.quantity * 1e-8) { remaining = 0; break; }
              throw Object.assign(new Error(`${error.message}. Повторный снимок всё ещё показывает ${actual.quantity} ${this.run.symbol}; слепой повтор закрытия запрещён.`), {
                code: 'POSITION_RECONCILIATION_MISMATCH', exchangeCode: error.exchangeCode, definitive: true,
              });
            }
            this.transition('stopping',{stopProgress:{phase:'confirming',leg,symbol:this.run.symbol,orderId:close.orderId}});
            await this.confirmMarket(close);
            remaining -= Number(part.quantity);
          }
        }
        const finalPosition = await this.reconcilePosition(leg, Math.max(0, remaining), 'post_close_verification');
        if (finalPosition.quantity > this.run.quantity * 1e-8) throw new Error(`${this.run.symbol}: ${this.config[leg]} не подтвердил нулевую позицию после закрытия`);
      }
    }
    return this.transition("stopped", { stopMode: mode, closeStatus: 'closed', closeError: undefined, error: undefined, errorCode: undefined, stopProgress: {phase:'done'}, closedQuantity: mode === "market" ? this.run.hedgedQuantity : 0 });
  }
  async stop(mode = "app-only") {
    if (!['app-only', 'market', 'pause'].includes(mode)) throw new Error('Неизвестный способ остановки');
    // No exchange dependency and no wait for start/market-stop promises. An
    // already dispatched request can finish, but cannot authorize another one.
    if (mode === 'app-only') {
      this.manualStop = true; this.stopRequested = true; this.botStopped = true;
      return this.transition('stopped', { manualStop: true, manualManagement: true, stopMode: mode, stopProgress: { phase: 'done' }, error: undefined, errorCode: undefined });
    }
    if (mode === 'pause') return this.pause();
    if (this.manuallyStopped()) return this.snapshot();
    if (!this.run || this.run.closeStatus === 'closed') return this.snapshot();
    if (this.stopPromise) return this.stopPromise;
    this.pause('closing');
    this.transition('stopping',{stopMode:mode,stopProgress:{phase:'reconciling'}});
    this.stopPromise = (async () => {
      await this.startPromise?.catch(() => {});
      if (this.manuallyStopped()) return this.snapshot();
      try { return await this.settle(mode); }
      catch (error) { if (this.manuallyStopped()) return this.snapshot(); const retrying = require('./close-retry.cjs').closeRetryDelay(error) !== null; this.transition("stopped", { closeStatus: retrying ? 'waiting_confirmation' : 'failed', closeError: retrying ? undefined : error.message }); throw error; }
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}
module.exports = { HedgeEngine };
