const test = require("node:test");
const assert = require("node:assert/strict");
const { credentialFingerprint, recoverSession } = require("./session-recovery.cjs");
const { HedgeSession } = require("./hedge-session.cjs");
const { venue } = require("./fixtures.cjs");

test("journal identity includes signing secrets, ignores object key order and unrelated exchanges", () => {
  const first = { a: { apiKey: "test-key", secret: "test-secret" }, b: { passphrase: "test-passphrase" } };
  const second = { b: { passphrase: "test-passphrase" }, a: { secret: "test-secret", apiKey: "test-key" }, c: { apiKey: "unrelated" } };
  assert.equal(credentialFingerprint(first, "a", "b"), credentialFingerprint(second, "a", "b"));
  second.a.secret = "changed-secret";
  assert.notEqual(credentialFingerprint(first, "a", "b"), credentialFingerprint(second, "a", "b"));
});

test("restored hedge sends no new opening orders and checkpoints every close before submission", async () => {
  const a = venue("a"), b = venue("b"), credentials = { a: { apiKey: "test-a" }, b: { apiKey: "test-b" } };
  const original = new HedgeSession({ sourceAdapter: a, targetAdapter: b });
  original.start({ source: "a", target: "b", symbols: ["BTCUSDT"], totalMargin: 100, leverageBySymbol: { BTCUSDT: 2 }, dryRun: false, liveConfirmation: "LIVE_TRADING_CONFIRMED" });
  await original.runPromise; clearTimeout(original.monitorTimer);
  const journal = JSON.parse(JSON.stringify({ snapshot: original.state, fingerprint: credentialFingerprint(credentials, "a", "b") }));
  const count = a.placed.length + b.placed.length;
  const recovered = recoverSession(journal, credentials, (id) => id === "a" ? a : b);
  assert.equal(recovered.state.state, "recovery_required");
  assert.equal(a.placed.length + b.placed.length, count);
  assert.throws(() => recovered.start({}), /текущий хедж/);
  const persistedIntents = new Set();
  recovered.on("state", (value) => value.runs.forEach((run) => run.closeOrders.forEach((order) => persistedIntents.add(order.clientOrderId))));
  for (const adapter of [a, b]) {
    const place = adapter.placeOrder;
    adapter.placeOrder = async (credentials, order, options) => {
      assert.equal(order.reduceOnly, true);
      assert.equal(persistedIntents.has(order.clientOrderId), true, "Persist intent before sending recovery close");
      return place(credentials, order, options);
    };
  }
  await recovered.stop("market");
  assert.equal(recovered.state.state, "stopped");
  assert.equal(persistedIntents.size, 2);
  assert.equal(a.placed.length + b.placed.length, count + 2);
  await recovered.stop("market");
  assert.equal(a.placed.length + b.placed.length, count + 2);
});

test("incomplete journal with another account is blocked before any exchange access", () => {
  const credentials = { a: { apiKey: "a" }, b: { apiKey: "b" } };
  const journal = { fingerprint: credentialFingerprint(credentials, "a", "b"), snapshot: { active: true, source: "a", target: "b", runs: [] } };
  credentials.a.apiKey = "different";
  assert.throws(() => recoverSession(journal, credentials, () => { throw new Error("Must not access exchange"); }), /другими API-ключами/);
  assert.equal(recoverSession({ snapshot: { active: false } }, {}, () => {}), null);
});

test('a protected continuous session verifies both exchange OCOs and resumes monitoring after restart',async()=>{
  const a=venue('a'),b=venue('b'),credentials={a:{apiKey:'a'},b:{apiKey:'b'}};
  const protections=[
    {leg:'source',symbol:'BTCUSDT',quantity:1,side:'SELL',clientOrderId:'pa',orderId:'1',takeProfitPrice:9,stopLossPrice:11,status:'ACTIVE',placementAttemptedAt:1},
    {leg:'target',symbol:'BTCUSDT',quantity:1,side:'BUY',clientOrderId:'pb',orderId:'2',takeProfitPrice:11,stopLossPrice:9,status:'ACTIVE',placementAttemptedAt:1},
  ];
  a.protections.set('pa',{...protections[0]});b.protections.set('pb',{...protections[1]});
  const run={id:'run',symbol:'BTCUSDT',state:'running',active:true,dryRun:false,quantity:1,hedgedQuantity:1,margin:10,leverage:1,marginMode:'isolated',
    source:'a',target:'b',sourceSide:'SELL',targetSide:'BUY',protectionMoveRatio:.1,serverProtected:true,protections,
    sourceOrders:[{leg:'source',symbol:'BTCUSDT',quantity:1,executedQuantity:1,averagePrice:10,side:'SELL',type:'LIMIT',status:'FILLED'}],
    targetOrders:[{leg:'target',symbol:'BTCUSDT',quantity:1,executedQuantity:1,averagePrice:10,side:'BUY',type:'MARKET',status:'FILLED'}],closeOrders:[]};
  const snapshot={id:'session',strategy:'continuous-intraday',source:'a',target:'b',symbols:['BTCUSDT'],totalMargin:10,hedgePercent:50,maxLosses:5,
    state:'monitoring',active:true,requiresAttention:false,runs:[run]};
  const recovered=recoverSession({snapshot,fingerprint:credentialFingerprint(credentials,'a','b')},credentials,id=>id==='a'?a:b);
  clearTimeout(recovered.monitorTimer);
  assert.equal(recovered.state.state,'recovering_protection');assert.equal(recovered.blockEntries,true);
  await recovered.tick();clearTimeout(recovered.monitorTimer);
  assert.equal(recovered.state.state,'monitoring');assert.equal(recovered.state.requiresAttention,false);assert.equal(recovered.blockEntries,false);
  assert.equal(a.placed.length+b.placed.length,0,'restart verification must not create an opening order');
  await recovered.stop('app-only');clearTimeout(recovered.monitorTimer);
});

test('restart preserves stopped automation while an unknown order still requires closure confirmation', async () => {
  const credentials={a:{apiKey:'a'},b:{apiKey:'b'}};let calls=0;
  const adapter=new Proxy({}, {get:(_target,method)=>async()=>{calls++;throw new Error('LBank receipt unknown');}});
  const order={leg:'source',symbol:'BTCUSDT',clientOrderId:'accepted-intent',quantity:1,executedQuantity:0,side:'SELL',type:'LIMIT',status:'UNKNOWN'};
  const snapshot={id:'stopped-run',strategy:'continuous-intraday',source:'a',target:'b',state:'stopped',active:false,botStopped:true,requiresAttention:true,closeStatus:'closing',appStoppedAt:123,
    runs:[{id:'r',symbol:'BTCUSDT',state:'stopping',quantity:1,sourceSide:'SELL',targetSide:'BUY',sourceOrders:[order],targetOrders:[],closeOrders:[]}]};
  const recovered=recoverSession({fingerprint:credentialFingerprint(credentials,'a','b'),snapshot},credentials,()=>adapter);
  assert.equal(calls,0);assert.equal(recovered.state.active,false);assert.equal(recovered.state.state,'stopped');
  assert.equal(recovered.state.botStopped,true);assert.equal(recovered.state.closeStatus,'failed');
  assert.equal(recovered.state.error,undefined);assert.equal(recovered.stopRequested,true);
  assert.equal(recovered.state.runs[0].active,false);assert.equal(recovered.state.runs[0].state,'stopped');
  assert.equal(recovered.engines[0].snapshot().active,false);
  assert.equal(recovered.engines[0].orders()[0].status,'UNKNOWN');
  await recovered.tick();assert.equal(calls,0,'restoration must not start cleanup or trading by itself');
  await recovered.stop('pause');assert.equal(calls,0,'ordinary Stop stays local even after restart');
});

test('explicit cleanup after stopped restart closes only original exposure and never starts entries', async () => {
  const a=venue('a'),b=venue('b'),credentials={a:{apiKey:'a'},b:{apiKey:'b'}};
  const original=new HedgeSession({sourceAdapter:a,targetAdapter:b});
  original.start({source:'a',target:'b',symbols:['BTCUSDT'],totalMargin:10,leverageBySymbol:{BTCUSDT:1},dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  await original.runPromise;clearTimeout(original.monitorTimer);
  const snapshot=JSON.parse(JSON.stringify(original.state));
  Object.assign(snapshot,{botStopped:true,active:false,state:'stopped',requiresAttention:true,closeStatus:'not_requested'});
  const recovered=recoverSession({snapshot,fingerprint:credentialFingerprint(credentials,'a','b')},credentials,id=>id==='a'?a:b);
  const initial=a.placed.length+b.placed.length;
  const result=await recovered.stop('market');
  assert.equal(result.active,false);assert.equal(result.botStopped,true);assert.equal(result.closeStatus,'closed');
  assert.equal(a.placed.length+b.placed.length,initial+2);
  assert.equal(a.placed.at(-1).reduceOnly,true);assert.equal(b.placed.at(-1).reduceOnly,true);
});

test('stopped LBank-to-OKX journal with OKX 51169 reconciles the absent target before closing the source', async () => {
  const source=venue('lbank'),target=venue('okx'),credentials={lbank:{apiKey:'lbank'},okx:{apiKey:'okx'}};
  const original=new HedgeSession({sourceAdapter:source,targetAdapter:target});
  original.start({source:'lbank',target:'okx',symbols:['BTCUSDT'],totalMargin:10,leverageBySymbol:{BTCUSDT:1},dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  await original.runPromise;clearTimeout(original.monitorTimer);
  const snapshot=JSON.parse(JSON.stringify(original.state));
  const run=snapshot.runs[0];
  run.closeOrders.push({
    leg:'target',symbol:'BTCUSDT',clientOrderId:'failed-okx-close',quantity:run.hedgedQuantity,
    executedQuantity:0,side:run.targetSide==='BUY'?'SELL':'BUY',type:'MARKET',reduceOnly:true,
    status:'REJECTED',errorCode:'NO_POSITION',exchangeCode:'51169',
  });
  Object.assign(run,{state:'stopped',active:false,botStopped:true,closeStatus:'failed'});
  Object.assign(snapshot,{state:'stopped',active:false,botStopped:true,requiresAttention:true,closeStatus:'failed',
    closeError:"Закрытие не подтверждено. OKX: Order failed because you don't have any positions in this direction for this contract to reduce or close. [51169]"});
  target.getPositions=async()=>[];
  const sourceClosesBefore=source.placed.filter(order=>order.reduceOnly).length;
  const targetClosesBefore=target.placed.filter(order=>order.reduceOnly).length;
  const recovered=recoverSession({snapshot,fingerprint:credentialFingerprint(credentials,'lbank','okx')},credentials,id=>id==='lbank'?source:target);
  const result=await recovered.stop('market');
  assert.equal(result.closeStatus,'closed');assert.equal(result.requiresAttention,false);
  assert.equal(target.placed.filter(order=>order.reduceOnly).length,targetClosesBefore,'zero OKX snapshot must block a duplicate close');
  assert.equal(source.placed.filter(order=>order.reduceOnly).length,sourceClosesBefore+1,'remaining source exposure must be closed once');
  const restoredRun=result.runs[0];
  assert.ok(restoredRun.closeOrders.some(order=>order.leg==='target'&&order.observedClosed&&order.provisionalPrice));
  assert.equal(restoredRun.closeOrders.filter(order=>order.leg==='target'&&order.status==='REJECTED').length,1);
});

test('restored confirmed closure clears stale attention while retaining an independent loss limit', async () => {
  const credentials={a:{apiKey:'a'},b:{apiKey:'b'}};let calls=0;
  const adapter=new Proxy({}, {get:()=>async()=>{calls++;throw new Error('closed session must not contact an exchange');}});
  for(const lossLimitReached of [false,true]) {
    const snapshot={id:'already-closed',source:'a',target:'b',state:'stopped',active:false,botStopped:true,requiresAttention:true,closeStatus:'closed',lossLimitReached,runs:[]};
    const recovered=recoverSession({snapshot,fingerprint:credentialFingerprint(credentials,'a','b')},credentials,()=>adapter);
    assert.equal(recovered.state.requiresAttention,lossLimitReached);
    const stopped=await recovered.stop('market');
    assert.equal(stopped.closeStatus,'closed');assert.equal(stopped.active,false);
    assert.equal(stopped.requiresAttention,lossLimitReached);assert.equal(calls,0);
  }
});
