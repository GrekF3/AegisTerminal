const test = require("node:test");
const assert = require("node:assert/strict");
const { FeeRateCache, finiteRate, prioritizedSymbols, applyStrategyFees } = require("./fee-rates.cjs");
const okx = require("./okx.cjs");

test("fee normalization preserves zero and rebates while rejecting unknown values", () => {
  assert.equal(finiteRate(0), 0);
  assert.equal(finiteRate("-0.0001"), -0.0001);
  assert.equal(finiteRate(undefined), null);
  assert.equal(okx.normalizeFeeCost("-0.0005"), 0.0005);
  assert.equal(okx.normalizeFeeCost("0.0001"), -0.0001);
});

test("strategy fees use source maker and target market fallback, not the old reversed route", () => {
  const markets = [{ symbol: "BTCUSDT", combinedTurnover: 1 }];
  const source = { BTCUSDT: { makerFee: 0.9, takerFee: 0.0006, source: "account" } };
  const target = { BTCUSDT: { makerFee: 0.0002, takerFee: 0.8, source: "account" } };
  assert.deepEqual(applyStrategyFees(markets, source, target)[0], {
    symbol: "BTCUSDT", combinedTurnover: 1,
    makerFee: 0.9, takerFee: 0.8,
    makerFeeSource: "account", takerFeeSource: "account",
  });
});

test("unknown fee remains null instead of becoming zero", () => {
  const [market] = applyStrategyFees([{ symbol: "UNKNOWNUSDT" }], {}, {});
  assert.equal(market.makerFee, null);
  assert.equal(market.takerFee, null);
});

test("priority list starts with BTC and top altcoins available on both exchanges", () => {
  const symbols = prioritizedSymbols([
    { symbol: "MEMEUSDT", combinedTurnover: 999 },
    { symbol: "SOLUSDT", combinedTurnover: 1 },
    { symbol: "BTCUSDT", combinedTurnover: 2 },
    { symbol: "ETHUSDT", combinedTurnover: 3 },
  ]);
  assert.deepEqual(symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT", "MEMEUSDT"]);
});

test("fee cache deduplicates concurrent and repeated account requests", async () => {
  let calls = 0;
  const adapter = { getFeeRates: async () => { calls += 1; return { default: { makerFee: 0, takerFee: 0.001 } }; } };
  const cache = new FeeRateCache({ ttlMs: 1000, now: () => 100 });
  const [first, second] = await Promise.all([
    cache.get("test", adapter, { apiKey: "key" }, ["BTCUSDT"], []),
    cache.get("test", adapter, { apiKey: "key" }, ["BTCUSDT"], []),
  ]);
  const third = await cache.get("test", adapter, { apiKey: "key" }, ["BTCUSDT"], []);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(second, third);
});
