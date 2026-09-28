const test = require("node:test");
const assert = require("node:assert/strict");
const { allocation, marketImpact, buildPlan } = require("./hedge-plan.cjs");
const { commonStep, floorToStep, stepPrecision } = require("../exchanges/order-sizing.cjs");
const { venue } = require("./fixtures.cjs");
const config = { source: "a", target: "b", symbols: ["BTCUSDT", "ETHUSDT"], totalMargin: 100, leverageBySymbol: { BTCUSDT: 2, ETHUSDT: 10 } };

test("saved total margin is equal per coin; leverage changes notional, not margin", () => {
  assert.deepEqual(allocation(config), [{ symbol: "BTCUSDT", margin: 50, leverage: 2, notional: 100 }, { symbol: "ETHUSDT", margin: 50, leverage: 10, notional: 500 }]);
});
test("decimal common step and large integer ratios are exact", () => {
  assert.equal(commonStep(0.02, 0.03), 0.06); assert.equal(commonStep(1.5e-7, 1e-7), 3e-7);
  assert.equal(stepPrecision(1.5e-7), 8); assert.equal(floorToStep(60, 0.1), 60);
});
test("preflight agrees on both venue steps and performs no mutations", async () => {
  const a = venue("a"), b = venue("b");
  a.getTradingRules = async () => ({ quantityStep: 0.2, minQuantity: 0.2 });
  b.getTradingRules = async () => ({ quantityStep: 0.3, minQuantity: 0.3 });
  const plan = await buildPlan(config, a, b, () => 0);
  assert.equal(plan.legs[0].quantity, 9.6); assert.equal(plan.legs[0].quantityStep, 0.6);
  assert.equal(a.events.length + b.events.length, 0);
});
test("preflight blocks occupied symbols, insufficient balance and unsupported adapters", async () => {
  const a = venue("a"), b = venue("b");
  a.getPositions = async () => [{ exchange: "a", symbol: "BTCUSDT", quantity: 1 }];
  await assert.rejects(buildPlan(config, a, b), /уже есть позиция/);
  a.getPositions = async () => [];
  await assert.rejects(buildPlan({ ...config, totalMargin: 1000 }, a, b), /свободный резерв/);
  await assert.rejects(buildPlan(config, a, {}), /не реализован/);
  delete b.supportsNativeProtection;delete b.placeProtection;
  await assert.rejects(buildPlan(config,a,b),/нет подтверждаемого серверного TP\/SL/);
});
test('preflight reserves fee capital and rejects desynchronized venue prices',async()=>{
  const a=venue('a'),b=venue('b');
  await assert.rejects(buildPlan({...config,totalMargin:996},a,b),/свободный резерв/);
  a.getDepth=async()=>({bids:[{price:9.9,quantity:10000}],asks:[{price:9.91,quantity:10000}]});
  b.getDepth=async()=>({bids:[{price:10,quantity:10000}],asks:[{price:10.01,quantity:10000}]});
  await assert.rejects(buildPlan(config,a,b),/цены бирж расходятся/);
});
test("impact consumes actual base liquidity, includes spread and flags missing depth", () => {
  const book = { bids: [{ price: 99, quantity: 2 }], asks: [{ price: 101, quantity: 1 }, { price: 102, quantity: 1 }] };
  assert.equal(marketImpact(book, "BUY", 2).estimatedLoss, 3);
  assert.equal(marketImpact(book, "BUY", 3).insufficientDepth, true);
});

test('new preflight estimates target fallback liquidity and keeps source/target fee roles',async()=>{
  const a=venue('a'),b=venue('b'); a.supportsPostOnly=b.supportsPostOnly=true;
  a.getDepth=async()=>({bids:[{price:10,quantity:10000}],asks:[{price:10.002,quantity:10000}]});
  b.getDepth=async()=>({bids:[{price:10,quantity:1}],asks:[{price:12,quantity:1}]});
  await assert.rejects(buildPlan(config,a,b),/глубины/);
  b.getDepth=async()=>({bids:[{price:10,quantity:10000}],asks:[{price:12,quantity:10000}]});
  const plan=await buildPlan(config,a,b);
  assert.equal(plan.execution.targetPostOnly,true); assert.equal(plan.execution.makerWaitMs,1500);
  assert.equal(plan.legs[0].sourcePrice,10.002);
  assert.ok(plan.legs[0].impact.impactPercent>1);
  assert.ok(plan.legs[0].quantity*12<=plan.legs[0].notional);
});

test('immediate target rejects a source fill quantum that the target cannot hedge exactly',async()=>{
  const a=venue('a'),b=venue('b');b.preferImmediateHedge=true;
  a.getTradingRules=async()=>({quantityStep:.01,minQuantity:.01,minNotional:1,tickSize:.001});
  b.getTradingRules=async()=>({quantityStep:.1,minQuantity:.1,minNotional:1,tickSize:.001});
  await assert.rejects(buildPlan({...config,symbols:['BTCUSDT']},a,b),/минимальное частичное исполнение ИСХОДНОЙ/);
  assert.equal(a.placed.length+b.placed.length,0);
});
