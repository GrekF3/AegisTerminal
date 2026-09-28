const test = require("node:test");
const assert = require("node:assert/strict");
const { HedgeEngine } = require("./hedge-engine.cjs");
const { venue, liveConfig } = require("./fixtures.cjs");
const { exchangeApiError } = require('../exchanges/exchange-errors.cjs');
const make = (a, b) => new HedgeEngine({ sourceAdapter: a, targetAdapter: b, sleep: async () => {}, now: (() => { let time = 0; return () => time += 10; })() });

test('close allocates exact journal exposure across distinct own position IDs and resumes without duplicating a child', async () => {
  const a=venue('a'),b=venue('b'),engine=make(a,b);await engine.start(liveConfig);
  let visible=false;
  b.getClosePlan=async(_c,request)=>{
    assert.equal(request.side,'SELL');
    return request.quantity===1?[{positionId:'own1',quantity:.4},{positionId:'own2',quantity:.6}]:[{positionId:'own2',quantity:request.quantity}];
  };
  const read=b.getOrder;
  b.getOrder=async(c,o)=>{
    if(o.reduceOnly&&o.positionId==='own1'&&!visible)throw Object.assign(new Error('pending'),{code:'ORDER_PENDING_HISTORY'});
    return read(c,o);
  };
  await assert.rejects(engine.stop('market'),/pending/);
  assert.deepEqual(b.placed.filter(o=>o.reduceOnly).map(o=>[o.positionId,o.quantity]),[['own1',.4]]);
  visible=true;await engine.stop('market');
  assert.equal(engine.state,'stopped');
  assert.deepEqual(b.placed.filter(o=>o.reduceOnly).map(o=>[o.positionId,o.quantity]),[['own1',.4],['own2',.6]]);
  assert.equal(a.placed.filter(o=>o.reduceOnly).length,1);
});

test('invalid close plan is rejected before any closing write', async () => {
  const a=venue('a'),b=venue('b'),engine=make(a,b);await engine.start(liveConfig);
  b.getClosePlan=async()=>[{positionId:'wrong',quantity:2}];
  await assert.rejects(engine.stop('market'),/План закрытия/);
  assert.equal(b.placed.filter(o=>o.reduceOnly).length,0);
});

test('a status outage does not prevent canceling a known limit ID but cannot authorize a replacement', async () => {
  const a=venue('a'),b=venue('b'),engine=make(a,b);await engine.start(liveConfig);
  const pending=await engine.submit('target','LIMIT',.1,'BUY');
  b.getOrder=async()=>{throw new Error('status offline');};
  await assert.rejects(engine.cancelAndRead(pending),/status offline/);
  assert.deepEqual(b.canceled,[pending.clientOrderId]);
  assert.equal(b.placed.length,2);assert.equal(pending.executedQuantity,0);
});

test('accepted market close waits for history indexing without submitting it twice',async()=>{
  const source=venue('a'),target=venue('b'),engine=make(source,target);
  await engine.start(liveConfig);
  const read=source.getOrder;let missing=0;
  source.getOrder=async(c,o)=>{
    if(o.reduceOnly&&missing++<6)throw Object.assign(new Error('History indexing'),{code:'ORDER_PENDING_HISTORY',retryAfterMs:500});
    return read(c,o);
  };
  await engine.stop('market');
  assert.equal(engine.state,'stopped');assert.equal(missing,7);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);
});

test('history wait is bounded and an absent order never becomes an invented fill',async()=>{
  const source=venue('a'),target=venue('b'),engine=make(source,target);
  await engine.start(liveConfig);let reads=0;
  source.getOrder=async()=>{reads++;throw Object.assign(new Error('Still indexing'),{code:'ORDER_PENDING_HISTORY'});};
  await assert.rejects(engine.stop('market'),/Still indexing/);
  assert.equal(engine.state,'stopped');assert.equal(engine.snapshot().active,false);assert.equal(engine.run.closeStatus,'waiting_confirmation');assert.ok(reads<=32);
  assert.equal(engine.run.closeOrders.find(o=>o.leg==='source').executedQuantity,0);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);
});

test('OKX 51169 closes idempotently only after a separate zero-position snapshot', async () => {
  const source = venue('bybit'), target = venue('okx'), engine = make(source, target);
  await engine.start({ ...liveConfig, source: 'bybit', target: 'okx' });
  const positions = target.getPositions; let reads = 0, closeWrites = 0;
  target.getPositions = async () => ++reads === 1 ? positions() : [];
  const place = target.placeOrder;
  target.placeOrder = async (credentials, order) => {
    if (order.reduceOnly) {
      closeWrites++;
      throw exchangeApiError('okx', 51169, "Order failed because you don't have any positions in this direction for this contract to reduce or close.");
    }
    return place(credentials, order);
  };
  const result = await engine.stop('market');
  assert.equal(result.closeStatus, 'closed');
  assert.equal(closeWrites, 1);
  const rejected = engine.run.closeOrders.find(order => order.exchangeCode === '51169' && order.status === 'REJECTED');
  const observed = engine.run.closeOrders.find(order => order.exchangeCode === '51169' && order.observedClosed);
  assert.ok(rejected); assert.ok(observed);
  assert.equal(observed.executedQuantity, 1);
  assert.equal(observed.provisionalPrice, true);
  assert.equal(source.placed.filter(order => order.reduceOnly).length, 1);
});

test('LBank 31 closes idempotently only after a separate zero-position snapshot', async () => {
  const source = venue('bybit'), target = venue('lbank'), engine = make(source, target);
  await engine.start({ ...liveConfig, source: 'bybit', target: 'lbank' });
  const positions = target.getPositions; let reads = 0, closeWrites = 0;
  target.getPositions = async () => ++reads === 1 ? positions() : [];
  const place = target.placeOrder;
  target.placeOrder = async (credentials, order) => {
    if (order.reduceOnly) {
      closeWrites++;
      throw exchangeApiError('lbank', 31, 'Close position failed, amount exceeds available amount for closing.');
    }
    return place(credentials, order);
  };
  const result = await engine.stop('market');
  assert.equal(result.closeStatus, 'closed');
  assert.equal(closeWrites, 1);
  assert.ok(engine.run.closeOrders.some(order => order.exchangeCode === '31' && order.status === 'REJECTED'));
  assert.ok(engine.run.closeOrders.some(order => order.exchangeCode === '31' && order.observedClosed));
  assert.equal(source.placed.filter(order => order.reduceOnly).length, 1);
});

test('a no-position rejection never becomes success while the position snapshot is nonzero', async () => {
  const source = venue('bybit'), target = venue('okx'), engine = make(source, target);
  await engine.start({ ...liveConfig, source: 'bybit', target: 'okx' });
  const place = target.placeOrder; let closeWrites = 0;
  target.placeOrder = async (credentials, order) => {
    if (order.reduceOnly) {
      closeWrites++;
      throw exchangeApiError('okx', 51169, 'no position in this direction');
    }
    return place(credentials, order);
  };
  await assert.rejects(engine.stop('market'), /снимок всё ещё показывает 1 BTCUSDT/);
  assert.equal(closeWrites, 1);
  assert.equal(engine.run.closeStatus, 'failed');
  assert.equal(source.placed.filter(order => order.reduceOnly).length, 0);
  assert.equal(engine.run.closeOrders.some(order => order.observedClosed), false);
});

test('app-only preserves pending closes without any exchange call, even when the venue is offline',async()=>{
  const source=venue('a'),target=venue('b'),engine=make(source,target);
  await engine.start(liveConfig);
  const pending=await engine.submit('source','MARKET',1,'BUY',true);
  assert.equal(pending.status,'NEW');
  const count=source.placed.length+target.placed.length;
  let calls = 0;
  for (const adapter of [source, target]) {
    for (const method of ['getOrder', 'cancelOrder', 'placeOrder', 'prepareOrder', 'getClosePlan']) {
      adapter[method] = async () => { calls++; throw new Error('Undetectable: подключите профиль'); };
    }
  }
  await engine.stop('app-only');
  assert.equal(engine.state,'stopped');assert.equal(pending.status,'NEW');
  assert.equal(engine.snapshot().active,false);assert.equal(engine.run.manualManagement,true);
  await engine.stop('market'); // A halted run cannot resume exchange management.
  assert.equal(calls,0);
  assert.equal(source.placed.length+target.placed.length,count);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,0);
});

test('Stop publishes the real closing venue and confirmation stage before reporting done',async()=>{
  const a=venue('a'),b=venue('b'),engine=make(a,b);
  await engine.start(liveConfig);
  const progress=[];engine.on('state',snapshot=>{if(snapshot.stopProgress)progress.push({...snapshot.stopProgress});});
  await engine.stop('market');
  assert.deepEqual(progress.filter(p=>p.phase==='closing').map(p=>p.leg).filter((v,i,a)=>i===0||a[i-1]!==v),['target','source']);
  for(const leg of ['target','source']) assert.ok(progress.some(p=>p.phase==='confirming'&&p.leg===leg&&p.orderId));
  assert.equal(progress.at(-1).phase,'done');assert.equal(engine.run.closeOrders.every(o=>o.status==='FILLED'),true);
});

test("dry run uses no exchange calls and remains explicitly simulated", async () => {
  const engine = make({}, {});
  const result = await engine.start({ ...liveConfig, dryRun: true });
  assert.equal(result.dryRun, true); assert.equal(result.hedgedQuantity, 1);
});
test("both legs must support place/status/cancel", async () => {
  await assert.rejects(make({}, venue("b")).start(liveConfig), /полного набора/);
});

test("FILLED with missing filled quantity is never reported as a successful hedge", async () => {
  const a = venue("a"), b = venue("b", { status: () => ({ status: "FILLED", executedQty: 0 }) });
  const engine = make(a, b);
  await assert.rejects(engine.start(liveConfig), /FILLED/);
  assert.equal(engine.snapshot().state, "emergency");
  assert.equal(a.placed.length, 0);
});
test("partial target fills are hedged incrementally and confirmed", async () => {
  const a = venue("a"), b = venue("b", { status: (o, n) => ({ status: n === 1 ? "PARTIALLY_FILLED" : "FILLED", executedQty: n === 1 ? 0.4 : 1 }) });
  const engine = make(a, b); const result = await engine.start(liveConfig);
  assert.deepEqual(a.placed.map((o) => o.quantity), [0.4, 0.6]); assert.equal(result.hedgedQuantity, 1);
  assert.ok([...a.orders.values()].every((o) => o.calls > 0));
});
test("source acceptance is not counted as a filled hedge", async () => {
  let release;
  const a = venue("a"), b = venue("b");
  const get = a.getOrder;
  a.getOrder = async (...args) => { await new Promise((r) => { release = r; }); return get(...args); };
  const engine = make(a, b); const start = engine.start(liveConfig);
  await new Promise((r) => setImmediate(r)); assert.equal(engine.snapshot().hedgedQuantity, 0);
  release(); await start; assert.equal(engine.snapshot().hedgedQuantity, 1);
});
test("definitive source rejection unwinds target only after confirming close", async () => {
  const a = venue("a", { reject: () => true }), b = venue("b"); const engine = make(a, b);
  await assert.rejects(engine.start(liveConfig), /source rejected/);
  assert.equal(engine.snapshot().state, "error");
  assert.equal(b.placed.at(-1).reduceOnly, true); assert.equal(b.placed.at(-1).side, "SELL");
  assert.equal(engine.snapshot().closeOrders[0].executedQuantity, 1);
});
test("unknown source outcome never sends duplicate or blind compensation", async () => {
  const a = venue("a", { unknown: () => true, unreadable: true }), b = venue("b"); const engine = make(a, b);
  await assert.rejects(engine.start(liveConfig), /неизвестен/);
  assert.equal(engine.snapshot().state, "emergency"); assert.equal(a.placed.length, 1); assert.equal(b.placed.length, 1);
  await assert.rejects(engine.stop("market")); assert.equal(a.placed.length, 1); assert.equal(b.placed.length, 1);
});
test("unknown placement can be reconciled by client ID without re-sending", async () => {
  const a = venue("a", { unknown: () => true }), b = venue("b"); const engine = make(a, b);
  assert.equal((await engine.start(liveConfig)).hedgedQuantity, 1); assert.equal(a.placed.length, 1);
});
test("simultaneous market stops close only owned quantity exactly once", async () => {
  const a = venue("a"), b = venue("b"), engine = make(a, b);
  await engine.start(liveConfig);
  const result = await Promise.all([engine.stop("market"), engine.stop("market")]);
  assert.ok(result.every((r) => r.state === "stopped"));
  assert.equal(a.placed.length, 2); assert.equal(b.placed.length, 2);
  assert.equal(a.placed.at(-1).side, "BUY"); assert.equal(b.placed.at(-1).side, "SELL");
});
test("cancel/fill race during stop closes actual target fill without opening source", async () => {
  let release; const a = venue("a");
  const b = venue("b", { status: (o) => ({ status: o.canceled || o.reduceOnly ? "FILLED" : "NEW", executedQty: o.canceled || o.reduceOnly ? 1 : 0 }) });
  const engine = new HedgeEngine({ sourceAdapter: a, targetAdapter: b, sleep: () => new Promise((r) => { release = r; }) });
  const start = engine.start(liveConfig); await new Promise((r) => setImmediate(r));
  const stopping = engine.stop("market"); release(); await start; await stopping;
  assert.equal(a.placed.length, 0); assert.equal(b.placed.at(-1).reduceOnly, true); assert.equal(b.placed.at(-1).quantity, 1);
});
test("app-only stops immediately while preserving the pending first leg for manual management", async () => {
  let release; const a = venue("a");
  const b = venue("b", { status: (o) => ({ status: o.canceled ? "CANCELED" : "NEW", executedQty: 0 }) });
  const engine = new HedgeEngine({ sourceAdapter: a, targetAdapter: b, sleep: () => new Promise((r) => { release = r; }) });
  const start = engine.start(liveConfig); await new Promise((r) => setImmediate(r));
  const stopped = await engine.stop("app-only");
  assert.equal(stopped.state,'stopped'); assert.equal(stopped.active,false);
  assert.equal(stopped.targetOrder.status,'NEW');
  release(); await start;
  assert.equal(b.canceled.length, 0); assert.equal(b.placed.length, 1); assert.equal(a.placed.length, 0);
});

test("stop during asynchronous order preparation prevents any new opening order", async () => {
  const a = venue("a"), b = venue("b");
  let release;
  b.prepareOrder = (order) => new Promise((resolve) => { release = () => resolve(order); });
  const engine = make(a, b);
  const starting = engine.start(liveConfig);
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = engine.stop("market");
  release();
  assert.equal((await starting).active, false);
  assert.equal((await stopping).state, "stopped");
  assert.equal(a.placed.length, 0);
  assert.equal(b.placed.length, 0);
  assert.equal(engine.orders().length, 0);
});

const held = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function stopImmediately(engine) {
  const result = await Promise.race([engine.stop('app-only'), nextTurn().then(() => 'blocked')]);
  assert.notEqual(result, 'blocked', 'local Stop must not await a pending exchange request');
  assert.equal(result.state, 'stopped'); assert.equal(result.active, false);
  assert.equal(result.manualStop, true); assert.equal(result.stopMode, 'app-only');
  return result;
}

test('local stop during entry preparation returns before the request and blocks dispatch after it resolves', async () => {
  const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
  b.prepareOrder = async order => { await gate.promise; return order; };
  const starting = engine.start(liveConfig); await nextTurn();
  await stopImmediately(engine);
  gate.resolve(); await starting;
  assert.equal(engine.state, 'stopped'); assert.equal(engine.orders().length, 0);
  assert.equal(a.placed.length + b.placed.length, 0);
});

for (const outcome of ['acknowledged', 'unknown']) {
  test(`local stop saves a late ${outcome} placement without status requests or further trading`, async () => {
    const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
    const place = b.placeOrder; let reads = 0;
    b.placeOrder = async (...args) => { const receipt = await place(...args); await gate.promise; return receipt; };
    b.getOrder = async () => { reads++; throw new Error('must not read'); };
    const starting = engine.start(liveConfig); await nextTurn();
    assert.equal(b.placed.length, 1); assert.equal(engine.run.targetOrder.status, 'UNKNOWN');
    await stopImmediately(engine);
    if (outcome === 'acknowledged') gate.resolve(); else gate.reject(new Error('network timeout'));
    const result = await starting;
    assert.equal(result.state, 'stopped'); assert.equal(result.error, undefined);
    assert.equal(result.targetOrder.status, outcome === 'acknowledged' ? 'NEW' : 'UNKNOWN');
    if (outcome === 'acknowledged') assert.equal(result.targetOrder.orderId, '1');
    assert.equal(result.targetOrder.executedQuantity, 0);
    assert.equal(reads, 0); assert.equal(a.placed.length, 0); assert.equal(b.canceled.length, 0);
  });
}

for (const outcome of ['filled', 'pending-history']) {
  test(`local stop during a ${outcome} status request preserves the reply and prevents retries or hedging`, async () => {
    const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
    let reads = 0;
    b.getOrder = async () => { reads++; return gate.promise; };
    const starting = engine.start(liveConfig); await nextTurn();
    assert.equal(reads, 1);
    await stopImmediately(engine);
    if (outcome === 'filled') gate.resolve({ status: 'FILLED', executedQty: 1, orderId: '1' });
    else gate.reject(Object.assign(new Error('history indexing'), { code: 'ORDER_PENDING_HISTORY', orderId: '1' }));
    const result = await starting;
    assert.equal(result.state, 'stopped'); assert.equal(result.error, undefined);
    assert.equal(result.targetOrder.executedQuantity, outcome === 'filled' ? 1 : 0);
    assert.equal(result.targetOrder.status, outcome === 'filled' ? 'FILLED' : 'NEW');
    assert.equal(reads, 1); assert.equal(a.placed.length, 0); assert.equal(b.canceled.length, 0);
  });
}

for (const stage of ['close-plan', 'close-preparation']) {
  test(`local stop overrides a market stop waiting for ${stage} and blocks all reduce-only writes`, async () => {
    const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
    await engine.start(liveConfig); let requests = 0;
    if (stage === 'close-plan') b.getClosePlan = async () => { requests++; await gate.promise; return [{ positionId: 'own', quantity: 1 }]; };
    else b.prepareOrder = async order => { requests++; await gate.promise; return order; };
    const marketStop = engine.stop('market'); await nextTurn();
    assert.equal(requests, 1);
    await stopImmediately(engine);
    gate.resolve(); assert.equal((await marketStop).state, 'stopped');
    assert.equal(engine.run.stopMode, 'app-only'); assert.equal(engine.run.closeOrders.length, 0);
    assert.equal(a.placed.length + b.placed.length, 2);
    assert.equal(engine.run.error, undefined);
  });
}

test('local stop during ID reconciliation prevents the subsequent cancel', async () => {
  const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
  await engine.start(liveConfig);
  const pending = await engine.submit('target', 'LIMIT', .1, 'BUY'); delete pending.orderId;
  let reads = 0;
  b.getOrder = async () => { reads++; return gate.promise; };
  const marketStop = engine.stop('market'); await nextTurn();
  assert.equal(reads, 1); await stopImmediately(engine);
  gate.resolve({ status: 'NEW', executedQty: 0, orderId: '2' }); await marketStop;
  assert.equal(pending.orderId, '2'); assert.equal(pending.status, 'NEW');
  assert.equal(b.canceled.length, 0); assert.equal(reads, 1); assert.equal(engine.run.closeOrders.length, 0);
});

test('local stop during an in-flight cancel does not poll status or claim cancellation', async () => {
  const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
  await engine.start(liveConfig);
  const pending = await engine.submit('target', 'LIMIT', .1, 'BUY');
  let cancels = 0, reads = 0;
  b.cancelOrder = async () => { cancels++; await gate.promise; };
  b.getOrder = async () => { reads++; throw new Error('must not read'); };
  const marketStop = engine.stop('market'); await nextTurn();
  assert.equal(cancels, 1); await stopImmediately(engine);
  gate.resolve(); await marketStop;
  assert.equal(cancels, 1); assert.equal(reads, 0); assert.equal(pending.status, 'NEW');
  assert.equal(engine.run.closeOrders.length, 0);
});

test('an in-flight close acknowledgement is journaled after local stop without closing the other leg', async () => {
  const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
  await engine.start(liveConfig);
  const place = b.placeOrder; let reads = 0;
  b.placeOrder = async (...args) => { const receipt = await place(...args); await gate.promise; return receipt; };
  b.getOrder = async () => { reads++; throw new Error('must not read'); };
  const marketStop = engine.stop('market'); await nextTurn();
  assert.equal(engine.run.closeOrders.length, 1); await stopImmediately(engine);
  gate.resolve(); await marketStop;
  assert.equal(engine.run.closeOrders[0].orderId, '2');
  assert.equal(engine.run.closeOrders[0].status, 'NEW');
  assert.equal(engine.run.closeOrders[0].executedQuantity, 0);
  assert.equal(a.placed.length, 1); assert.equal(b.placed.length, 2); assert.equal(reads, 0);
  assert.equal(engine.run.stopMode, 'app-only'); assert.equal(engine.run.error, undefined);
});

test('a late market close plan error cannot overwrite local stopped state', async () => {
  const a = venue('a'), b = venue('b'), engine = make(a, b), gate = held();
  await engine.start(liveConfig);
  b.getClosePlan = async () => gate.promise;
  const marketStop = engine.stop('market'); await nextTurn(); await stopImmediately(engine);
  gate.reject(new Error('Undetectable: подключите профиль'));
  const result = await marketStop;
  assert.equal(result.state, 'stopped'); assert.equal(result.error, undefined);
  assert.equal(result.stopMode, 'app-only'); assert.equal(result.stopProgress.phase, 'done');
  assert.equal(engine.run.closeOrders.length, 0);
});
