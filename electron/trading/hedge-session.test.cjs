const test = require("node:test");
const assert = require("node:assert/strict");
const { HedgeSession, shuffle } = require("./hedge-session.cjs");
const { venue } = require("./fixtures.cjs");
const input = { source: "a", target: "b", symbols: ["BTCUSDT", "ETHUSDT"], totalMargin: 100, leverageBySymbol: { BTCUSDT: 2, ETHUSDT: 10 }, dryRun: false, liveConfirmation: "LIVE_TRADING_CONFIRMED" };

test('legacy manual stop does not await held preflight and late completion cannot start orders', {timeout:1000}, async()=>{
  const a=venue('a'),b=venue('b'),session=new HedgeSession({sourceAdapter:a,targetAdapter:b});
  let release;
  a.getAccount=()=>new Promise(resolve=>{release=()=>resolve({available:1000,total:1000});});
  session.start(input);
  const stopped=await session.stop('app-only');
  assert.equal(stopped.active,false);assert.equal(stopped.manualManagement,true);
  release();await session.runPromise;
  assert.equal(session.state.state,'stopped');assert.equal(session.state.active,false);
  assert.equal(a.events.length+b.events.length,0);assert.equal(a.placed.length+b.placed.length,0);
});
test("shuffle preserves input", () => { const input = ["BTC", "ETH"]; shuffle(input, () => 0); assert.deepEqual(input, ["BTC", "ETH"]); });

test("invalid profit target or stop mode cannot start exchange mutations", async () => {
  const a = venue("a"), b = venue("b"), session = new HedgeSession({ sourceAdapter: a, targetAdapter: b });
  for (const value of [0, -1, 101, "invalid", Infinity]) assert.throws(() => session.start({ ...input, hedgePercent: value }), /Цель PnL/);
  await assert.rejects(session.stop("invalid"), /способ остановки/);
  assert.equal(a.placed.length + b.placed.length, 0);
  assert.equal(session.state.state, "idle");
});
test("one pair per coin, same margin, different leverage; all leverage configured before first order", async () => {
  const events = []; const a = venue("a", { events }), b = venue("b", { events });
  const session = new HedgeSession({ sourceAdapter: a, targetAdapter: b, sleep: async () => {} });
  session.start(input); await session.runPromise; clearTimeout(session.monitorTimer);
  assert.equal(session.state.completedOrders, 2);
  assert.deepEqual(session.engines.map((e) => e.config.margin), [50, 50]);
  assert.equal(events.slice(0, 4).every((e) => e.includes(":leverage:")), true);
  assert.deepEqual(session.engines.map((e) => e.config.quantity).sort((a,b) => a-b), [10,50]);
  await session.stop("market");
});
test("leverage rejection sends no orders", async () => {
  const a = venue("a"), b = venue("b", { leverageError: "leverage rejected" });
  const session = new HedgeSession({ sourceAdapter: a, targetAdapter: b }); session.start(input); await session.runPromise;
  assert.equal(session.state.state, "error"); assert.equal(a.placed.length + b.placed.length, 0);
});
test("duplicate start is rejected", async () => {
  const session = new HedgeSession({ sourceAdapter: venue("a"), targetAdapter: venue("b") });
  session.start({ ...input, dryRun: true }); assert.throws(() => session.start(input), /текущий хедж/);
  await session.runPromise; await session.stop("app-only");
});
test("target profit uses filled entry margin and scoped positions, not account balance changes", async () => {
  const a = venue("a", { pnl: -49 }), b = venue("b", { pnl: 49 });
  const session = new HedgeSession({ sourceAdapter: a, targetAdapter: b });
  session.start(input); await session.runPromise; clearTimeout(session.monitorTimer);
  a.getAccount = async () => ({ total: 100000 }); b.getAccount = async () => ({ total: 999999 });
  await session.monitorOnce();
  assert.equal(session.state.state, "completed"); assert.equal(session.state.result.targetProfit, 98);
  assert.equal(session.state.result.tradingVolume, 2400);
});
test("PnL polling failure retains active monitoring and never reports completion", async () => {
  const a = venue("a"), b = venue("b");
  const session = new HedgeSession({ sourceAdapter: a, targetAdapter: b }); session.start(input); await session.runPromise; clearTimeout(session.monitorTimer);
  b.getPositions = async () => { throw new Error("network timeout"); };
  await session.monitorOnce(); assert.equal(session.state.active, true); assert.equal(session.state.state, "monitoring_stale");
  await session.stop("market");
});
test("stop during preflight prevents leverage changes and orders", async () => {
  let release; const a = venue("a"), b = venue("b");
  a.getAccount = () => new Promise((r) => { release = r; });
  const session = new HedgeSession({ sourceAdapter: a, targetAdapter: b }); session.start(input);
  const stop = session.stop("market"); release({ total: 1000, available: 1000 }); await stop;
  assert.equal(a.placed.length + b.placed.length, 0); assert.equal(a.events.length + b.events.length, 0);
});
