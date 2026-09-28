const { floorToStep, stepPrecision } = require('../exchanges/order-sizing.cjs');

const positiveRate = (value, fallback) => {
  const rate = Math.abs(Number(value));
  return Number.isFinite(rate) ? rate : fallback;
};

function normalizedFeeRates(value = {}) {
  return {
    source: {
      entry: positiveRate(value.source?.entry, 0.0002),
      exit: positiveRate(value.source?.exit, 0.0006),
    },
    target: {
      entry: positiveRate(value.target?.entry, 0.0006),
      exit: positiveRate(value.target?.exit, 0.0006),
    },
  };
}

// A 100% PnL target is the liquidation boundary in the idealized formula and
// is closer still after maintenance margin and fees. Reserve 30% of the
// conservative distance-to-liquidation estimate and pay both source fees from
// that budget. This is a safety boundary, not a promise about exchange fills.
function protectionBudget({ requestedPercent, leverage, feeRates }) {
  const requested = Number(requestedPercent), lever = Number(leverage);
  if (!(requested > 0 && requested <= 100) || !Number.isFinite(lever) || lever < 1) {
    throw new Error('Некорректная цель переноса или плечо');
  }
  const fees = normalizedFeeRates(feeRates);
  const conservativeLossBeforeLiquidation = Math.max(0, 100 - 0.5 * lever);
  const safeSourceLossPercent = conservativeLossBeforeLiquidation * 0.7;
  const sourceFeePercent = (fees.source.entry + fees.source.exit) * lever * 100;
  const targetFeePercent = (fees.target.entry + fees.target.exit) * lever * 100;
  const maxGrossMovePercent = safeSourceLossPercent - sourceFeePercent;
  const effectiveNetPercent = Math.min(requested, maxGrossMovePercent - targetFeePercent);
  if (!(effectiveNetPercent >= 5)) {
    throw new Error(`Плечо ${lever}x не оставляет безопасного резерва для серверных TP/SL после комиссий`);
  }
  const grossMovePercent = effectiveNetPercent + targetFeePercent;
  return { requestedPercent: requested, effectiveNetPercent, grossMovePercent,
    moveRatio: grossMovePercent / (lever * 100), safeSourceLossPercent,
    sourceFeePercent, targetFeePercent, feeRates: fees };
}

function ceilToStep(value, step) {
  return Number((-floorToStep(-value, step)).toFixed(stepPrecision(step)));
}

function bracketForSide({ side, referencePrice, moveRatio, tickSize, clientOrderId }) {
  const price = Number(referencePrice), ratio = Number(moveRatio), tick = Number(tickSize);
  if (!['BUY', 'SELL'].includes(side) || !(price > 0) || !(ratio > 0 && ratio < 1) || !(tick > 0)) {
    throw new Error('Нельзя рассчитать серверный TP/SL: некорректная цена, сторона или шаг');
  }
  const upper = price * (1 + ratio), lower = price * (1 - ratio);
  const takeProfitPrice = side === 'BUY' ? ceilToStep(upper, tick) : floorToStep(lower, tick);
  // Stops are rounded toward the current price so the safety reserve can only
  // grow, never shrink because of tick rounding.
  const stopLossPrice = side === 'BUY' ? ceilToStep(lower, tick) : floorToStep(upper, tick);
  if (!(takeProfitPrice > 0 && stopLossPrice > 0) || takeProfitPrice === stopLossPrice) {
    throw new Error('Серверные TP/SL совпали после округления');
  }
  return { takeProfitPrice, stopLossPrice, triggerPriceType: 'mark', clientOrderId };
}

function feeEstimate(run, orders) {
  const fees = normalizedFeeRates(run.feeRates);
  const result = { source: 0, target: 0 };
  for (const order of orders) {
    const quantity = Number(order.executedQuantity), price = Number(order.averagePrice);
    if (!(quantity > 0 && price > 0) || !['source', 'target'].includes(order.leg)) continue;
    const rate = order.reduceOnly ? fees[order.leg].exit
      : order.type === 'LIMIT' && order.postOnly ? fees[order.leg].entry : Math.max(fees[order.leg].entry, 0.0006);
    result[order.leg] += quantity * price * rate;
  }
  return { ...result, total: result.source + result.target };
}

module.exports = { normalizedFeeRates, protectionBudget, bracketForSide, feeEstimate };
