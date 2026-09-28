const { HedgeEngine } = require('./hedge-engine.cjs');
const { executionPolicy } = require('./execution-policy.cjs');
const { marketImpact } = require('./hedge-plan.cjs');
const { floorToStep, stepPrecision } = require('../exchanges/order-sizing.cjs');
const CLOSED = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

function passivePrice(book, side, tick, now = Date.now()) {
  const bid = Number(book?.bids?.[0]?.price), ask = Number(book?.asks?.[0]?.price);
  if (!(bid > 0 && ask > bid && tick > 0)) throw new Error('Нет корректного bid/ask или шага цены');
  if (book.receivedAt != null && (now - book.receivedAt > 3000 || book.receivedAt > now + 1000)) throw new Error('Стакан устарел: ждём свежие котировки');
  const price = side === 'BUY' ? floorToStep(bid, tick) : Number((-floorToStep(-ask, tick)).toFixed(stepPrecision(tick)));
  if (!(price > 0) || (side === 'BUY' ? price >= ask : price <= bid)) throw new Error('Не удалось рассчитать maker-цену');
  return price;
}

// Version 2: source leads, target follows. Replacement is always cancel -> final
// read -> hedge late fills -> new remainder. No two source orders overlap.
class AdaptiveHedgeEngine extends HedgeEngine {
  resumeEntry() {
    this.assertEntryAllowed();
    if (this.resumePromise) return this.resumePromise;
    // Stop must also fence and wait for this continuation, exactly as it does
    // for the original entry. Never reset a stopped engine to resume trading.
    const pending = this.resumeConfirmedEntry().catch(error => {
      if (this.botStopped || this.manuallyStopped()) return this.snapshot();
      this.transition('emergency', { error: error.message, errorCode: error.code });
      throw error;
    }).finally(() => { this.resumePromise = null; });
    this.resumePromise = pending; this.startPromise = pending;
    return pending;
  }
  async resumeConfirmedEntry() {
    this.assertEntryAllowed();
    if (this.run.closeOrders.length) throw new Error('Закрытие этого входа уже начато; повторный вход запрещён');
    this.transition('reconciling_entry', { error: undefined, errorCode: undefined });
    // First freeze every existing limit and recover cumulative fills by its
    // original ID. A pending/unknown intent cannot authorize another target.
    for (const order of this.orders()) {
      this.assertEntryAllowed();
      if (!CLOSED.has(order.status)) await this.cancelAndRead(order);
      this.assertEntryAllowed();
    }
    const source = this.opened('source'), target = this.opened('target');
    const epsilon = this.run.quantity * 1e-8;
    if (target > source + epsilon) throw new Error('Исполненный объём целевой ноги превышает исходную; требуется сверка');
    if (source <= epsilon) return this.transition('stopped', { closeStatus: 'closed', error: undefined, errorCode: undefined });
    if (!this.rules) {
      const sourceRules = this.config.sourceRules || await this.sourceAdapter.getTradingRules(this.config.symbol, this.config.sourceCredentials);
      this.assertEntryAllowed();
      const targetRules = this.config.targetRules || await this.targetAdapter.getTradingRules(this.config.symbol, this.config.targetCredentials);
      this.assertEntryAllowed();
      this.rules = { source: sourceRules, target: targetRules };
    }
    if (source > target + epsilon) await this.hedgeTarget(this.now() + this.run.execution.makerWaitMs);
    this.assertEntryAllowed();
    if (Math.abs(this.opened('source') - this.opened('target')) > epsilon) throw new Error('После сверки ноги хеджа не совпадают по объёму');
    // A canceled partial source is a smaller real pair. Do not expand the
    // recovered exposure or close it just because indexing was delayed.
    return this.transition('running', { quantity: source, hedgedQuantity: source, error: undefined, errorCode: undefined });
  }
  async execute() {
    this.assertEntryAllowed();
    if (this.run.dryRun) return super.execute();
    const c = this.config;
    const execution = executionPolicy(this.sourceAdapter, this.targetAdapter, c);
    this.run.targetOrders = []; this.run.execution = execution;
    this.checkpoint();
    this.assertEntryAllowed();
    const sourceRules = c.sourceRules || await this.sourceAdapter.getTradingRules(c.symbol, c.sourceCredentials);
    this.assertEntryAllowed();
    const targetRules = c.targetRules || await this.targetAdapter.getTradingRules(c.symbol, c.targetCredentials);
    this.assertEntryAllowed();
    this.rules = { source: sourceRules, target: targetRules };
    const deadline = this.now() + (c.timeoutMs || 60_000);
    let first = null, nextQuoteAt = 0;
    while (!this.stopRequested) {
      if (first) {
        await this.readOrder(first);
        if (this.stopRequested) return this.snapshot();
        if (this.opened('source') > this.opened('target') + c.quantity * 1e-10) {
          const hedgeDeadline = this.now() + execution.makerWaitMs;
          // Freeze the first-leg remainder before exposing a second maker order.
          if (!CLOSED.has(first.status)) await this.cancelAndRead(first);
          if (this.stopRequested) return this.snapshot();
          await this.hedgeTarget(hedgeDeadline);
        }
        if (CLOSED.has(first.status)) first = null;
      }
      if (this.stopRequested) return this.snapshot();
      if (this.opened('source') >= this.run.quantity * (1 - 1e-8)) {
        if (Math.abs(this.opened('source') - this.opened('target')) > c.quantity * 1e-8) throw new Error('Ноги хеджа не совпадают по объёму');
        return this.transition('running');
      }
      if (this.now() >= deadline) throw new Error('Пересчитываем неисполненный вход по свежему рынку');
      if (this.now() >= nextQuoteAt) {
        nextQuoteAt = this.now() + execution.repriceMs;
        const quote = await this.quote('source');
        if (this.stopRequested) return this.snapshot();
        if (first && Math.abs(first.price - quote.price) >= this.rules.source.tickSize * 0.5) {
          this.transition('repricing_source');
          await this.cancelAndRead(first);
          if (this.stopRequested) return this.snapshot();
          // Cancellation can race a fill. Never lose the fills from the old ID.
          if (this.opened('source') > this.opened('target') + c.quantity * 1e-10) await this.hedgeTarget(this.now() + execution.makerWaitMs);
          first = null;
        }
        if (!first && !this.stopRequested) {
          // Fetch again after cancellation/hedging, not the pre-cancel quote.
          const fresh = await this.quote('source');
          let remaining = this.run.quantity - this.opened('source');
          if (remaining <= c.quantity * 1e-8) continue;
          remaining = await this.budgetedRemainder(remaining, fresh);
          this.validateQuantity('source', remaining, fresh.price);
          this.transition('placing_source');
          try {
            first = await this.submit('source', 'LIMIT', remaining, c.sourceSide, false, { price: fresh.price, postOnly: execution.sourcePostOnly, deadline: fresh.expiresAt });
          } catch (error) {
            // The exchange explicitly rejected this maker intent with zero fill.
            // A moved book is normal: take a fresh quote on the next iteration.
            if (error.definitive !== true || error.code !== 'POST_ONLY_WOULD_TAKE') throw error;
            this.transition('repricing_source', { error: undefined });
          }
          nextQuoteAt = this.now() + execution.repriceMs;
        }
      }
      this.transition('waiting_source');
      await this.sleep(c.pollMs || 500);
    }
    return this.snapshot();
  }
  async quote(leg) {
    this.assertEntryAllowed();
    const { adapter, credentials } = this.venue(leg);
    const book = await adapter.getDepth(this.config.symbol, 5, credentials);
    this.assertEntryAllowed();
    return { book, price: passivePrice(book, this.config[leg + 'Side'], this.rules[leg].tickSize, this.now()), expiresAt: (book.receivedAt ?? this.now()) + 3000 };
  }
  validateQuantity(leg, quantity, price) {
    const r = this.rules[leg];
    if (!Number.isFinite(quantity) || !(quantity > 0) || !Number.isFinite(r.quantityStep) || !(r.quantityStep > 0) || Math.abs(floorToStep(quantity, r.quantityStep) - quantity) > quantity * 1e-8 || quantity < (r.minQuantity || 0) * (1 - 1e-8) || (price && quantity * price < (r.minNotional || 0) * (1 - 1e-8))) {
      throw new Error(`${this.config.symbol}: частичный объём не проходит минимум/шаг ${this.config[leg]}; выравнивание требует закрытия входа`);
    }
  }
  async budgetedRemainder(remaining, sourceQuote) {
    const c = this.config, budget = Number(c.notional || c.margin * c.leverage);
    if (!(budget > 0)) return remaining;
    const targetQuote = await this.quote('target');
    let allowed = remaining;
    for (const leg of ['source', 'target']) {
      const opened = this.orders().filter(o => o.leg === leg && !o.reduceOnly && o.executedQuantity > 0);
      if (opened.some(o => !(o.averagePrice > 0))) throw new Error('Нет подтверждённой цены: нельзя пересчитать остаток маржи');
      const spent = opened.reduce((sum, o) => sum + o.executedQuantity * o.averagePrice, 0);
      // Reserve at the ask on each venue, including potential target market fallback.
      const quote = leg === 'source' ? sourceQuote : targetQuote;
      const price = Math.max(quote.price, Number(quote.book.asks[0].price));
      allowed = Math.min(allowed, Math.max(0, budget - spent) / price);
    }
    const quantity = floorToStep(allowed, c.quantityStep || this.rules.source.quantityStep);
    this.validateQuantity('source', quantity, sourceQuote.price);
    this.validateQuantity('target', quantity, targetQuote.price);
    const impact = marketImpact(targetQuote.book, c.targetSide, quantity);
    if (impact.insufficientDepth) throw new Error(`${c.symbol}: свежей глубины ЦЕЛЕВОЙ недостаточно; ИСХОДНАЯ заявка не отправлена`);
    if (impact.impactPercent > 0.01 && !c.acceptImpact) throw new Error(`${c.symbol}: свежая ликвидность ЦЕЛЕВОЙ превышает допустимые потери 0.01%; ИСХОДНАЯ заявка не отправлена`);
    // Never increase the user's allocation while chasing a moving quote.
    this.run.quantity = this.opened('source') + quantity;
    this.checkpoint();
    return quantity;
  }
  async hedgeTarget(deadline) {
    this.assertEntryAllowed();
    const c = this.config;
    let remaining = this.opened('source') - this.opened('target');
    this.validateQuantity('target', remaining);
    let maker = null;
    if (this.run.execution.targetPostOnly && this.now() < deadline) {
      // Quote failure is safe to skip: no target intent has been dispatched yet.
      let quote;
      try { quote = await this.quote('target'); } catch { /* Market fallback below. */ }
      if (quote && this.now() < deadline) {
        this.validateQuantity('target', remaining, quote.price);
        this.transition('placing_target_maker', { makerDeadline: deadline });
        try { maker = await this.submit('target', 'LIMIT', remaining, c.targetSide, false, { price: quote.price, postOnly: true, deadline }); }
        catch (error) { if (error.definitive !== true) throw error; }
        if (maker) {
          this.transition('waiting_target_maker');
          while (!this.stopRequested && this.now() < deadline) {
            await this.readOrder(maker);
            if (CLOSED.has(maker.status)) break;
            const wait = Math.min(250, deadline - this.now());
            if (wait > 0) await this.sleep(wait);
          }
          if (this.stopRequested) return this.snapshot();
          // Even at the deadline, a cancel acknowledgement is NOT final state.
          if (!CLOSED.has(maker.status)) await this.cancelAndRead(maker);
        }
      }
    }
    if (this.stopRequested) return;
    remaining = this.opened('source') - this.opened('target');
    if (remaining > c.quantity * 1e-10) {
      await this.completeTargetMarket();
    }
    this.transition('waiting_source', { makerDeadline: undefined });
  }
  async completeTargetMarket() {
    const c = this.config;
    const attempts = Math.max(1, Number(this.run.execution.targetMarketAttempts) || 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.assertEntryAllowed();
      const remaining = this.opened('source') - this.opened('target');
      if (remaining <= c.quantity * 1e-10) return;
      this.validateQuantity('target', remaining);
      if (this.run.execution.immediateTarget) {
        const quote = await this.quote('target');
        const impact = marketImpact(quote.book, c.targetSide, remaining);
        if (impact.insufficientDepth) throw new Error(`${c.symbol}: свежей глубины ЦЕЛЕВОЙ недостаточно для немедленного хеджа`);
      }
      this.transition('hedging_target_market', { makerDeadline: undefined, targetMarketAttempt: attempt });
      const order = await this.submit('target', 'MARKET', remaining, c.targetSide);
      await this.confirmTerminal(order);
      const unhedged = this.opened('source') - this.opened('target');
      if (unhedged <= c.quantity * 1e-10) return;
      // Only a confirmed terminal partial/zero fill permits another intention.
      // UNKNOWN or live orders never reach this branch.
      if (attempt === attempts) throw new Error(`${c.symbol}: ЦЕЛЕВАЯ исполнена частично; безопасный лимит добора исчерпан (${this.opened('target')}/${this.opened('source')})`);
    }
  }
}
module.exports = { AdaptiveHedgeEngine, passivePrice };
