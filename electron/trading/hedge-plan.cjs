const { commonStep, floorToStep } = require("../exchanges/order-sizing.cjs");
const { calculateTrend } = require("../exchanges/intraday-trend.cjs");
const { executionPolicy } = require('./execution-policy.cjs');

function rateFrom(table, symbol, field, fallback) {
  const row = table?.[symbol] || table?.default || table || {};
  const value = Math.abs(Number(row?.[field]));
  return Number.isFinite(value) ? value : fallback;
}

function allocation(input) {
  const symbols = [...new Set(input.symbols || [])];
  if (!symbols.length || symbols.length > 20 || symbols.some((s) => !/^[A-Z0-9]{1,20}USDT$/.test(s))) throw new Error("Выберите от 1 до 20 общих USDT-рынков");
  const totalMargin = Number(input.totalMargin);
  if (!Number.isFinite(totalMargin) || totalMargin <= 0) throw new Error("Укажите положительную общую маржу");
  return symbols.map((symbol) => {
    const leverage = Number(input.leverageBySymbol?.[symbol] ?? input.leverage ?? 1);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error(`${symbol}: плечо должно быть от 1x до 125x`);
    return { symbol, margin: totalMargin / symbols.length, leverage, notional: totalMargin / symbols.length * leverage };
  });
}

function marketImpact(book, side, quantity) {
  const mid = (Number(book.bids?.[0]?.price) + Number(book.asks?.[0]?.price)) / 2;
  if (!(mid > 0)) throw new Error("Нет актуального стакана исходной биржи");
  const levels = side === "BUY" ? book.asks : book.bids;
  let remaining = quantity, cost = 0;
  for (const level of levels) {
    const fill = Math.min(remaining, Number(level.quantity));
    if (!(fill >= 0) || !(level.price > 0)) throw new Error("Биржа вернула некорректную глубину стакана");
    cost += fill * level.price; remaining -= fill;
    if (remaining <= quantity * 1e-10) break;
  }
  const loss = remaining > quantity * 1e-10 ? null : Math.max(0, side === "BUY" ? cost - mid * quantity : mid * quantity - cost);
  const depth = (values) => values.filter((p) => Math.abs(p.price / mid - 1) <= 0.001).reduce((sum, p) => sum + p.price * p.quantity, 0);
  return { buyDepth: depth(book.asks), sellDepth: depth(book.bids), estimatedLoss: loss, impactPercent: loss == null ? null : loss / (mid * quantity) * 100, insufficientDepth: loss == null };
}

async function buildPlan(input, sourceAdapter, targetAdapter) {
  const marginMode = require('./margin-mode.cjs').marginMode(input.marginMode);
  if (input.source === input.target) throw new Error("Исходная и целевая биржи должны различаться");
  if((input.source==='lbank'||input.target==='lbank')&&marginMode!=='isolated') throw new Error('Надёжный режим LBank требует isolated-маржу на обеих биржах');
  const allocations = allocation(input);
  const execution = executionPolicy(sourceAdapter, targetAdapter, input);
  for (const [name, adapter] of [[input.source, sourceAdapter], [input.target, targetAdapter]]) {
    for (const method of ["getTradingRules", "getPositions", "getOpenOrders", "getOrder", "cancelOrder", "configureLeverage"]) {
      if (!adapter?.[method]) throw new Error(`${name}: автоматический хедж недоступен — не реализован ${method}. Ордеров не отправлено.`);
    }
    if (!adapter?.supportsNativeProtection
      || !['placeProtection', 'getProtection', 'cancelProtection'].every(method => typeof adapter?.[method] === 'function')) {
      throw new Error(`${name}: нет подтверждаемого серверного TP/SL. Надёжный режим блокирует вход до появления защиты на обеих биржах.`);
    }
  }
  if (typeof targetAdapter.getDayOpen !== 'function') throw new Error(`${input.target}: не реализован внутридневной тренд. Ордеров не отправлено.`);
  const [sourceAccount, targetAccount, sourcePositions, targetPositions, sourceOrders, targetOrders, sourceFees, targetFees] = await Promise.all([
    sourceAdapter.getAccount(input.sourceCredentials), targetAdapter.getAccount(input.targetCredentials),
    sourceAdapter.getPositions(input.sourceCredentials), targetAdapter.getPositions(input.targetCredentials),
    sourceAdapter.getOpenOrders(input.sourceCredentials), targetAdapter.getOpenOrders(input.targetCredentials),
    typeof sourceAdapter.getFeeRates === 'function' ? sourceAdapter.getFeeRates(input.sourceCredentials) : null,
    typeof targetAdapter.getFeeRates === 'function' ? targetAdapter.getFeeRates(input.targetCredentials) : null,
  ]);
  const available = Math.min(Number(sourceAccount.available), Number(targetAccount.available));
  const requiredReserve=Math.max(5,Number(input.totalMargin)*.1);
  if (!Number.isFinite(available) || Number(input.totalMargin)+requiredReserve > available) throw new Error(`Для маржи ${Number(input.totalMargin).toFixed(2)} USDT нужен свободный резерв не меньше ${requiredReserve.toFixed(2)} USDT на каждой бирже`);
  const occupied = [...sourcePositions, ...targetPositions, ...sourceOrders, ...targetOrders].find((p) => allocations.some((a) => a.symbol === p.symbol));
  if (occupied) throw new Error(`${occupied.symbol}: уже есть позиция или ордер на ${occupied.exchange}. Автохедж не смешивает новые сделки с существующими.`);
  const legs = [];
  for (const item of allocations) {
    if ((input.source === 'lbank' || input.target === 'lbank') && item.leverage > 20) {
      throw new Error(`${item.symbol}: надёжный режим LBank ограничивает плечо до 20x — при большем плече серверный стоп оказывается слишком близко к ликвидации`);
    }
    const [sourceRules, targetRules, sourceBook, targetBook, dayOpen] = await Promise.all([
      sourceAdapter.getTradingRules(item.symbol, input.sourceCredentials), targetAdapter.getTradingRules(item.symbol, input.targetCredentials),
      sourceAdapter.getDepth(item.symbol, 100, input.sourceCredentials), targetAdapter.getDepth(item.symbol, 100, input.targetCredentials),
      targetAdapter.getDayOpen(item.symbol, input.targetCredentials),
    ]);
    if ([sourceRules, targetRules].some((r) => r.maxLeverage && item.leverage > r.maxLeverage)) throw new Error(`${item.symbol}: выбранное плечо превышает лимит биржи`);
    const trend = calculateTrend(dayOpen, (Number(targetBook.bids?.[0]?.price) + Number(targetBook.asks?.[0]?.price)) / 2);
    const targetSide = trend.targetSide;
    const price = Number(targetSide === "BUY" ? targetBook.bids?.[0]?.price : targetBook.asks?.[0]?.price);
    const sourcePrice = Number(targetSide === "BUY" ? sourceBook.asks?.[0]?.price : sourceBook.bids?.[0]?.price);
    if (!(price > 0) || !(sourcePrice > 0)) throw new Error(`${item.symbol}: нет актуальных котировок`);
    const entryGapPercent=Math.abs(sourcePrice/price-1)*100;
    if(entryGapPercent>.2) throw new Error(`${item.symbol}: цены бирж расходятся на ${entryGapPercent.toFixed(3)}%; ждём синхронный рынок перед новым риском`);
    const quantityStep = commonStep(sourceRules.quantityStep, targetRules.quantityStep);
    const quantity = floorToStep(item.notional / Math.max(Number(sourceBook.asks?.[0]?.price), Number(targetBook.asks?.[0]?.price)), quantityStep);
    if ([sourceRules, targetRules].some(r => r.maxQuantity > 0 && quantity > r.maxQuantity)) throw new Error(`${item.symbol}: объём превышает максимум одной из бирж`);
    if (!(quantity > 0) || [sourceRules, targetRules].some((r) => quantity < r.minQuantity || quantity * Math.min(price, sourcePrice) < r.minNotional)) throw new Error(`${item.symbol}: доля маржи слишком мала для минимального объёма обеих бирж`);
    const impact = marketImpact(targetBook, targetSide, quantity);
    if (impact.insufficientDepth) throw new Error(`${item.symbol}: доступной глубины стакана недостаточно для маркет-ноги`);
    if (execution.immediateTarget) {
      // A source LIMIT may partially execute in its own lot step. If that
      // smallest real fill cannot be submitted to the target, no retry logic
      // can guarantee an equal second leg; reject before creating exposure.
      const sourceFillQuantum = Number(sourceRules.quantityStep);
      const targetStep = Number(targetRules.quantityStep);
      const targetMarketPrice = Number(targetSide === 'BUY' ? targetBook.asks?.[0]?.price : targetBook.bids?.[0]?.price);
      const aligned = Math.abs(floorToStep(sourceFillQuantum, targetStep) - sourceFillQuantum) <= sourceFillQuantum * 1e-8;
      if (!aligned || sourceFillQuantum < Number(targetRules.minQuantity || 0) * (1 - 1e-8)
        || sourceFillQuantum * targetMarketPrice < Number(targetRules.minNotional || 0) * (1 - 1e-8)) {
        throw new Error(`${item.symbol}: минимальное частичное исполнение ИСХОДНОЙ (${sourceFillQuantum}) нельзя точно захеджировать на ЦЕЛЕВОЙ; ордеров не отправлено`);
      }
    }
    const feeRates = {
      source: { entry: rateFrom(sourceFees, item.symbol, execution.sourcePostOnly ? 'makerFee' : 'takerFee', execution.sourcePostOnly ? 0.0002 : 0.0006), exit: rateFrom(sourceFees, item.symbol, 'takerFee', 0.0006) },
      target: { entry: rateFrom(targetFees, item.symbol, 'takerFee', 0.0006), exit: rateFrom(targetFees, item.symbol, 'takerFee', 0.0006) },
    };
    legs.push({ ...item, marginMode, price, sourcePrice, execution, sourceRules, targetRules, feeRates, entryGapPercent, trend, quantity, quantityStep, sourceQuantityStep: sourceRules.quantityStep, targetSide, impact });
  }
  return { source: input.source, target: input.target, execution, totalMargin: Number(input.totalMargin), available, legs, createdAt: Date.now() };
}
module.exports = { allocation, marketImpact, buildPlan, rateFrom };
