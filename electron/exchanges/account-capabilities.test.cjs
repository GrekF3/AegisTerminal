const test = require("node:test");
const assert = require("node:assert/strict");
const { installAccountCapabilities, finite } = require("./account-capabilities.cjs");

test("unknown numeric account fields stay unknown, not fake zeros", () => {
  for (const value of [null, undefined, "", "bad"]) assert.equal(finite(value), null);
  assert.equal(finite("0"), 0);
});
test("OKX position quantities convert from contracts into base and retain hedge sides", async () => {
  const adapter = { getContractSpec: async () => ({ contractSize: 0.01, lotSize: 0.1, minContracts: 0.1 }), getDepth: async () => ({ bids: [], asks: [] }), request: async () => ({ data: [{ instId: "ETH-USDT-SWAP", pos: "3", posSide: "short", avgPx: "3000", markPx: "3010", upl: "-0.3", lever: "5", liqPx: "", mgnMode: "cross", imr: "18" }] }) };
  installAccountCapabilities("okx", adapter);
  const [position] = await adapter.getPositions({});
  assert.equal(position.quantity, .03); assert.equal(position.side, "short"); assert.equal(position.unrealizedPnl, -.3); assert.equal(position.liquidationPrice, null);
  assert.equal((await adapter.getTradingRules("ETHUSDT", {})).quantityStep, .001);
});
test("Bybit positions paginate without losing second page", async () => {
  const requests = [];
  const adapter = { privateRequest: async (_method, _path, _c, query) => { requests.push(query); return { result: { list: [{ symbol: query.cursor ? "ETHUSDT" : "BTCUSDT", size: "1", side: "Buy", unrealisedPnl: "0" }], nextPageCursor: query.cursor ? "" : "page2" } }; } };
  installAccountCapabilities("bybit", adapter);
  assert.equal((await adapter.getPositions({})).length, 2); assert.equal(requests[1].cursor, "page2");
});
test("Gate positions and order book use the same base-asset multiplier", async () => {
  const adapter = { getContractSpec: async () => ({ contractSize: .001, minContracts: 1 }), getDepth: async () => ({ bids: [{ price: 100, quantity: 100 }], asks: [] }), request: async () => [{ contract: "BTC_USDT", size: "-5", unrealised_pnl: "-2", entry_price: "65000", leverage: "0", cross_leverage_limit: "10" }] };
  installAccountCapabilities("gateio", adapter);
  const [position] = await adapter.getPositions({});
  assert.equal(position.quantity, .005); assert.equal(position.side, "short"); assert.equal(position.leverage, 10);
  assert.equal((await adapter.getDepth("BTCUSDT", 5, {})).bids[0].quantity, .1);
});
test("leverage writes always require explicit live authorization", async () => {
  for (const id of ["binance", "okx", "bybit", "gateio", "bitget", "mexc"]) {
    const adapter = {}; installAccountCapabilities(id, adapter);
    await assert.rejects(adapter.configureLeverage({}, { symbol: "BTCUSDT", side: "BUY", leverage: 5 }), /подтверждения/);
  }
});

test("Gate requests all held positions without an invalid or truncating limit", async () => {
  const adapter = { getDepth: async () => ({}), getContractSpec: async () => ({ contractSize: 1 }), request: async (method, route, _credentials, query) => {
    assert.equal(method, "GET"); assert.equal(route, "/futures/usdt/positions");
    assert.deepEqual(query, { holding: "true" });
    return Array.from({ length: 101 }, (_, i) => ({ contract: `COIN${i}_USDT`, size: "1" }));
  } };
  installAccountCapabilities("gateio", adapter);
  assert.equal((await adapter.getPositions({})).length, 101);
});
