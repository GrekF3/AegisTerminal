const { runOrders } = require('./run-orders.cjs');
const { normalizedFeeRates } = require('./server-protection.cjs');

// Freeze the entry-margin basis. The configured allocation is a spending cap,
// not margin actually used after contract rounding. Do not use changing account
// equity, current mark-price IMR, or another position's margin as the denominator.
function targetPnlBasis(run, percent) {
  const leverage = Number(run.leverage);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100 || !Number.isFinite(leverage) || leverage < 1) {
    throw new Error(`${run.symbol}: некорректный процент PnL или плечо`);
  }
  let quantity = 0, notional = 0;
  for (const order of runOrders(run).filter(o => o.leg === 'target' && !o.reduceOnly)) {
    const filled = Number(order.executedQuantity);
    if (!Number.isFinite(filled) || filled < 0 || (filled > 0 && !(Number.isFinite(order.averagePrice) && order.averagePrice > 0))) {
      throw new Error(`${run.symbol}: для расчёта TP/SL нужна подтверждённая цена исполнения целевой позиции`);
    }
    quantity += filled;
    if (filled > 0) notional += filled * order.averagePrice;
  }
  if (!(quantity > 0) || !Number.isFinite(notional) || !Number.isFinite(run.hedgedQuantity) ||
      Math.abs(quantity - run.hedgedQuantity) > quantity * 1e-8) {
    throw new Error(`${run.symbol}: объём целевой позиции для TP/SL не подтверждён`);
  }
  const margin = notional / leverage;
  const rates = normalizedFeeRates(run.feeRates).target;
  const estimatedFees = run.feeRates ? notional * (rates.entry + rates.exit) : 0;
  const netThreshold = margin * percent / 100;
  return { percent, requestedPercent: run.requestedHedgePercent ?? percent, margin,
    threshold: netThreshold + estimatedFees, netThreshold, estimatedFees,
    quantity, entryPrice: notional / quantity, leverage };
}

module.exports = { targetPnlBasis };
