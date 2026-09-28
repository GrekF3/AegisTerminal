#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Scanner, commonSymbol, normalizeDepth } = require('./liquidity-lag-scanner.cjs');
const { decimalString } = require('../tools/lbank-impulse/market-streams.cjs');
const {
  PullbackExitTracker, ReentryGate, TimeEwmaBasis, conservativePaperFill, feeAwareEdge,
  marketExitEstimate, planEntryExecution, rollingReturnBps, signalSide,
} = require('../tools/lbank-impulse/core.cjs');

const ROOT = path.resolve(__dirname, '..');
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

function stamp(at = Date.now()) { return new Date(at).toISOString().replace(/[:.]/g, '-'); }

function inferTick(book) {
  const prices = [...(book?.bids || []), ...(book?.asks || [])].map(row => finite(row?.price ?? row?.[0])).filter(value => value > 0).sort((a, b) => a - b);
  let tick = Infinity;
  for (let index = 1; index < prices.length; index++) {
    const difference = prices[index] - prices[index - 1];
    if (difference > prices[index] * 1e-10) tick = Math.min(tick, difference);
  }
  if (Number.isFinite(tick)) return Number(tick.toPrecision(10));
  const mid = finite(book?.mid) || prices[0] || 1;
  return Number((10 ** Math.floor(Math.log10(mid) - 6)).toPrecision(10));
}

function atomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

class PortfolioPaper {
  constructor(scanner, options = {}) {
    this.scanner = scanner;
    this.adaptive = options.adaptive || null;
    this.options = {
      nominal: finite(options.nominal) || 50,
      impulseBps: finite(options.impulseBps) || 3,
      impulseWindowMs: finite(options.impulseWindowMs) || 1000,
      warmupMs: finite(options.warmupMs) ?? 30_000,
      basisHalfLifeMs: finite(options.basisHalfLifeMs) || 30_000,
      entryLifetimeMs: finite(options.entryLifetimeMs) || 1000,
      minimumHoldMs: finite(options.minimumHoldMs) ?? 2000,
      activeLagBps: finite(options.activeLagBps) || 3,
      trailBps: finite(options.trailBps) || 2,
      emergencyBps: finite(options.emergencyBps) || 3,
      maxHoldMs: finite(options.maxHoldMs) || 60_000,
      cooldownMs: finite(options.cooldownMs) ?? 0,
      makerFee: finite(options.makerFee) ?? .00016,
      takerFee: finite(options.takerFee) ?? .0004,
      extraEdgeBps: finite(options.extraEdgeBps) ?? 2,
      minimumTrailNetBps: finite(options.minimumTrailNetBps) ?? 0,
      feeRows: options.feeRows && typeof options.feeRows === 'object' ? options.feeRows : null,
      maxEntrySlippageBps: finite(options.maxEntrySlippageBps) ?? 0,
      maxEntrySpreadBps: finite(options.maxEntrySpreadBps) || 5,
      marketImpulseMultiplier: finite(options.marketImpulseMultiplier) || 1,
      depthSafetyMultiplier: finite(options.depthSafetyMultiplier) || 2,
      entryLeaderMaxAgeMs: 500,
      entryLbankMaxAgeMs: 1000,
      positionMaxAgeMs: 5000,
      depthRequestsPerMinute: Math.max(1, finite(options.depthRequestsPerMinute) || 120),
    };
    this.states = new Map(); this.depthQueue = []; this.depthActive = 0; this.nextDepthAt = 0; this.depthPumpTimer = null;
    this.sequence = 0; this.finished = false;
    this.tradeFile = path.join(scanner.outputDir, 'paper-trades.jsonl');
    this.partialFile = path.join(scanner.outputDir, 'paper-report.partial.json');
    this.statusFile = path.join(scanner.outputDir, 'paper-status.json');
  }

  initialize() {
    const symbols = [...new Set([...this.scanner.lbankMexc, ...this.scanner.lbankBinance])].sort();
    for (const symbol of symbols) {
      const leader = this.scanner.markets.binance.has(symbol) ? 'binance' : 'mexc';
      const dynamicSettings = this.adaptive?.settingsFor(symbol, leader) || {
        thresholdBps: this.options.impulseBps, activeLagBps: this.options.activeLagBps,
        trailBps: this.options.trailBps, emergencyBps: this.options.emergencyBps, maxHoldMs: this.options.maxHoldMs,
      };
      this.states.set(symbol, {
        symbol, leader, basis: new TimeEwmaBasis({ halfLifeMs: this.options.basisHalfLifeMs, warmupMs: this.options.warmupMs }),
        dynamicSettings,
        gate: new ReentryGate(this.options.cooldownMs), history: [], lastLeaderAt: null, lastBasisPair: '', evaluation: null,
        pending: null, order: null, position: null, positionBook: null, positionBookClose: null, tracker: null, awaitingExit: null,
        stats: { signals: 0, orders: 0, marketOrders: 0, limitOrders: 0, canceled: 0, partialFills: 0, fills: 0,
          trades: 0, wins: 0, losses: 0, breakeven: 0, gross: 0, fees: 0, net: 0, maxHoldMs: 0,
          skippedDepthRate: 0, skippedDepth: 0, skippedSpread: 0, exitReasons: {} },
      });
    }
  }

  quote(venue, symbol) { return this.scanner.quotes.get(`${venue}:${symbol}`); }
  feesFor(symbol) {
    const row = this.options.feeRows?.[symbol] || this.options.feeRows?.default;
    return { makerFee: finite(row?.makerFee) ?? this.options.makerFee, takerFee: finite(row?.takerFee) ?? this.options.takerFee };
  }

  updateHistory(state, leader) {
    if (!leader || leader.receivedAt === state.lastLeaderAt) return;
    state.lastLeaderAt = leader.receivedAt; state.history.push({ at: leader.receivedAt, price: leader.price });
    const cutoff = leader.receivedAt - Math.max(3000, this.options.impulseWindowMs * 3);
    while (state.history.length && state.history[0].at < cutoff) state.history.shift();
  }

  evaluate(state, now = Date.now()) {
    const leader = this.quote(state.leader, state.symbol), lbank = this.quote('lbank', state.symbol);
    this.updateHistory(state, leader);
    if (leader && lbank && Math.abs(leader.receivedAt - lbank.receivedAt) <= 2000) {
      const pair = `${leader.receivedAt}:${lbank.receivedAt}`;
      if (pair !== state.lastBasisPair) { state.lastBasisPair = pair; state.basis.update(leader.price, lbank.price, Math.max(leader.receivedAt, lbank.receivedAt)); }
    }
    const thresholdBps = state.dynamicSettings?.thresholdBps || this.options.impulseBps;
    const impulseBps = rollingReturnBps(state.history, now, this.options.impulseWindowMs), side = signalSide(impulseBps, thresholdBps);
    state.gate.observeSignal(Boolean(side));
    const value = { at: now, side, impulseBps, eligible: false, reason: null, expectedFair: null, lagBps: null };
    if (!leader || now - leader.receivedAt > this.options.entryLeaderMaxAgeMs) value.reason = 'leader_stale';
    else if (!lbank || now - lbank.receivedAt > this.options.entryLbankMaxAgeMs) value.reason = 'lbank_stale';
    else if (!state.basis.ready(now)) value.reason = 'warming_up';
    else if (!side) value.reason = 'no_impulse';
    else {
      value.expectedFair = state.basis.expected(leader.price);
      value.lagBps = (value.expectedFair - lbank.price) / lbank.price * 10_000;
      value.eligible = side === 'BUY' ? value.lagBps > 0 : value.lagBps < 0;
      if (!value.eligible) value.reason = 'lag_not_positive';
    }
    state.evaluation = value; return value;
  }

  onQuote(venue, rawSymbol) {
    if (this.finished) return;
    const state = this.states.get(commonSymbol(rawSymbol)); if (!state || ![state.leader, 'lbank'].includes(venue)) return;
    const now = Date.now(), evaluation = this.evaluate(state, now);
    if (state.pending && now >= state.pending.expiresAt) this.cancelPending(state, 'entry_depth_timeout');
    if (state.order && (now >= state.order.expiresAt || !this.entryStillGood(state, state.order.side, now))) this.finishLimit(state, evaluation.reason || 'signal_faded');
    if (state.position) this.monitorPosition(state, now);
    if (!state.pending && !state.order && !state.position && evaluation.eligible && state.gate.canEnter(now)) this.beginSignal(state, evaluation, now);
  }

  beginSignal(state, evaluation, now) {
    const token = `paper-${++this.sequence}`;
    const thresholdBps = state.dynamicSettings?.thresholdBps || this.options.impulseBps;
    state.pending = { token, detectedAt: now, expiresAt: now + this.options.entryLifetimeMs, side: evaluation.side,
      impulseBps: evaluation.impulseBps, thresholdBps, tradeSettings: { ...state.dynamicSettings },
      expectedFair: evaluation.expectedFair, leaderEntry: this.quote(state.leader, state.symbol)?.price };
    state.stats.signals++;
    if (this.adaptive) {
      this.adaptive.recordAttempt({ symbol: state.symbol, leader: state.leader, thresholdBps });
      state.dynamicSettings = this.adaptive.settingsFor(state.symbol, state.leader);
    }
    if (!this.requestDepth(state, 'entry', token)) {
      state.stats.skippedDepthRate++; state.pending = null; state.gate.needsReset = true;
    }
  }

  entryStillGood(state, side, now = Date.now()) {
    const leader = this.quote(state.leader, state.symbol), lbank = this.quote('lbank', state.symbol);
    if (!leader || !lbank || now - leader.receivedAt > this.options.entryLeaderMaxAgeMs || now - lbank.receivedAt > this.options.entryLbankMaxAgeMs) return false;
    const expectedFair = state.basis.expected(leader.price); if (!(expectedFair > 0)) return false;
    const lagBps = (expectedFair - lbank.price) / lbank.price * 10_000, signedLag = side === 'BUY' ? lagBps : -lagBps;
    const impulse = state.evaluation?.impulseBps;
    const thresholdBps = state.order?.thresholdBps || state.pending?.thresholdBps || state.dynamicSettings?.thresholdBps || this.options.impulseBps;
    return signedLag > 0 && !(Number.isFinite(impulse) && Math.abs(impulse) >= thresholdBps && (impulse > 0 ? 'BUY' : 'SELL') !== side);
  }

  requestDepth(state, action, token, delayMs = 0) {
    const enqueue = () => {
      if (this.finished) return false;
      const request = { state, action, token, requestedAt: Date.now() };
      if (action === 'exit') this.depthQueue.unshift(request);
      else if (action === 'fill') {
        // A resting maker order has only one second to prove execution. Check it
        // before spending the next slot on another entry candidate.
        const insertionPoint = this.depthQueue.findIndex(row => row.action === 'entry');
        this.depthQueue.splice(insertionPoint < 0 ? this.depthQueue.length : insertionPoint, 0, request);
      } else if (state.leader === 'binance') {
        const insertionPoint = this.depthQueue.findIndex(row => row.action !== 'exit' && row.state.leader !== 'binance');
        this.depthQueue.splice(insertionPoint < 0 ? this.depthQueue.length : insertionPoint, 0, request);
      } else this.depthQueue.push(request);
      this.pumpDepth();
      return true;
    };
    if (delayMs > 0) { setTimeout(enqueue, delayMs).unref?.(); return true; }
    return enqueue();
  }

  pumpDepth() {
    if (this.finished || this.depthActive || !this.depthQueue.length) return;
    const waitMs = this.nextDepthAt - Date.now();
    if (waitMs > 0) {
      if (!this.depthPumpTimer) this.depthPumpTimer = setTimeout(() => { this.depthPumpTimer = null; this.pumpDepth(); }, waitMs);
      return;
    }
    let job;
    while (this.depthQueue.length && !job) {
      const candidate = this.depthQueue.shift(), state = candidate.state;
      const valid = candidate.action === 'entry' ? state.pending?.token === candidate.token && Date.now() < state.pending.expiresAt
        : candidate.action === 'fill' ? state.order?.token === candidate.token && Date.now() <= state.order.expiresAt
          : state.position && state.awaitingExit?.token === candidate.token;
      if (valid) job = candidate;
    }
    if (job) {
      // Evenly pace actual HTTP requests. Reserving the whole minute's quota at
      // signal time starves newer, still-actionable signals behind stale work.
      this.depthActive++;
      this.nextDepthAt = Date.now() + Math.max(350, Math.ceil(60_000 / this.options.depthRequestsPerMinute));
      this.scanner.fetchDepth('lbank', job.state.symbol).then(book => {
        const receivedAt = Date.now(); book.receivedAt = receivedAt;
        this.scanner.latestDepth.set(`lbank:${job.state.symbol}`, { metrics: book, receivedAt });
        this.onDepth(job.state.symbol, book, { paperAction: job.action, paperToken: job.token });
      }).catch(error => {
        this.scanner.noteError('paper:lbank-depth', error);
        if (job.action === 'exit' && job.state.position) this.requestDepth(job.state, job.action, job.token, 500);
      }).finally(() => { this.depthActive--; this.pumpDepth(); });
    }
  }

  onDepth(symbol, book, job = {}) {
    const state = this.states.get(commonSymbol(symbol)); if (!state || this.finished) return;
    if (state.pending && (!job.paperToken || job.paperToken === state.pending.token)) this.processEntryBook(state, book);
    else if (state.order && (!job.paperToken || job.paperToken === state.order.token)) this.processLimitBook(state, book);
    if (state.position && state.awaitingExit && (!job.paperToken || job.paperToken === state.awaitingExit.token)) this.processExitBook(state, book);
  }

  processEntryBook(state, book) {
    const pending = state.pending, now = Date.now(); if (!pending) return;
    const evaluation = this.evaluate(state, now);
    const leader = this.quote(state.leader, state.symbol), expectedFair = leader ? state.basis.expected(leader.price) : null;
    const bookLagBps = expectedFair > 0 && book?.mid > 0 ? (expectedFair - book.mid) / book.mid * 10_000 : null;
    const signedBookLag = pending.side === 'BUY' ? bookLagBps : -bookLagBps;
    const currentImpulse = evaluation.impulseBps, thresholdBps = pending.thresholdBps || this.options.impulseBps;
    const oppositeImpulse = Number.isFinite(currentImpulse) && Math.abs(currentImpulse) >= thresholdBps
      && (currentImpulse > 0 ? 'BUY' : 'SELL') !== pending.side;
    if (now >= pending.expiresAt || !leader || now - leader.receivedAt > this.options.entryLeaderMaxAgeMs || !(signedBookLag > 0) || oppositeImpulse) {
      this.cancelPending(state, evaluation.reason || 'entry_expired'); return;
    }
    try {
      if (book.spreadBps > this.options.maxEntrySpreadBps) {
        state.stats.skippedSpread++; this.cancelPending(state, 'entry_spread_too_wide'); return;
      }
      const tickSize = inferTick(book), rules = { tickSize, quantityStep: 1e-12, minQuantity: 1e-12, minNotional: 0, maxQuantity: 1e15 };
      const fees = this.feesFor(state.symbol);
      const plan = planEntryExecution({ book, side: pending.side, notional: this.options.nominal, rules, expectedFair,
        impulseBps: pending.impulseBps, thresholdBps, maxSlippageBps: this.options.maxEntrySlippageBps,
        marketImpulseMultiplier: this.options.marketImpulseMultiplier, depthSafetyMultiplier: this.options.depthSafetyMultiplier,
        allowSizeToDepth: true });
      if (plan.canExecute === false) {
        state.stats.skippedDepth++; this.cancelPending(state, plan.routeReason); return;
      }
      const exit = marketExitEstimate(book, pending.side, plan.quantity), entryFeeRate = plan.postOnly ? fees.makerFee : fees.takerFee;
      const edge = exit.enough ? feeAwareEdge({ side: pending.side, expectedFair, entryPrice: plan.expectedFillPrice,
        makerFee: entryFeeRate, takerFee: fees.takerFee, exitImpactBps: exit.impactBps, extraEdgeBps: this.options.extraEdgeBps }) : null;
      if (!exit.enough || edge?.eligible !== true) {
        state.stats.skippedDepth++; this.cancelPending(state, 'entry_costs_not_covered'); return;
      }
      state.pending = null; state.stats.orders++;
      if (plan.type === 'MARKET' || plan.postOnly === false) {
        if (plan.type === 'MARKET') state.stats.marketOrders++; else state.stats.limitOrders++;
        this.establish(state, { side: pending.side, quantity: plan.quantity, price: plan.expectedFillPrice,
          leaderEntry: pending.leaderEntry, entryType: plan.type, postOnly: plan.postOnly, entryFeeRate: fees.takerFee, exitFeeRate: fees.takerFee, tickSize,
          impulseBps: pending.impulseBps, thresholdBps, tradeSettings: pending.tradeSettings, lagBps: bookLagBps, expectedFair, entryBid: book.bid, entryAsk: book.ask,
          bookSpreadBps: book.spreadBps, routeReason: plan.routeReason }, now);
      } else {
        state.stats.limitOrders++; state.order = { token: pending.token, side: pending.side, quantity: plan.quantity, executedQty: 0,
          price: plan.price, leaderEntry: pending.leaderEntry, entryType: 'LIMIT', entryFeeRate: fees.makerFee, exitFeeRate: fees.takerFee,
          tickSize, placedAt: now, expiresAt: pending.expiresAt, impulseBps: pending.impulseBps, thresholdBps,
          tradeSettings: pending.tradeSettings, lagBps: bookLagBps,
          expectedFair, entryBid: book.bid, entryAsk: book.ask, bookSpreadBps: book.spreadBps, routeReason: plan.routeReason };
        for (const delay of [200, 500, 850]) this.requestDepth(state, 'fill', pending.token, delay);
        setTimeout(() => { if (state.order?.token === pending.token) this.finishLimit(state, 'deadline'); }, Math.max(1, pending.expiresAt - now + 10)).unref?.();
      }
    } catch {
      state.stats.skippedDepth++; this.cancelPending(state, 'invalid_or_thin_entry_book');
    }
  }

  processLimitBook(state, book) {
    const order = state.order; if (!order) return;
    try {
      const fill = conservativePaperFill(book, order, order.tickSize);
      // Repeated snapshots can show the same resting volume. Keep the largest
      // independently supported fill instead of counting that liquidity twice.
      if (fill.fill > 0) order.executedQty = Math.max(order.executedQty, Math.min(order.quantity, fill.available));
    } catch {}
    const evaluation = this.evaluate(state, Date.now());
    if (order.executedQty >= order.quantity - order.quantity * 1e-8 || Date.now() >= order.expiresAt || !this.entryStillGood(state, order.side)) {
      this.finishLimit(state, Date.now() >= order.expiresAt ? 'deadline' : evaluation.reason || 'filled');
    }
  }

  finishLimit(state, reason) {
    const order = state.order; if (!order) return; state.order = null;
    if (order.executedQty > 0) {
      if (order.executedQty < order.quantity - order.quantity * 1e-8) state.stats.partialFills++;
      this.establish(state, { ...order, quantity: order.executedQty }, Date.now());
    } else { state.stats.canceled++; state.gate.needsReset = true; }
  }

  cancelPending(state) { if (state.pending) { state.pending = null; state.stats.canceled++; state.gate.needsReset = true; } }

  establish(state, fill, now) {
    state.stats.fills++;
    state.position = { side: fill.side, quantity: fill.quantity, price: fill.price, entryType: fill.entryType, postOnly: fill.postOnly === true,
      entryFeeRate: fill.entryFeeRate, exitFeeRate: fill.exitFeeRate ?? this.feesFor(state.symbol).takerFee,
      openedAt: now, leaderEntry: fill.leaderEntry, impulseBps: fill.impulseBps,
      thresholdBps: fill.thresholdBps || state.dynamicSettings?.thresholdBps || this.options.impulseBps,
      lagBps: fill.lagBps, expectedFair: fill.expectedFair, entryBid: fill.entryBid, entryAsk: fill.entryAsk,
      bookSpreadBps: fill.bookSpreadBps, routeReason: fill.routeReason };
    const dynamic = fill.tradeSettings || state.dynamicSettings || {};
    state.tracker = new PullbackExitTracker({ side: fill.side, leaderEntry: fill.leaderEntry, lbankEntry: fill.price, openedAt: now,
      signalThresholdBps: dynamic.activeLagBps || this.options.activeLagBps, minimumHoldMs: this.options.minimumHoldMs,
      trailBps: dynamic.trailBps || this.options.trailBps,
      emergencyBps: dynamic.emergencyBps || this.options.emergencyBps, maxHoldMs: dynamic.maxHoldMs || this.options.maxHoldMs });
    this.startPositionBook(state, fill.tickSize);
  }

  startPositionBook(state, tickSize) {
    this.stopPositionBook(state);
    if (typeof this.scanner.openSocket !== 'function' || !(finite(tickSize) > 0)) return;
    const subscriptionId = `paper-${++this.sequence}`;
    state.positionBookClose = this.scanner.openSocket(`lbank-position-${state.symbol}-${subscriptionId}`, 'wss://uuws.rerrkvifj.com/ws/v3', {
      heartbeat: 'ping',
      onOpen: socket => socket.send(JSON.stringify({ x: 3, y: subscriptionId, z: 1,
        a: { i: `${state.symbol}_${decimalString(tickSize)}_25` }, e: '{"bvc":"202","isUsd":1}' })),
      onMessage: message => {
        if (!state.position || Number(message?.x) !== 3 || ![3, 4].includes(Number(message?.z))) return;
        try {
          const book = normalizeDepth(message.b, message.s); book.receivedAt = Date.now(); state.positionBook = book;
          this.monitorPosition(state, book.receivedAt);
        } catch (error) { this.scanner.noteError(`paper:${state.symbol}:position-book`, error); }
      },
    });
  }

  stopPositionBook(state) {
    try { state.positionBookClose?.(); } catch {}
    state.positionBookClose = null; state.positionBook = null;
  }

  monitorPosition(state, now = Date.now()) {
    if (!state.position || !state.tracker || state.awaitingExit) return;
    const leader = this.quote(state.leader, state.symbol), lbank = state.positionBook;
    const waitingForFirstBook = !lbank && now - state.position.openedAt <= this.options.positionMaxAgeMs;
    if (!leader || now - leader.receivedAt > this.options.positionMaxAgeMs || (!lbank && !waitingForFirstBook)
      || (lbank && now - lbank.receivedAt > this.options.positionMaxAgeMs)) {
      return this.requestExit(state, 'stale_market_data');
    }
    if (!lbank) return;
    const expectedFair = state.basis.expected(leader.price), lagBps = expectedFair > 0 ? (expectedFair - lbank.mid) / lbank.mid * 10_000 : null;
    const reason = state.tracker.observe({ leaderPrice: leader.price, lbankPrice: lbank.mid, lagBps }, now);
    if (!reason) return;
    if (['signal_ended', 'trailing_pullback'].includes(reason)) {
      let exit; try { exit = marketExitEstimate(lbank, state.position.side, state.position.quantity); } catch {}
      if (!exit?.enough) return;
      const gross = (state.position.side === 'BUY' ? exit.avgPrice - state.position.price : state.position.price - exit.avgPrice) * state.position.quantity;
      const fees = state.position.price * state.position.quantity * state.position.entryFeeRate + exit.avgPrice * state.position.quantity * state.position.exitFeeRate;
      const netBps = (gross - fees) / (state.position.price * state.position.quantity) * 10_000;
      if (netBps < this.options.minimumTrailNetBps) return;
    }
    this.requestExit(state, reason);
  }

  requestExit(state, reason) {
    if (!state.position || state.awaitingExit) return;
    const token = `exit-${++this.sequence}`; state.awaitingExit = { token, reason, startedAt: Date.now() };
    this.requestDepth(state, 'exit', token);
  }

  processExitBook(state, book) {
    const pending = state.awaitingExit, position = state.position; if (!pending || !position) return;
    let exit;
    try { exit = marketExitEstimate(book, position.side, position.quantity); } catch {}
    if (!exit?.enough) {
      if (Date.now() - pending.startedAt < 5000) this.requestDepth(state, 'exit', pending.token, 300);
      else state.stats.skippedDepth++;
      return;
    }
    const gross = (position.side === 'BUY' ? exit.avgPrice - position.price : position.price - exit.avgPrice) * position.quantity;
    const fees = position.price * position.quantity * position.entryFeeRate + exit.avgPrice * position.quantity * position.exitFeeRate;
    const net = gross - fees, heldMs = Date.now() - position.openedAt;
    const entryNotional = position.price * position.quantity, netBps = entryNotional > 0 ? net / entryNotional * 10_000 : 0;
    Object.assign(state.stats, { trades: state.stats.trades + 1, gross: state.stats.gross + gross,
      fees: state.stats.fees + fees, net: state.stats.net + net, maxHoldMs: Math.max(state.stats.maxHoldMs, heldMs) });
    if (net > 1e-12) state.stats.wins++; else if (net < -1e-12) state.stats.losses++; else state.stats.breakeven++;
    state.stats.exitReasons[pending.reason] = (state.stats.exitReasons[pending.reason] || 0) + 1;
    fs.appendFileSync(this.tradeFile, `${JSON.stringify({ at: Date.now(), symbol: state.symbol, leader: state.leader, side: position.side,
      entryType: position.entryType, quantity: position.quantity, entryPrice: position.price, exitPrice: exit.avgPrice,
      entryImpulseBps: position.impulseBps, entryLagBps: position.lagBps, expectedFair: position.expectedFair,
      entryBid: position.entryBid, entryAsk: position.entryAsk, entrySpreadBps: position.bookSpreadBps,
      routeReason: position.routeReason, heldMs, reason: pending.reason,
      grossBps: gross / (position.price * position.quantity) * 10_000,
      feeBps: fees / (position.price * position.quantity) * 10_000, gross, fees, net })}\n`);
    if (this.adaptive) {
      this.adaptive.recordTrade({ symbol: state.symbol, leader: state.leader, thresholdBps: position.thresholdBps,
        gross, fees, net, netBps, heldMs, reason: pending.reason });
      state.dynamicSettings = this.adaptive.settingsFor(state.symbol, state.leader);
    }
    this.stopPositionBook(state); state.position = null; state.tracker = null; state.awaitingExit = null; state.gate.closed(Date.now());
  }

  sweep() {
    if (this.finished) return;
    const now = Date.now();
    for (const state of this.states.values()) {
      if (state.pending && now >= state.pending.expiresAt) this.cancelPending(state, 'entry_depth_timeout');
      if (state.order && now >= state.order.expiresAt) this.finishLimit(state, 'deadline');
      if (state.position) this.monitorPosition(state, now);
    }
  }

  row(state) {
    const phase = state.position ? state.awaitingExit ? 'closing' : 'position' : state.order ? 'order' : state.pending ? 'signal' : 'waiting';
    return { symbol: state.symbol, leader: state.leader, phase, ...state.stats,
      thresholdBps: state.dynamicSettings?.thresholdBps || this.options.impulseBps,
      activeLagBps: state.dynamicSettings?.activeLagBps || this.options.activeLagBps,
      trailBps: state.dynamicSettings?.trailBps || this.options.trailBps,
      winRate: state.stats.trades ? state.stats.wins / state.stats.trades : null,
      fillRate: state.stats.orders ? state.stats.fills / state.stats.orders : null,
      lastImpulseBps: state.evaluation?.impulseBps ?? null, lastLagBps: state.evaluation?.lagBps ?? null,
      evaluationReason: state.evaluation?.reason ?? null, basisReady: state.basis.ready(Date.now()), historySamples: state.history.length,
      historySpanMs: state.history.length > 1 ? state.history.at(-1).at - state.history[0].at : 0 };
  }

  summary(final = false) {
    const rows = [...this.states.values()].map(state => this.row(state));
    const totals = rows.reduce((sum, row) => {
      for (const key of ['signals', 'orders', 'marketOrders', 'limitOrders', 'canceled', 'partialFills', 'fills', 'trades', 'wins', 'losses', 'breakeven', 'gross', 'fees', 'net', 'skippedDepthRate', 'skippedDepth', 'skippedSpread']) sum[key] += row[key];
      if (row.phase === 'position' || row.phase === 'closing') sum.openPositions++; return sum;
    }, { signals: 0, orders: 0, marketOrders: 0, limitOrders: 0, canceled: 0, partialFills: 0, fills: 0, trades: 0,
      wins: 0, losses: 0, breakeven: 0, gross: 0, fees: 0, net: 0, skippedDepthRate: 0, skippedDepth: 0, skippedSpread: 0, openPositions: 0 });
    totals.winRate = totals.trades ? totals.wins / totals.trades : null; totals.fillRate = totals.orders ? totals.fills / totals.orders : null;
    rows.sort((a, b) => b.net - a.net || b.trades - a.trades || a.symbol.localeCompare(b.symbol));
    const { feeRows: _feeRows, adaptive: _adaptive, ...assumptions } = this.options;
    return { version: 1, final, pid: process.pid, generatedAt: new Date().toISOString(), strategy: 'ZEC_USD1 pullback',
      assumptions: { ...assumptions, feesArePersonalLbankRates: Boolean(this.options.feeRows), syntheticFills: false }, monitoredSymbols: rows.length, totals, rows };
  }

  checkpoint() {
    const report = this.summary(false); atomic(this.partialFile, report);
    atomic(this.statusFile, { final: false, pid: process.pid, generatedAt: report.generatedAt, outputDir: this.scanner.outputDir,
      monitoredSymbols: report.monitoredSymbols, totals: report.totals });
  }

  finish() {
    if (this.finished) return;
    for (const state of this.states.values()) {
      if (state.pending) this.cancelPending(state, 'end_of_run');
      if (state.order) this.finishLimit(state, 'end_of_run');
      if (state.position) {
        state.awaitingExit ||= { token: `end-${++this.sequence}`, reason: 'end_of_run', startedAt: Date.now() };
        const depth = this.scanner.latestDepth.get(`lbank:${state.symbol}`)?.metrics;
        if (depth) this.processExitBook(state, depth);
      }
      this.stopPositionBook(state);
    }
    this.finished = true;
  }

  writeFinal(reason) {
    const report = { ...this.summary(true), reason, startedAt: new Date(this.scanner.startedAt).toISOString(), endsAt: new Date(this.scanner.endAt).toISOString() };
    atomic(path.join(this.scanner.outputDir, 'paper-report.json'), report);
    const columns = ['rank', 'symbol', 'leader', 'signals', 'orders', 'fills', 'trades', 'wins', 'losses', 'winRate', 'gross', 'fees', 'net', 'maxHoldMs', 'phase'];
    const lines = [columns.join(',')]; report.rows.forEach((row, index) => lines.push([index + 1, ...columns.slice(1).map(key => row[key] ?? '')].join(',')));
    fs.writeFileSync(path.join(this.scanner.outputDir, 'paper-results.csv'), `${lines.join('\n')}\n`);
    const top = report.rows.filter(row => row.trades > 0).slice(0, 100);
    const markdown = ['# LBank all-coins Paper · ZEC_USD1 exits', '', `Started: ${report.startedAt}`, `Finished: ${report.generatedAt}`,
      `Monitored: ${report.monitoredSymbols}`, `Trades: ${report.totals.trades}`, `Net: ${report.totals.net.toFixed(6)} USDT`, '',
      '| # | Symbol | Leader | Trades | Win % | Gross | Fees | Net |', '|---:|---|---|---:|---:|---:|---:|---:|',
      ...top.map((row, index) => `| ${index + 1} | ${row.symbol} | ${row.leader} | ${row.trades} | ${row.winRate == null ? '—' : (row.winRate * 100).toFixed(1)} | ${row.gross.toFixed(4)} | ${row.fees.toFixed(4)} | ${row.net.toFixed(4)} |`), ''];
    fs.writeFileSync(path.join(this.scanner.outputDir, 'paper-report.md'), markdown.join('\n'));
    atomic(this.statusFile, { final: true, reason, pid: process.pid, generatedAt: report.generatedAt, outputDir: this.scanner.outputDir,
      monitoredSymbols: report.monitoredSymbols, totals: report.totals });
  }
}

class PortfolioScanner extends Scanner {
  constructor(options = {}) { super(options); this.paper = new PortfolioPaper(this, options.paper); this.paperTimer = null; }
  async discover() { await super.discover(); this.paper.initialize(); this.paperTimer = setInterval(() => this.paper.sweep(), 250); }
  updateQuote(venue, symbol, input, bootstrap = false) { super.updateQuote(venue, symbol, input, bootstrap); this.paper?.onQuote(venue, symbol); }
  captureAroundEvent(event) { event.depthCapture = 'disabled_for_paper_priority'; }
  startDepthQueues() {
    super.startDepthQueues();
    // Keep scanner queues available for diagnostics, but do not spend LBank's
    // public REST budget walking hundreds of baseline books during Paper.
    for (const queue of Object.values(this.queues)) queue.low.length = 0;
  }
  startStreams() {
    super.startStreams();
    // The scanner's all-market feeds are intentionally low-bandwidth. Paper
    // needs true sub-second leader updates to measure a one-second impulse.
    const binanceStreams = this.lbankBinance.map(symbol => `${symbol.toLowerCase()}@bookTicker`);
    for (let offset = 0; offset < binanceStreams.length; offset += 100) {
      const group = binanceStreams.slice(offset, offset + 100), socketNumber = offset / 100 + 1;
      this.openSocket(`binance-paper-live-${socketNumber}`, 'wss://fstream.binance.com/ws', {
        onOpen: socket => socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: group, id: 7000 + socketNumber })),
        onMessage: message => {
          const row = message.data || message;
          if (row?.s && row?.b && row?.a) this.updateQuote('binance', row.s, { bid: row.b, ask: row.a, bidQty: row.B, askQty: row.A, venueAt: row.E || row.T });
        },
      });
    }
    const mexcOnly = this.lbankMexc.filter(symbol => !this.markets.binance.has(symbol));
    for (let offset = 0; offset < mexcOnly.length; offset += 40) {
      const group = mexcOnly.slice(offset, offset + 40);
      this.openSocket(`mexc-paper-live-${offset / 40 + 1}`, 'wss://contract.mexc.com/edge', {
        heartbeat: '{"method":"ping"}',
        onOpen: socket => group.forEach((symbol, index) => setTimeout(() => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ method: 'sub.ticker', param: { symbol: symbol.replace(/USDT$/, '_USDT') } }));
        }, index * 25).unref?.()),
        onMessage: message => {
          const row = message?.data;
          if (message?.channel === 'push.ticker' && row?.symbol) this.updateQuote('mexc', row.symbol,
            { price: row.lastPrice, bid: row.bid1, ask: row.ask1, venueAt: message.ts });
        },
      });
    }
  }
  async captureDepth(venue, job) {
    await super.captureDepth(venue, job);
    if (venue === 'lbank') this.paper.onDepth(job.symbol, this.latestDepth.get(`lbank:${commonSymbol(job.symbol)}`)?.metrics, job);
  }
  snapshot(final = false) { return { ...super.snapshot(final), paper: this.paper.summary(final) }; }
  status() { super.status(); this.paper.checkpoint(); }
  async finish(reason = 'completed') {
    if (this.finalized) return;
    clearInterval(this.paperTimer); clearTimeout(this.paper.depthPumpTimer);
    this.paper.finish(); await super.finish(reason); this.paper.writeFinal(reason);
  }
}

async function main() {
  const seconds = Number(argument('duration-seconds', 0)), minutes = Number(argument('duration-minutes', 0)), hours = Number(argument('duration-hours', 1));
  const durationMs = seconds > 0 ? seconds * 1000 : minutes > 0 ? minutes * 60_000 : hours * 3_600_000;
  const outputDir = path.resolve(argument('output', path.join(ROOT, 'output', `lbank-paper-all-${stamp()}`)));
  const scanner = new PortfolioScanner({ durationMs, outputDir, movementBps: Number(argument('movement-bps', 3)), paper: {
    nominal: Number(argument('nominal', 50)), impulseBps: Number(argument('impulse-bps', 3)), cooldownMs: Number(argument('cooldown-seconds', 0)) * 1000,
    warmupMs: Number(argument('warmup-seconds', 30)) * 1000,
    makerFee: Number(argument('maker-fee', .00016)), takerFee: Number(argument('taker-fee', .0004)),
    marketImpulseMultiplier: Number(argument('market-impulse-multiplier', 1)),
    depthSafetyMultiplier: Number(argument('depth-safety-multiplier', 2)),
    maxEntrySpreadBps: Number(argument('max-entry-spread-bps', 5)),
    depthRequestsPerMinute: Number(argument('depth-requests-per-minute', 120)),
  } });
  let signal; for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { if (!signal) { signal = name; scanner.finish(name).finally(() => process.exit(0)); } });
  try {
    const report = await scanner.run();
    process.stdout.write(`${JSON.stringify({ ok: true, outputDir, universe: report.universe, paper: report.paper.totals })}\n`);
  } catch (error) {
    scanner.noteError('fatal', error); await scanner.finish('failed'); process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { PortfolioPaper, PortfolioScanner, inferTick };
