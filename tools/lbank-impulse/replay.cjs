#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  DEFAULTS, ReentryGate, PullbackExitTracker, TimeEwmaBasis, conservativePaperFill, feeAwareEdge,
  marketExitEstimate, planEntryExecution, rollingReturnBps, signalSide,
} = require('./core.cjs');

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function bookFromVenue(venue, at) {
  if (!venue?.bids?.length || !venue?.asks?.length) return null;
  return { bids: venue.bids, asks: venue.asks, receivedAt: at - Math.max(0, finite(venue.ageMs) || 0) };
}

function quoteFromVenue(venue, at) {
  const bid = finite(venue?.bid), ask = finite(venue?.ask), mid = finite(venue?.mid) ?? (bid > 0 && ask > 0 ? (bid + ask) / 2 : null);
  return mid > 0 ? { bid, ask, mid, receivedAt: at - Math.max(0, finite(venue?.ageMs) || 0) } : null;
}

function loadReplay(file) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Некорректный JSONL в строке ${index + 1}`); }
  });
  if (rows[0]?.type !== 'meta' || rows[0]?.version !== 1) throw new Error('Replay не содержит заголовок версии 1');
  return rows;
}

function runReplay(records, overrides = {}) {
  if (!Array.isArray(records) || records[0]?.type !== 'meta') throw new Error('Replay должен начинаться с meta');
  const meta = records[0], config = { ...meta.config, ...overrides.config }, rules = { ...meta.rules, ...overrides.rules };
  const fees = { ...meta.fees, ...overrides.fees }, defaults = { ...DEFAULTS, ...meta.defaults, ...overrides.defaults };
  const runtime = {
    impulseWindowMs: finite(config.impulseWindowMs) ?? defaults.impulseWindowMs,
    warmupMs: finite(config.warmupSeconds) === null ? defaults.warmupMs : finite(config.warmupSeconds) * 1000,
    basisHalfLifeMs: finite(config.basisHalfLifeSeconds) === null ? defaults.basisHalfLifeMs : finite(config.basisHalfLifeSeconds) * 1000,
    entryLifetimeMs: finite(config.entryLifetimeMs) ?? defaults.entryLifetimeMs,
    minimumHoldMs: finite(config.minimumHoldMs) ?? defaults.minimumHoldMs,
    trailingActivationBps: finite(config.trailingActivationPercent) === null ? defaults.trailingActivationBps : finite(config.trailingActivationPercent) * 100,
    reversalBps: finite(config.reversalPercent) === null ? defaults.reversalBps : finite(config.reversalPercent) * 100,
    reversalHoldMs: finite(config.reversalHoldMs) ?? defaults.reversalHoldMs,
    adverseBps: finite(config.adversePercent) === null ? defaults.adverseBps : finite(config.adversePercent) * 100,
    maxHoldMs: finite(config.maxHoldSeconds) === null ? defaults.maxHoldMs : finite(config.maxHoldSeconds) * 1000,
    minimumTrailNetBps: finite(config.minimumTrailNetPercent) === null ? defaults.minimumTrailNetBps : finite(config.minimumTrailNetPercent) * 100,
    maxEntrySlippageBps: finite(config.maxEntrySlippagePercent) === null ? defaults.maxEntrySlippageBps : finite(config.maxEntrySlippagePercent) * 100,
    marketEntryImpulseMultiplier: finite(config.marketEntryImpulseMultiplier) ?? defaults.marketEntryImpulseMultiplier,
    depthSafetyMultiplier: finite(config.depthSafetyMultiplier) ?? defaults.depthSafetyMultiplier,
  };
  const leaderName = meta.reference?.leader || 'binance';
  if (!(config.nominal > 0 && rules.tickSize > 0 && rules.quantityStep > 0 && fees.makerFee >= 0 && fees.takerFee >= 0)) throw new Error('Replay meta не содержит полные правила, комиссии и номинал');

  const basis = new TimeEwmaBasis({ halfLifeMs: runtime.basisHalfLifeMs, warmupMs: runtime.warmupMs });
  const gate = new ReentryGate((finite(config.cooldownSeconds) ?? defaults.cooldownMs / 1000) * 1000);
  const impulseThresholdBps = (finite(config.impulsePercent) ?? defaults.impulseBps / 100) * 100;
  const history = [], decisions = [];
  let lastAt = -Infinity, lastLeaderAt = null, priorSignal = false, active = null, position = null, tracker = null, lastBook = null;
  let samples = 0, eligibleSamples = 0, signals = 0, orders = 0, fills = 0, gross = 0, feesPaid = 0, maxHoldMs = 0;

  const close = (at, book, reason) => {
    if (!position || !book) return false;
    const exit = marketExitEstimate(book, position.side, position.quantity); if (!exit.enough) return false;
    const tradeGross = (position.side === 'BUY' ? exit.avgPrice - position.price : position.price - exit.avgPrice) * position.quantity;
    const tradeFees = position.price * position.quantity * position.entryFeeRate + exit.avgPrice * position.quantity * fees.takerFee;
    gross += tradeGross; feesPaid += tradeFees; maxHoldMs = Math.max(maxHoldMs, at - position.openedAt);
    decisions.push({ type: 'close', at, reason, side: position.side, quantity: position.quantity, price: exit.avgPrice, gross: tradeGross, net: tradeGross - tradeFees });
    position = null; tracker = null; gate.closed(at); return true;
  };

  const evaluate = (row, leader, book) => {
    const at = row.at, impulseBps = rollingReturnBps(history, at, runtime.impulseWindowMs), side = signalSide(impulseBps, impulseThresholdBps);
    const direction = impulseBps > 0 ? 'BUY' : impulseBps < 0 ? 'SELL' : null;
    gate.observeSignal(Boolean(side));
    const value = { at, impulseBps, direction, side, thresholdBps: impulseThresholdBps, minimumLagBps: defaults.extraEdgeBps, costsIgnored: false, eligible: false, reason: null };
    if (!leader || at - leader.receivedAt > defaults.leaderMaxAgeMs) value.reason = 'leader_stale';
    else if (!book || at - book.receivedAt > defaults.lbankMaxAgeMs) value.reason = 'lbank_stale';
    else if (!basis.ready(at)) value.reason = 'warming_up';
    else if (!side) value.reason = 'no_impulse';
    else try {
      const expectedFair = basis.expected(leader.mid);
      const execution = planEntryExecution({ book, side, notional: config.nominal, rules, expectedFair, impulseBps, thresholdBps: impulseThresholdBps,
        maxSlippageBps: runtime.maxEntrySlippageBps, marketImpulseMultiplier: runtime.marketEntryImpulseMultiplier,
        depthSafetyMultiplier: runtime.depthSafetyMultiplier });
      const entryPrice = execution.expectedFillPrice, quantity = execution.quantity;
      const exit = marketExitEstimate(book, side, quantity);
      const entryFeeRate = execution.postOnly ? fees.makerFee : fees.takerFee;
      const edge = exit.enough ? feeAwareEdge({ side, expectedFair, entryPrice, makerFee: entryFeeRate, takerFee: fees.takerFee, exitImpactBps: exit.impactBps, extraEdgeBps: defaults.extraEdgeBps }) : { eligible: false };
      const positiveLag = finite(edge.grossBps) > 0;
      const lagEligible = execution.canExecute !== false && exit.enough && edge.eligible === true;
      const paperFastEntry = config.mode === 'paper' && config.paperFast === true && execution.canExecute !== false && exit.enough;
      Object.assign(value, { entryPrice: execution.price, expectedEntryPrice: entryPrice, quantity, expectedFair, grossBps: edge.grossBps, costBps: edge.costBps, netEdgeBps: edge.netEdgeBps,
        feesCovered: Boolean(edge.eligible), lagEligible, paperFast: paperFastEntry,
        entryType: execution.type, postOnly: execution.postOnly, executionReason: execution.routeReason,
        entryImpactBps: execution.estimatedImpactBps, depthCoverage: execution.depthCoverage, entryFeeRate,
        eligible: Boolean(lagEligible || paperFastEntry), reason: execution.canExecute === false ? execution.routeReason : !exit.enough ? 'insufficient_exit_depth' : lagEligible || paperFastEntry ? null : positiveLag ? 'edge_too_small' : 'lag_not_positive' });
    } catch (error) { value.reason = 'invalid_book_or_size'; value.detail = error.message; }
    if (value.eligible) eligibleSamples++;
    if (value.eligible && !priorSignal) signals++;
    priorSignal = value.eligible;
    return value;
  };

  for (const row of records) {
    if (row?.type !== 'market') continue;
    const at = finite(row.at); if (at === null || at < lastAt) throw new Error('Replay нарушает временной порядок');
    lastAt = at; samples++;
    const leader = quoteFromVenue(row.market?.venues?.[leaderName], at), book = bookFromVenue(row.market?.venues?.lbank, at);
    if (leader && leader.receivedAt !== lastLeaderAt) {
      lastLeaderAt = leader.receivedAt; history.push({ at: leader.receivedAt, price: leader.mid });
      while (history.length && history[0].at < at - Math.max(3000, runtime.impulseWindowMs * 3)) history.shift();
    }
    if (leader && book && at - leader.receivedAt <= defaults.leaderMaxAgeMs && at - book.receivedAt <= defaults.lbankMaxAgeMs) {
      const lbankMid = ((finite(book.bids[0]?.price ?? book.bids[0]?.[0]) || 0) + (finite(book.asks[0]?.price ?? book.asks[0]?.[0]) || 0)) / 2;
      if (lbankMid > 0) basis.update(leader.mid, lbankMid, at);
    }
    const evaluation = evaluate(row, leader, book); lastBook = book || lastBook;

    if (active && book && at > active.placedAt) {
      const paper = conservativePaperFill(book, active, rules.tickSize);
      if (paper.fill > 0) active.executedQty += paper.fill;
      const shouldCancel = at >= active.expiresAt || !evaluation.eligible || evaluation.side !== active.side;
      if (active.executedQty >= active.quantity - active.quantity * 1e-8 || shouldCancel) {
        if (active.executedQty > 0) {
          position = { side: active.side, quantity: active.executedQty, price: active.price, openedAt: at, leaderEntry: active.leaderEntry, entryFeeRate: fees.makerFee };
          tracker = new PullbackExitTracker({ side: position.side, leaderEntry: position.leaderEntry, lbankEntry: position.price, openedAt: at,
            minimumHoldMs: runtime.minimumHoldMs, signalThresholdBps: runtime.trailingActivationBps, trailBps: runtime.reversalBps,
            emergencyBps: runtime.adverseBps, maxHoldMs: runtime.maxHoldMs });
          fills++; decisions.push({ type: 'fill', at, side: position.side, quantity: position.quantity, price: position.price });
        } else decisions.push({ type: 'cancel', at, reason: shouldCancel ? evaluation.reason || 'deadline' : 'deadline' });
        active = null;
      }
    }

    if (position && tracker && leader) {
      const exitBook = book || lastBook;
      let lbankMid = null;
      try { lbankMid = exitBook ? (Number(exitBook.bids[0]?.price ?? exitBook.bids[0]?.[0]) + Number(exitBook.asks[0]?.price ?? exitBook.asks[0]?.[0])) / 2 : null; } catch {}
      const expectedFair = basis.expected(leader.mid), lagBps = expectedFair > 0 && lbankMid > 0 ? (expectedFair - lbankMid) / lbankMid * 10_000 : null;
      const reason = tracker.observe({ leaderPrice: leader.mid, lbankPrice: lbankMid, lagBps }, at);
      let mayClose = Boolean(reason);
      if (mayClose && ['signal_ended', 'trailing_pullback'].includes(reason)) {
        const exitBook = book || lastBook, exit = exitBook ? marketExitEstimate(exitBook, position.side, position.quantity) : null;
        if (!exit?.enough) mayClose = false;
        else {
          const tradeGross = (position.side === 'BUY' ? exit.avgPrice - position.price : position.price - exit.avgPrice) * position.quantity;
          const tradeFees = position.price * position.quantity * position.entryFeeRate + exit.avgPrice * position.quantity * fees.takerFee;
          const netBps = (tradeGross - tradeFees) / (position.price * position.quantity) * 10_000;
          if (netBps < runtime.minimumTrailNetBps) mayClose = false;
        }
      }
      if (mayClose) close(at, book || lastBook, reason);
    }
    if (!active && !position && evaluation.eligible && gate.canEnter(at)) {
      orders++; decisions.push({ type: 'order', at, side: evaluation.side, quantity: evaluation.quantity, price: evaluation.entryPrice,
        entryType: evaluation.entryType, postOnly: evaluation.postOnly, executionReason: evaluation.executionReason, netEdgeBps: evaluation.netEdgeBps });
      if (evaluation.entryType === 'MARKET' || evaluation.postOnly === false) {
        position = { side: evaluation.side, quantity: evaluation.quantity, price: evaluation.expectedEntryPrice ?? evaluation.entryPrice, openedAt: at, leaderEntry: leader.mid, entryFeeRate: evaluation.entryFeeRate };
        tracker = new PullbackExitTracker({ side: position.side, leaderEntry: position.leaderEntry, lbankEntry: position.price, openedAt: at,
          minimumHoldMs: runtime.minimumHoldMs, signalThresholdBps: runtime.trailingActivationBps, trailBps: runtime.reversalBps,
          emergencyBps: runtime.adverseBps, maxHoldMs: runtime.maxHoldMs });
        fills++; decisions.push({ type: 'fill', at, side: position.side, quantity: position.quantity, price: position.price, entryType: evaluation.entryType, postOnly: evaluation.postOnly });
      } else {
        active = { side: evaluation.side, quantity: evaluation.quantity, executedQty: 0, price: evaluation.entryPrice, placedAt: at,
          expiresAt: at + runtime.entryLifetimeMs, leaderEntry: leader.mid };
      }
    }
  }
  if (active) decisions.push({ type: 'cancel', at: lastAt, reason: 'end_of_replay' });
  if (position && lastBook) close(lastAt, lastBook, 'end_of_replay');
  return { samples, signals, eligibleSamples, orders, fills, fillRate: orders ? fills / orders : 0, grossPnl: gross, fees: feesPaid, netPnl: gross - feesPaid,
    maxHoldMs, leader: leaderName, symbol: config.symbol, decisions };
}

if (require.main === module) {
  try {
    const file = process.argv[2]; if (!file) throw new Error('Использование: node replay.cjs <replay.jsonl>');
    const report = runReplay(loadReplay(file)); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { bookFromVenue, loadReplay, quoteFromVenue, runReplay };
