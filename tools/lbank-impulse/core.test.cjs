const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TimeEwmaBasis, ReversalTracker, PullbackExitTracker, ReentryGate, automaticPositionBudget, bookMetrics, conservativePaperFill, feeAwareEdge, insideSpreadPrice,
  marketEntryEstimate, marketExitEstimate, planEntryExecution, quantityForNotional, rollingReturnBps, signalSide,
} = require('./core.cjs');

const book = { bids: [{ price: 99.98, quantity: 2 }, { price: 99.9, quantity: 10 }], asks: [{ price: 100.02, quantity: 3 }, { price: 100.1, quantity: 10 }], receivedAt: 1000 };

test('one-second impulse uses an actual one-second observation span', () => {
  const rows = [{ at: 0, price: 100 }, { at: 500, price: 100.01 }, { at: 1000, price: 100.04 }];
  assert.ok(Math.abs(rollingReturnBps(rows, 1000) - 4) < 1e-8);
  assert.equal(signalSide(3.999), null); assert.equal(signalSide(4), 'BUY'); assert.equal(signalSide(-4.1), 'SELL');
  assert.equal(rollingReturnBps([{ at: 500, price: 100 }, { at: 1000, price: 101 }], 1000), null);
});

test('time EWMA basis warms up and predicts LBank fair value without future samples', () => {
  const basis = new TimeEwmaBasis({ halfLifeMs: 1000, warmupMs: 2000 });
  basis.update(100, 99, 0); basis.update(102, 100.98, 1000);
  assert.equal(basis.ready(1999), false); assert.equal(basis.ready(2000), true);
  assert.ok(Math.abs(basis.expected(200) - 198) < 1e-8);
  const prior = basis.value; basis.update(300, 400, 500); assert.equal(basis.value, prior);
});

test('maker price improves one tick but never crosses the opposite quote', () => {
  assert.equal(insideSpreadPrice(book, 'BUY', .01), 99.99);
  assert.equal(insideSpreadPrice(book, 'SELL', .01), 100.01);
  const oneTick = { bids: [[100, 2]], asks: [[100.01, 2]] };
  assert.equal(insideSpreadPrice(oneTick, 'BUY', .01), 100);
  assert.equal(insideSpreadPrice(oneTick, 'SELL', .01), 100.01);
});

test('quantity and exit impact respect contract step and available depth', () => {
  assert.equal(quantityForNotional(100, 99.99, { quantityStep: .01, minQuantity: .01, minNotional: 5, maxQuantity: 100 }), 1);
  assert.throws(() => quantityForNotional(1, 100, { quantityStep: .1, minQuantity: .1, minNotional: 5 }), /мал|миним/);
  const exit = marketExitEstimate(book, 'BUY', 5);
  assert.equal(exit.enough, true); assert.ok(exit.impactBps > 0);
  assert.equal(marketExitEstimate(book, 'SELL', 20).enough, false);
  assert.equal(bookMetrics(book, 100).bidDepthUsd >= 100, true);
});

test('automatic position is capped by planned loss including both taker fees and stop buffer', () => {
  const rules = { tickSize: .01, quantityStep: .01, minQuantity: .01, minNotional: 5, maxQuantity: 1000, maxLeverage: 50 };
  const budget = automaticPositionBudget({ available: 200, price: 100, rules, maxLossPercent: 1,
    hardStopBps: 24, entryFeeRate: .0004, exitFeeRate: .0004, riskBufferBps: 10 });
  assert.equal(budget.leverage, 50); assert.equal(budget.riskBudget, 2); assert.equal(budget.plannedLossBps, 42);
  assert.equal(budget.limitingFactor, 'risk'); assert.ok(budget.nominal <= 2 / .0042); assert.ok(budget.plannedLoss <= 2);
  assert.ok(budget.margin < 10);
  const thin = { bids: [[99.98, 20]], asks: [[100.02, 1.5], [100.03, 20]] };
  const plan = planEntryExecution({ book: thin, side: 'BUY', notional: budget.nominal, rules, expectedFair: 101,
    impulseBps: 8, thresholdBps: 4, maxSlippageBps: 0, depthSafetyMultiplier: 2, allowSizeToDepth: true });
  assert.equal(plan.sizedDown, true); assert.equal(plan.canExecute, true); assert.ok(plan.quantity <= .75); assert.ok(plan.allocatedNotional < budget.nominal);
});

test('entry execution uses a price-capped aggressive LIMIT only with sufficient visible depth', () => {
  const rules = { quantityStep: .01, minQuantity: .01, minNotional: 5, maxQuantity: 100 };
  const deep = { bids: [[99.98, 20], [99.97, 20]], asks: [[100.02, 20], [100.03, 20]] };
  const aggressive = planEntryExecution({ book: deep, side: 'BUY', notional: 100, rules: { ...rules, tickSize: .01 }, expectedFair: 100.2,
    impulseBps: 8, thresholdBps: 4, maxSlippageBps: 0, marketImpulseMultiplier: 2, depthSafetyMultiplier: 2 });
  assert.equal(aggressive.type, 'LIMIT'); assert.equal(aggressive.postOnly, false); assert.equal(aggressive.price, 100.02);
  assert.equal(aggressive.quantity, .99); assert.equal(aggressive.estimatedImpactBps, 0); assert.equal(aggressive.canExecute, true);
  assert.ok(aggressive.depthCoverage >= 2); assert.equal(aggressive.routeReason, 'aggressive_limit_ready');

  const quiet = planEntryExecution({ book: deep, side: 'BUY', notional: 100, rules: { ...rules, tickSize: .01 }, expectedFair: 100.2,
    impulseBps: 7.99, thresholdBps: 4, maxSlippageBps: 0, marketImpulseMultiplier: 2, depthSafetyMultiplier: 2 });
  assert.equal(quiet.type, 'LIMIT'); assert.equal(quiet.postOnly, false); assert.equal(quiet.canExecute, true);

  const thin = { bids: [[99.98, 20]], asks: [[100.02, 1.5], [100.03, 20]] };
  const guarded = planEntryExecution({ book: thin, side: 'BUY', notional: 100, rules: { ...rules, tickSize: .01 }, expectedFair: 100.2,
    impulseBps: 8, thresholdBps: 4, maxSlippageBps: 0, marketImpulseMultiplier: 2, depthSafetyMultiplier: 2 });
  assert.equal(guarded.type, 'LIMIT'); assert.equal(guarded.postOnly, false); assert.equal(guarded.canExecute, false);
  assert.equal(guarded.routeReason, 'aggressive_limit_depth_reserve');
  assert.equal(marketEntryEstimate(thin, 'BUY', 2, 0).impactBps > 0, true);
});

test('fee-aware edge requires both fees, executable depth and extra two bps', () => {
  const value = feeAwareEdge({ side: 'BUY', expectedFair: 100.2, entryPrice: 100, makerFee: .0002, takerFee: .0006, exitImpactBps: 1, extraEdgeBps: 2 });
  assert.ok(Math.abs(value.grossBps - 20) < 1e-8); assert.equal(value.costBps, 9); assert.ok(Math.abs(value.netEdgeBps - 11) < 1e-8); assert.equal(value.eligible, true);
  assert.equal(feeAwareEdge({ side: 'SELL', expectedFair: 99.9, entryPrice: 100, makerFee: .0002, takerFee: .0006, exitImpactBps: 1, extraEdgeBps: 2 }).eligible, false);
});

test('Paper fill ignores a touch and consumes only volume one tick through', () => {
  const order = { side: 'BUY', price: 100, quantity: 2, executedQty: 0 };
  assert.equal(conservativePaperFill({ bids: [[99.9, 10]], asks: [[100, 10]] }, order, .1).fill, 0);
  assert.equal(conservativePaperFill({ bids: [[99.8, 10]], asks: [[99.9, .75], [100, 10]] }, order, .1).fill, .75);
  assert.equal(conservativePaperFill({ bids: [[99.8, 10]], asks: [[99.9, 3]] }, order, .1).fill, 2);
});

test('trailing exit requires favorable activation, minimum hold and confirmed retrace', () => {
  const tracker = new ReversalTracker({ side: 'BUY', leaderEntry: 100, openedAt: 0, minimumHoldMs: 1000,
    trailingActivationBps: 6, reversalBps: 3, reversalHoldMs: 300, adverseBps: 15, maxHoldMs: 15000 });
  assert.equal(tracker.observe(99.96, 500), null, 'adverse noise must not be mislabeled as a reversal');
  assert.equal(tracker.metrics(99.96, 500).trailingArmed, false);
  assert.equal(tracker.observe(100.08, 700), null, 'a favorable move arms trailing but minimum hold remains active');
  assert.equal(tracker.metrics(100.08, 700).trailingArmed, true);
  assert.equal(tracker.observe(100.045, 900), null);
  assert.equal(tracker.observe(100.045, 1000), null);
  assert.equal(tracker.observe(100.045, 1300), 'reversal');
});

test('hard stop, timeout and cooldown remain deterministic', () => {
  assert.equal(new ReversalTracker({ side: 'SELL', leaderEntry: 100, openedAt: 0 }).observe(100.16, 100), 'hard_stop');
  assert.equal(new ReversalTracker({ side: 'BUY', leaderEntry: 100, openedAt: 0, maxHoldMs: 15000 }).observe(100, 15000), 'max_hold');
  const gate = new ReentryGate(180000); gate.closed(1000); assert.equal(gate.canEnter(181000), false); gate.observeSignal(false); assert.equal(gate.canEnter(180999), false); assert.equal(gate.canEnter(181000), true);
});

test('ZEC pullback model holds an active lag, trails only after fade, and defers the soft stop', () => {
  const tracker = new PullbackExitTracker({ side: 'BUY', leaderEntry: 100, lbankEntry: 99, openedAt: 0,
    signalThresholdBps: 4, minimumHoldMs: 2000, trailBps: 2, emergencyBps: 3, maxHoldMs: 60000 });
  assert.equal(tracker.observe({ leaderPrice: 100.1, lbankPrice: 98.95, lagBps: 8 }, 2500), null, 'strong lag must keep running');
  assert.equal(tracker.metrics({ leaderPrice: 100.1, lbankPrice: 98.95, lagBps: 8 }, 2500).adverseBps > 3, true);
  assert.equal(tracker.observe({ leaderPrice: 100.07, lbankPrice: 98.95, lagBps: 2 }, 2600), 'trailing_pullback');
  const hard = new PullbackExitTracker({ side: 'SELL', leaderEntry: 100, lbankEntry: 100, openedAt: 0,
    signalThresholdBps: 4, minimumHoldMs: 2000, trailBps: 2, emergencyBps: 3 });
  assert.equal(hard.observe({ leaderPrice: 99.9, lbankPrice: 100.1, lagBps: -8 }, 100), 'hard_stop', '0.09% hard boundary is unconditional');
});
