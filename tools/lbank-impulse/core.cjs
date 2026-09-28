'use strict';

const DEFAULTS = Object.freeze({
  impulseWindowMs: 1000,
  impulseBps: 4,
  warmupMs: 0,
  basisHalfLifeMs: 30_000,
  extraEdgeBps: 2,
  entryLifetimeMs: 5000,
  minimumHoldMs: 2000,
  trailingActivationBps: 3,
  minimumTrailNetBps: 0,
  reversalBps: 2,
  reversalHoldMs: 0,
  adverseBps: 3,
  maxHoldMs: 60_000,
  maxEntrySlippageBps: 0,
  marketEntryImpulseMultiplier: 2,
  depthSafetyMultiplier: 2,
  maxLossPercent: 1,
  riskBufferBps: 10,
  leaderMaxAgeMs: 500,
  lbankMaxAgeMs: 1000,
  positionLeaderMaxAgeMs: 5000,
  positionLbankMaxAgeMs: 5000,
  cooldownMs: 180_000,
});

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function precisionOf(step) {
  const value = String(step).toLowerCase();
  const [mantissa, exponent = '0'] = value.split('e');
  return Math.max(0, (mantissa.split('.')[1]?.length || 0) - Number(exponent));
}

function floorToStep(value, step) {
  value = finite(value); step = finite(step);
  if (!(value >= 0) || !(step > 0)) return NaN;
  const units = Math.floor(value / step + Number.EPSILON * Math.max(1, Math.abs(value / step)) * 4);
  return Number((units * step).toFixed(precisionOf(step)));
}

function roundToTick(value, tick, direction = 'nearest') {
  value = finite(value); tick = finite(tick);
  if (!(value > 0) || !(tick > 0)) return NaN;
  const ratio = value / tick;
  const units = direction === 'down' ? Math.floor(ratio + 1e-10) : direction === 'up' ? Math.ceil(ratio - 1e-10) : Math.round(ratio);
  return Number((units * tick).toFixed(precisionOf(tick)));
}

function normalizeBook(book) {
  const normalize = (rows, descending) => (Array.isArray(rows) ? rows : []).map(row => ({
    price: finite(row?.price ?? row?.[0]), quantity: finite(row?.quantity ?? row?.volume ?? row?.[1]),
  })).filter(row => row.price > 0 && row.quantity > 0).sort((a, b) => descending ? b.price - a.price : a.price - b.price);
  const bids = normalize(book?.bids, true), asks = normalize(book?.asks, false);
  if (!bids.length || !asks.length || bids[0].price >= asks[0].price) throw new Error('Стакан пустой или пересечён');
  return { bids, asks, receivedAt: finite(book?.receivedAt) ?? Date.now(), venueAt: finite(book?.venueAt) };
}

function bookMetrics(book, notional = 0) {
  const value = normalizeBook(book), bid = value.bids[0].price, ask = value.asks[0].price, mid = (bid + ask) / 2;
  const target = Math.max(0, finite(notional) || 0);
  const depth = rows => {
    let quote = 0;
    for (const row of rows) { quote += row.price * row.quantity; if (quote >= target) break; }
    return quote;
  };
  return { ...value, bid, ask, mid, spreadBps: (ask - bid) / mid * 10_000, bidDepthUsd: depth(value.bids), askDepthUsd: depth(value.asks) };
}

function insideSpreadPrice(book, side, tick) {
  const value = bookMetrics(book), normalizedSide = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(normalizedSide) || !(finite(tick) > 0)) throw new Error('Некорректные параметры maker-цены');
  if (normalizedSide === 'BUY') {
    const improved = roundToTick(value.bid + tick, tick, 'down');
    const makerCap = roundToTick(value.ask - tick, tick, 'down');
    return Math.max(roundToTick(value.bid, tick, 'down'), Math.min(improved, makerCap));
  }
  const improved = roundToTick(value.ask - tick, tick, 'up');
  const makerFloor = roundToTick(value.bid + tick, tick, 'up');
  return Math.min(roundToTick(value.ask, tick, 'up'), Math.max(improved, makerFloor));
}

function quantityForNotional(notional, price, rules) {
  const quantity = floorToStep(finite(notional) / finite(price), finite(rules?.quantityStep));
  if (!(quantity > 0)) throw new Error('Номинал слишком мал для шага контракта');
  if (quantity + 1e-12 < finite(rules?.minQuantity)) throw new Error('Количество ниже минимума LBank');
  if (finite(rules?.maxQuantity) > 0 && quantity - 1e-12 > finite(rules.maxQuantity)) throw new Error('Количество выше максимума LBank');
  if (quantity * finite(price) + 1e-8 < finite(rules?.minNotional)) throw new Error('Номинал ниже минимальной стоимости LBank');
  return quantity;
}

function automaticPositionBudget({ available, price, rules, reserveFraction = .1, maxLossPercent = DEFAULTS.maxLossPercent,
  hardStopBps = DEFAULTS.adverseBps * 3, entryFeeRate = 0, exitFeeRate = 0, riskBufferBps = DEFAULTS.riskBufferBps } = {}) {
  const balance = finite(available), marketPrice = finite(price), maximumLeverage = Math.floor(finite(rules?.maxLeverage) || 0);
  if (!(balance > 0 && marketPrice > 0 && maximumLeverage >= 1)) throw new Error('Недостаточно данных для автоматического размера позиции');
  const reserve = Math.max(.05, Math.min(.5, finite(reserveFraction) ?? .1));
  const lossPercent = finite(maxLossPercent), stopBps = finite(hardStopBps), entryFee = finite(entryFeeRate), exitFee = finite(exitFeeRate);
  const bufferBps = finite(riskBufferBps);
  if (!(lossPercent > 0 && lossPercent <= 100) || !(stopBps > 0) || !(entryFee >= 0) || !(exitFee >= 0) || !(bufferBps >= 0)) {
    throw new Error('Некорректные параметры лимита убытка');
  }
  const marginCapacity = balance * (1 - reserve), marginCapacityNominal = marginCapacity * maximumLeverage;
  const riskBudget = balance * lossPercent / 100;
  const feeBps = (entryFee + exitFee) * 10_000;
  const plannedLossBps = stopBps + feeBps + bufferBps;
  const riskNominal = riskBudget / (plannedLossBps / 10_000);
  let nominal = Math.min(marginCapacityNominal, riskNominal);
  let limitingFactor = riskNominal <= marginCapacityNominal ? 'risk' : 'margin';
  const maxQuantity = finite(rules?.maxQuantity);
  if (maxQuantity > 0 && maxQuantity * marketPrice < nominal) { nominal = maxQuantity * marketPrice; limitingFactor = 'contract'; }
  const quantity = quantityForNotional(nominal, marketPrice, rules);
  const allocatedNominal = quantity * marketPrice, margin = allocatedNominal / maximumLeverage;
  return { leverage: maximumLeverage, margin, marginCapacity, marginCapacityNominal, nominal: allocatedNominal, quantity, reserve, available: balance,
    maxLossPercent: lossPercent, riskBudget, riskNominal, hardStopBps: stopBps, feeBps, riskBufferBps: bufferBps,
    plannedLossBps, plannedLoss: allocatedNominal * plannedLossBps / 10_000, limitingFactor };
}

function marketExitEstimate(book, positionSide, quantity) {
  const value = normalizeBook(book), side = String(positionSide || '').toUpperCase(), wanted = finite(quantity);
  if (!['BUY', 'SELL'].includes(side) || !(wanted > 0)) throw new Error('Некорректный объём оценки выхода');
  const rows = side === 'BUY' ? value.bids : value.asks;
  let remaining = wanted, quote = 0;
  for (const row of rows) {
    const take = Math.min(remaining, row.quantity); quote += take * row.price; remaining -= take;
    if (remaining <= wanted * 1e-10) break;
  }
  if (remaining > wanted * 1e-10) return { enough: false, quantity: wanted, availableQuantity: wanted - remaining, avgPrice: null, impactBps: Infinity };
  const avgPrice = quote / wanted, best = rows[0].price;
  const impactBps = side === 'BUY' ? (best - avgPrice) / best * 10_000 : (avgPrice - best) / best * 10_000;
  return { enough: true, quantity: wanted, availableQuantity: wanted, avgPrice, impactBps: Math.max(0, impactBps) };
}

function marketEntryEstimate(book, entrySide, quantity, maxImpactBps = Infinity) {
  const value = normalizeBook(book), side = String(entrySide || '').toUpperCase(), wanted = finite(quantity), impactLimit = finite(maxImpactBps);
  if (!['BUY', 'SELL'].includes(side) || !(wanted > 0) || !(impactLimit === null || impactLimit >= 0)) throw new Error('Некорректный объём оценки входа');
  const rows = side === 'BUY' ? value.asks : value.bids, best = rows[0].price;
  const limitPrice = impactLimit === null || impactLimit === Infinity
    ? (side === 'BUY' ? Infinity : 0)
    : best * (side === 'BUY' ? 1 + impactLimit / 10_000 : 1 - impactLimit / 10_000);
  let remaining = wanted, quote = 0, availableQuantity = 0, availableWithinLimit = 0;
  for (const row of rows) {
    availableQuantity += row.quantity;
    const withinLimit = side === 'BUY' ? row.price <= limitPrice + best * 1e-12 : row.price >= limitPrice - best * 1e-12;
    if (withinLimit) availableWithinLimit += row.quantity;
    const take = Math.min(remaining, row.quantity); quote += take * row.price; remaining -= take;
    if (remaining <= wanted * 1e-10) break;
  }
  if (remaining > wanted * 1e-10) return { enough: false, quantity: wanted, availableQuantity, availableWithinLimit, avgPrice: null, bestPrice: best, impactBps: Infinity };
  const avgPrice = quote / wanted;
  const impactBps = side === 'BUY' ? (avgPrice - best) / best * 10_000 : (best - avgPrice) / best * 10_000;
  return { enough: true, quantity: wanted, availableQuantity, availableWithinLimit, avgPrice, bestPrice: best, impactBps: Math.max(0, impactBps) };
}

function aggressiveLimitFillEstimate(book, entrySide, quantity, limitPrice) {
  const value = normalizeBook(book), side = String(entrySide || '').toUpperCase(), wanted = finite(quantity), limit = finite(limitPrice);
  if (!['BUY', 'SELL'].includes(side) || !(wanted > 0) || !(limit > 0)) throw new Error('Некорректные параметры агрессивной LIMIT-заявки');
  const rows = side === 'BUY' ? value.asks : value.bids, best = rows[0].price;
  let remaining = wanted, quote = 0, availableWithinLimit = 0;
  for (const row of rows) {
    const allowed = side === 'BUY' ? row.price <= limit + best * 1e-12 : row.price >= limit - best * 1e-12;
    if (!allowed) break;
    availableWithinLimit += row.quantity;
    const take = Math.min(remaining, row.quantity); quote += take * row.price; remaining -= take;
    if (remaining <= wanted * 1e-10) break;
  }
  const filledQuantity = wanted - remaining, enough = remaining <= wanted * 1e-10, avgPrice = filledQuantity > wanted * 1e-10 ? quote / filledQuantity : null;
  const impactBps = avgPrice === null ? Infinity : side === 'BUY' ? (avgPrice - best) / best * 10_000 : (best - avgPrice) / best * 10_000;
  return { enough, quantity: wanted, filledQuantity, availableWithinLimit, avgPrice, bestPrice: best, limitPrice: limit, impactBps: Math.max(0, impactBps) };
}

function planEntryExecution({ book, side, notional, rules, expectedFair, impulseBps, thresholdBps,
  maxSlippageBps = DEFAULTS.maxEntrySlippageBps, marketImpulseMultiplier = DEFAULTS.marketEntryImpulseMultiplier,
  depthSafetyMultiplier = DEFAULTS.depthSafetyMultiplier, allowSizeToDepth = false }) {
  const value = bookMetrics(book), normalizedSide = String(side || '').toUpperCase();
  const fair = finite(expectedFair);
  const slippageCap = Math.max(0, finite(maxSlippageBps) || 0);
  const depthMultiplier = Math.max(1, finite(depthSafetyMultiplier) || 1);
  if (!['BUY', 'SELL'].includes(normalizedSide) || !(fair > 0)) throw new Error('Некорректные параметры выбора исполнения');

  const bestPrice = normalizedSide === 'BUY' ? value.ask : value.bid;
  const rawLimit = bestPrice * (normalizedSide === 'BUY' ? 1 + slippageCap / 10_000 : 1 - slippageCap / 10_000);
  const limitPrice = roundToTick(rawLimit, rules?.tickSize, normalizedSide === 'BUY' ? 'down' : 'up');
  const executableLimit = normalizedSide === 'BUY' ? Math.max(bestPrice, limitPrice) : Math.min(bestPrice, limitPrice);
  const sizingPrice = normalizedSide === 'BUY' ? executableLimit : bestPrice;
  const maxQuantity = finite(rules?.maxQuantity);
  const cappedNotional = maxQuantity > 0 ? Math.min(finite(notional), maxQuantity * sizingPrice) : finite(notional);
  let quantity = quantityForNotional(cappedNotional, sizingPrice, rules);
  let limit = aggressiveLimitFillEstimate(value, normalizedSide, quantity, executableLimit), sizedDown = false;
  if (allowSizeToDepth && limit.availableWithinLimit / quantity + 1e-10 < depthMultiplier) {
    const depthQuantity = floorToStep(limit.availableWithinLimit / depthMultiplier, finite(rules?.quantityStep));
    if (depthQuantity > 0 && depthQuantity < quantity) {
      quantity = quantityForNotional(depthQuantity * sizingPrice, sizingPrice, rules);
      limit = aggressiveLimitFillEstimate(value, normalizedSide, quantity, executableLimit); sizedDown = true;
    }
  }
  const depthCoverage = quantity > 0 ? limit.availableWithinLimit / quantity : 0;
  const grossBps = limit.enough && limit.avgPrice > 0
    ? (normalizedSide === 'BUY' ? fair - limit.avgPrice : limit.avgPrice - fair) / limit.avgPrice * 10_000
    : null;
  const withinSlippage = limit.enough && limit.impactBps <= slippageCap + 1e-8;
  const depthSafe = depthCoverage + 1e-10 >= depthMultiplier;
  const lagSurvives = grossBps !== null && grossBps > 0;
  const canExecute = limit.enough && withinSlippage && depthSafe && lagSurvives;
  let routeReason = 'aggressive_limit_ready';
  if (!limit.enough) routeReason = 'aggressive_limit_depth_incomplete';
  else if (!withinSlippage) routeReason = 'aggressive_limit_slippage_cap';
  else if (!depthSafe) routeReason = 'aggressive_limit_depth_reserve';
  else if (!lagSurvives) routeReason = 'aggressive_limit_would_consume_lag';
  return {
    type: 'LIMIT', postOnly: false, canExecute,
    quantity,
    price: executableLimit,
    expectedFillPrice: limit.avgPrice,
    estimatedImpactBps: limit.impactBps,
    maxSlippageBps: slippageCap,
    depthCoverage,
    availableWithinLimit: limit.availableWithinLimit,
    requestedNotional: finite(notional), allocatedNotional: quantity * (limit.avgPrice || sizingPrice), sizedDown,
    urgent: true, routeReason,
    marketCandidate: { quantity, ...limit, grossBps, withinSlippage, depthSafe, lagSurvives },
  };
}

function conservativePaperFill(book, order, tickSize) {
  const value = normalizeBook(book), side = String(order?.side || '').toUpperCase();
  const price = finite(order?.price), quantity = finite(order?.quantity), executed = Math.max(0, finite(order?.executedQty) || 0), tick = finite(tickSize);
  if (!['BUY', 'SELL'].includes(side) || !(price > 0 && quantity > 0 && tick > 0)) throw new Error('Некорректные параметры Paper-исполнения');
  const remaining = Math.max(0, quantity - executed), epsilon = tick * 1e-6;
  // A touch is deliberately ignored. Without a private execution receipt,
  // Paper consumes only opposing volume shown at least one tick through us.
  const threshold = side === 'BUY' ? price - tick + epsilon : price + tick - epsilon;
  const rows = side === 'BUY'
    ? value.asks.filter(row => row.price <= threshold)
    : value.bids.filter(row => row.price >= threshold);
  const available = rows.reduce((sum, row) => sum + row.quantity, 0);
  return { available, remaining, fill: Math.min(remaining, available), confirmed: available > 0 };
}

function feeAwareEdge({ side, expectedFair, entryPrice, makerFee, takerFee, exitImpactBps, extraEdgeBps = DEFAULTS.extraEdgeBps }) {
  side = String(side || '').toUpperCase(); expectedFair = finite(expectedFair); entryPrice = finite(entryPrice);
  makerFee = finite(makerFee); takerFee = finite(takerFee); exitImpactBps = finite(exitImpactBps);
  if (!['BUY', 'SELL'].includes(side) || !(expectedFair > 0 && entryPrice > 0) || makerFee === null || takerFee === null || !(exitImpactBps >= 0)) {
    return { eligible: false, grossBps: null, costBps: null, netEdgeBps: null, requiredBps: null };
  }
  const grossBps = (side === 'BUY' ? expectedFair - entryPrice : entryPrice - expectedFair) / entryPrice * 10_000;
  const costBps = (makerFee + takerFee) * 10_000 + exitImpactBps;
  const netEdgeBps = grossBps - costBps;
  return { eligible: netEdgeBps >= extraEdgeBps, grossBps, costBps, netEdgeBps, requiredBps: costBps + extraEdgeBps };
}

function rollingReturnBps(history, now, windowMs = DEFAULTS.impulseWindowMs) {
  const valid = (Array.isArray(history) ? history : []).filter(row => finite(row?.at) !== null && finite(row?.price) > 0 && row.at <= now).sort((a, b) => a.at - b.at);
  if (valid.length < 2) return null;
  const newest = valid[valid.length - 1], cutoff = now - windowMs;
  let base = null;
  for (const row of valid) { if (row.at <= cutoff) base = row; else break; }
  if (!base) base = valid.find(row => row.at >= cutoff);
  if (!base || newest.at - base.at < windowMs * 0.85 || newest.at - base.at > windowMs * 1.5) return null;
  return (newest.price - base.price) / base.price * 10_000;
}

class TimeEwmaBasis {
  constructor({ halfLifeMs = DEFAULTS.basisHalfLifeMs, warmupMs = DEFAULTS.warmupMs } = {}) {
    this.halfLifeMs = halfLifeMs; this.warmupMs = warmupMs; this.value = null; this.firstAt = null; this.lastAt = null;
  }
  reset() { this.value = null; this.firstAt = null; this.lastAt = null; }
  update(leaderPrice, lbankPrice, at) {
    leaderPrice = finite(leaderPrice); lbankPrice = finite(lbankPrice); at = finite(at);
    if (!(leaderPrice > 0 && lbankPrice > 0 && at !== null)) return this.value;
    const sample = Math.log(lbankPrice / leaderPrice);
    if (this.value === null) { this.value = sample; this.firstAt = at; this.lastAt = at; return this.value; }
    if (at <= this.lastAt) return this.value;
    const alpha = 1 - Math.exp(-Math.log(2) * (at - this.lastAt) / this.halfLifeMs);
    this.value += alpha * (sample - this.value); this.lastAt = at; return this.value;
  }
  ready(now) { return this.value !== null && finite(now) - this.firstAt >= this.warmupMs; }
  expected(leaderPrice) { return this.value === null ? null : finite(leaderPrice) * Math.exp(this.value); }
  basisBps() { return this.value === null ? null : this.value * 10_000; }
}

class ReversalTracker {
  constructor({ side, leaderEntry, openedAt, minimumHoldMs = DEFAULTS.minimumHoldMs, trailingActivationBps = DEFAULTS.trailingActivationBps,
    reversalBps = DEFAULTS.reversalBps, reversalHoldMs = DEFAULTS.reversalHoldMs, adverseBps = DEFAULTS.adverseBps, maxHoldMs = DEFAULTS.maxHoldMs }) {
    this.side = String(side).toUpperCase(); this.leaderEntry = finite(leaderEntry); this.openedAt = finite(openedAt);
    if (!['BUY', 'SELL'].includes(this.side) || !(this.leaderEntry > 0) || this.openedAt === null) throw new Error('Некорректный трекер позиции');
    this.best = this.leaderEntry; this.reversalSince = null; this.trailingArmedAt = null;
    this.minimumHoldMs = Math.max(0, finite(minimumHoldMs) || 0); this.trailingActivationBps = Math.max(0, finite(trailingActivationBps) || 0);
    this.reversalBps = Math.max(0, finite(reversalBps) || 0); this.reversalHoldMs = Math.max(0, finite(reversalHoldMs) || 0);
    this.adverseBps = Math.max(0, finite(adverseBps) || 0); this.maxHoldMs = Math.max(1, finite(maxHoldMs) || DEFAULTS.maxHoldMs);
  }
  metrics(price, now) {
    price = finite(price); now = finite(now); if (!(price > 0) || now === null) return null;
    const ageMs = Math.max(0, now - this.openedAt);
    const signedFromEntryBps = (this.side === 'BUY' ? price - this.leaderEntry : this.leaderEntry - price) / this.leaderEntry * 10_000;
    const bestFavorableBps = Math.max(0, (this.side === 'BUY' ? this.best - this.leaderEntry : this.leaderEntry - this.best) / this.leaderEntry * 10_000);
    const retraceBps = Math.max(0, (this.side === 'BUY' ? this.best - price : price - this.best) / this.best * 10_000);
    return { ageMs, signedFromEntryBps, bestFavorableBps, retraceBps, trailingArmed: this.trailingArmedAt !== null,
      minimumHoldRemainingMs: Math.max(0, this.minimumHoldMs - ageMs), reversalConfirmRemainingMs: this.reversalSince === null ? null : Math.max(0, this.reversalHoldMs - (now - this.reversalSince)) };
  }
  observe(price, now) {
    price = finite(price); now = finite(now); if (!(price > 0) || now === null) return null;
    const signedFromEntry = (this.side === 'BUY' ? price - this.leaderEntry : this.leaderEntry - price) / this.leaderEntry * 10_000;
    if (signedFromEntry <= -this.adverseBps) return 'hard_stop';
    if (now - this.openedAt >= this.maxHoldMs) return 'max_hold';
    this.best = this.side === 'BUY' ? Math.max(this.best, price) : Math.min(this.best, price);
    const bestFavorable = Math.max(0, (this.side === 'BUY' ? this.best - this.leaderEntry : this.leaderEntry - this.best) / this.leaderEntry * 10_000);
    if (this.trailingArmedAt === null && bestFavorable >= this.trailingActivationBps) this.trailingArmedAt = now;
    if (this.trailingArmedAt === null || now - this.openedAt < this.minimumHoldMs) { this.reversalSince = null; return null; }
    const retrace = (this.side === 'BUY' ? this.best - price : price - this.best) / this.best * 10_000;
    if (retrace >= this.reversalBps) {
      this.reversalSince ??= now;
      if (now - this.reversalSince >= this.reversalHoldMs) return 'reversal';
    } else this.reversalSince = null;
    return null;
  }
}

// Exit model used by the proven ZEC_USD1 strategy in MEXC_FLIPPER.  The
// important distinction from a conventional trailing stop is that a pullback
// cannot close the trade while the convergence lag is still fully active.
class PullbackExitTracker {
  constructor({ side, leaderEntry, lbankEntry, openedAt, signalThresholdBps = DEFAULTS.impulseBps,
    minimumHoldMs = 2000, trailBps = 2, emergencyBps = 3, hardEmergencyMultiplier = 3,
    maxHoldMs = 60_000 }) {
    this.side = String(side).toUpperCase(); this.leaderEntry = finite(leaderEntry); this.lbankEntry = finite(lbankEntry); this.openedAt = finite(openedAt);
    if (!['BUY', 'SELL'].includes(this.side) || !(this.leaderEntry > 0) || !(this.lbankEntry > 0) || this.openedAt === null) {
      throw new Error('Некорректный ZEC-трекер позиции');
    }
    this.best = this.leaderEntry; this.signalThresholdBps = Math.max(0, finite(signalThresholdBps) || 0);
    this.minimumHoldMs = Math.max(0, finite(minimumHoldMs) || 0); this.trailBps = Math.max(0, finite(trailBps) || 0);
    this.emergencyBps = Math.max(0, finite(emergencyBps) || 0); this.hardEmergencyMultiplier = Math.max(1, finite(hardEmergencyMultiplier) || 3);
    this.maxHoldMs = Math.max(1, finite(maxHoldMs) || 60_000); this.last = null;
  }
  metrics(input, now) {
    const leaderPrice = finite(input?.leaderPrice ?? input), lbankPrice = finite(input?.lbankPrice), lagBps = finite(input?.lagBps), at = finite(now);
    // Missing market input must never replay the previous exit decision.
    if (!(leaderPrice > 0) || !(lbankPrice > 0) || lagBps === null || at === null) return null;
    const signedLagBps = this.side === 'BUY' ? lagBps : -lagBps;
    const signedLbankBps = (this.side === 'BUY' ? lbankPrice - this.lbankEntry : this.lbankEntry - lbankPrice) / this.lbankEntry * 10_000;
    const pullbackBps = Math.max(0, (this.side === 'BUY' ? this.best - leaderPrice : leaderPrice - this.best) / this.best * 10_000);
    const bestFavorableBps = Math.max(0, (this.side === 'BUY' ? this.best - this.leaderEntry : this.leaderEntry - this.best) / this.leaderEntry * 10_000);
    const ageMs = Math.max(0, at - this.openedAt), hardEmergencyBps = this.emergencyBps * this.hardEmergencyMultiplier;
    this.last = { ageMs, signedLagBps, signedLbankBps, adverseBps: Math.max(0, -signedLbankBps), bestFavorableBps, pullbackBps,
      signalActive: signedLagBps > this.signalThresholdBps, edgeStillGood: signedLagBps > 0,
      signalThresholdBps: this.signalThresholdBps, trailBps: this.trailBps, emergencyBps: this.emergencyBps,
      hardEmergencyBps, minimumHoldRemainingMs: Math.max(0, this.minimumHoldMs - ageMs),
      trailingArmed: ageMs >= this.minimumHoldMs && signedLagBps <= this.signalThresholdBps && signedLagBps > 0 };
    return this.last;
  }
  observe(input, now) {
    const leaderPrice = finite(input?.leaderPrice ?? input);
    if (!(leaderPrice > 0)) return null;
    this.best = this.side === 'BUY' ? Math.max(this.best, leaderPrice) : Math.min(this.best, leaderPrice);
    const view = this.metrics(input, now); if (!view) return null;
    if (view.signedLagBps < -this.signalThresholdBps) return 'signal_reversed';
    if (view.adverseBps >= view.emergencyBps) {
      if (!(view.edgeStillGood && view.adverseBps < view.hardEmergencyBps)) return 'hard_stop';
    }
    // Keep the safety timeout, but never cut a still-active convergence move.
    if (!view.signalActive && view.ageMs >= this.maxHoldMs) return 'max_hold';
    if (view.signalActive || view.ageMs < this.minimumHoldMs) return null;
    if (!view.edgeStillGood) return 'signal_ended';
    if (view.pullbackBps >= this.trailBps) return 'trailing_pullback';
    return null;
  }
}

class ReentryGate {
  constructor(cooldownMs = DEFAULTS.cooldownMs) { this.cooldownMs = cooldownMs; this.lastClosedAt = -Infinity; this.needsReset = false; }
  closed(at) { this.lastClosedAt = finite(at) ?? Date.now(); this.needsReset = true; }
  observeSignal(active) { if (!active) this.needsReset = false; }
  canEnter(now) { return !this.needsReset && finite(now) - this.lastClosedAt >= this.cooldownMs; }
}

function signalSide(impulseBps, threshold = DEFAULTS.impulseBps) {
  impulseBps = finite(impulseBps); if (impulseBps === null || Math.abs(impulseBps) < threshold) return null;
  return impulseBps > 0 ? 'BUY' : 'SELL';
}

module.exports = {
  DEFAULTS, TimeEwmaBasis, ReversalTracker, PullbackExitTracker, ReentryGate, aggressiveLimitFillEstimate, automaticPositionBudget, bookMetrics, conservativePaperFill, feeAwareEdge, floorToStep,
  insideSpreadPrice, marketEntryEstimate, marketExitEstimate, normalizeBook, planEntryExecution, precisionOf, quantityForNotional, rollingReturnBps,
  roundToTick, signalSide,
};
