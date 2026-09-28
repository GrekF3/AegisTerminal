const test = require('node:test');
const assert = require('node:assert/strict');
const { ContinuousHedgeSession, lossLimit } = require('./continuous-session.cjs');
const { venue, liveConfig } = require('./fixtures.cjs');
const { recoverSession, credentialFingerprint } = require('./session-recovery.cjs');
const config = { ...liveConfig, symbols: ['BTCUSDT'], totalMargin: 10, leverageBySymbol: { BTCUSDT: 1 }, maxLosses: 5, hedgePercent: 98 };
function setup(a = {}, b = {}, extra = {}) {
  const source = venue('a', a), target = venue('b', b);
  const session = new ContinuousHedgeSession({ sourceAdapter: source, targetAdapter: target, autoSchedule: false, sleep: async () => {}, ...extra });
  const history = []; session.on('round', value => history.push(value));
  return { source, target, session, history };
}
async function entry(s) { await s.tick(); await s.entryPromise; }
const losing = { pnl: -10, status: o => ({ status: 'FILLED', executedQty: o.quantity, avgPrice: o.reduceOnly ? 0.1 : 10 }) };

test('close waits for Retry-After then reconciles the accepted order without resubmission',async()=>{
  let time=0,limited=true,reads=0;
  const {session:s,source,target}=setup({}, {}, {now:()=>time});
  s.start(config);await entry(s);
  const read=target.getOrder;
  target.getOrder=async(c,o)=>{if(o.reduceOnly){reads++;if(limited)throw Object.assign(new Error('HTTP 429'),{httpStatus:429,retryAfterMs:12000});}return read(c,o);};
  await s.stop('market');
  assert.equal(reads,1);assert.equal(s.state.active,false);
  assert.equal(s.state.closeStatus,'waiting_confirmation');assert.equal(s.state.closeError,undefined);
  assert.equal(s.state.notice.code,'close_rate_limit');assert.equal(s.pendingStop.at,12000);
  time=11999;await s.tick();assert.equal(reads,1);
  await s.stop('market');assert.equal(reads,1);
  limited=false;time=12000;await s.tick();
  assert.equal(s.state.closeStatus,'closed');assert.equal(s.state.active,false);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);
});

test('manual management cancels automatic close retries during a rate limit',async()=>{
  let time=0,calls=0;
  const {session:s,target}=setup({}, {}, {now:()=>time});s.start(config);await entry(s);
  const read=target.getOrder;
  target.getOrder=async(c,o)=>{if(o.reduceOnly){calls++;throw Object.assign(new Error('HTTP 429'),{httpStatus:429,retryAfterMs:5000});}return read(c,o);};
  await s.stop('market');assert.equal(s.state.closeStatus,'waiting_confirmation');
  await s.stop('app-only');const before=calls;time=6000;await s.tick();
  assert.equal(calls,before);assert.equal(s.state.manualManagement,true);
});

test('persistent rate limit is bounded and duplicate failures are reported once',async()=>{
  let time=0;
  const {session:s}=setup({}, {}, {now:()=>time});s.start(config);await entry(s);
  const engine=s.engines[0];engine.stop=async()=>{throw Object.assign(new Error('HTTP 429'),{httpStatus:429,retryAfterMs:5000});};
  s.engines.push(engine,engine);
  await s.stop('market');time=300001;await s.tick();
  assert.equal(s.state.closeStatus,'failed');assert.equal(s.state.closeError,'HTTP 429');assert.equal(s.pendingStop,null);
});

test('Stop before the positions dialog freezes the strategy offline and still permits explicit market closing', async()=>{
  const {session:s,source,target}=setup();s.start(config);await entry(s);
  const original=JSON.stringify(s.engines[0].orders());let calls=0;
  const adapters=[source,target],saved=adapters.map(adapter=>Object.fromEntries(['getOrder','getPositions','cancelOrder','placeOrder','prepareOrder','getClosePlan'].map(method=>[method,adapter[method]])));
  for(const adapter of adapters) for(const method of Object.keys(saved[0])) adapter[method]=async()=>{calls++;throw new Error('Undetectable disconnected');};
  const pending=s.stop('pause');
  assert.equal(s.state.active,false);assert.equal(s.state.botStopped,true);assert.equal(s.state.state,'stopped');
  assert.equal(s.state.closeStatus,'not_requested');assert.equal(s.state.requiresAttention,true);
  await pending;await s.tick();await s.monitorOnce();
  assert.equal(calls,0);assert.equal(JSON.stringify(s.engines[0].orders()),original);
  assert.throws(()=>s.start(config),/завершите/);
  adapters.forEach((adapter,index)=>Object.assign(adapter,saved[index]));
  await s.stop('market');
  assert.equal(s.state.closeStatus,'closed');assert.equal(s.state.active,false);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
  await s.tick();assert.equal(source.placed.filter(o=>!o.reduceOnly).length,1);
});

test('market Stop reports the bot stopped synchronously while the close request has no response', {timeout:1000},async t=>{
  const {session:s,source,target}=setup();s.start(config);await entry(s);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const read=target.getOrder;
  target.getOrder=async(c,o)=>{if(o.reduceOnly){entered();await new Promise(resolve=>{release=resolve;});}return read(c,o);};
  t.after(()=>release?.());
  const stopping=s.stop('market');
  assert.equal(s.state.active,false);assert.equal(s.state.state,'stopped');assert.equal(s.state.closeStatus,'closing');
  await started;
  assert.equal(s.state.botStopped,true);assert.equal(s.state.requiresAttention,true);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,0);
  s.publish({state:'monitoring',active:true,error:'late error'});
  assert.equal(s.state.active,false);assert.equal(s.state.state,'stopped');assert.equal(s.state.error,undefined);
  release();await stopping;
  assert.equal(s.state.closeStatus,'closed');assert.equal(s.state.active,false);
});

test('an unknown original request prevents duplicate closing but never prevents Stop', async()=>{
  const {session:s,source,target}=setup({unknown:()=>true,unreadable:true});
  s.start(config);await entry(s);
  const journal=JSON.stringify(s.engines[0].orders());
  source.getOrder=async()=>{throw new Error('LBank: исходный запрос ещё не подтверждён; повторная отправка заблокирована');};
  const stopped=await s.stop('market');
  assert.equal(stopped.active,false);assert.equal(stopped.state,'stopped');assert.equal(stopped.botStopped,true);
  assert.equal(stopped.closeStatus,'failed');assert.match(stopped.closeError,/исходный запрос/);assert.equal(stopped.error,undefined);
  assert.equal(stopped.requiresAttention,true);assert.equal(JSON.stringify(s.engines[0].orders()),journal);
  await s.stop('market');await s.tick();
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,0);
  await s.stop('app-only');assert.equal(s.state.closeStatus,'not_requested');assert.equal(s.state.requiresAttention,false);
});

test('pause while the initial placement is held preserves its late receipt without hedging or auto-closing', {timeout:1000},async t=>{
  const {session:s,source,target}=setup();
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const place=source.placeOrder;
  source.placeOrder=async(...args)=>{const result=await place(...args);entered();await new Promise(resolve=>{release=resolve;});return result;};
  t.after(()=>release?.());
  s.start(config);await s.tick();const entering=s.entryPromise;await started;
  await s.stop('pause');
  assert.equal(s.state.active,false);assert.equal(s.state.closeStatus,'not_requested');
  release();await entering;await s.tick();
  assert.ok(s.engines[0].orders()[0].orderId);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,0);
  assert.equal(s.state.error,undefined);assert.equal(s.state.active,false);
});

test('manual Stop succeeds offline without reading or canceling positions and keeps the journal', async () => {
  const {session:s,source,target,history}=setup();s.start(config);await entry(s);
  const before=JSON.stringify(s.engines[0].orders());let calls=0;
  for(const adapter of [source,target]) for(const method of ['getOrder','getPositions','getOpenOrders','getAccount','cancelOrder','placeOrder']) {
    adapter[method]=async()=>{calls++;throw new Error('Undetectable disconnected');};
  }
  const result=await s.stop('app-only');
  assert.equal(result.active,false);assert.equal(result.state,'stopped');assert.equal(result.requiresAttention,false);
  assert.equal(result.manualManagement,true);assert.equal(result.error,undefined);
  assert.equal(calls,0);assert.equal(history.length,0);assert.equal(JSON.stringify(s.engines[0].orders()),before);
  await s.tick();await s.monitorOnce();await s.reconcileOnce();
  assert.equal(calls,0);assert.equal(s.state.active,false);
});

test('manual Stop overrides a pending market close immediately and ignores its late completion', {timeout:1000}, async()=>{
  const {session:s,source,target,history}=setup();s.start(config);await entry(s);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const read=target.getOrder;
  target.getOrder=async(c,o)=>{if(o.reduceOnly){entered();await new Promise(resolve=>{release=resolve;});}return read(c,o);};
  const marketStop=s.stop('market');await started;
  const result=await s.stop('app-only');
  assert.equal(result.active,false);assert.equal(result.stopMode,'app-only');
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,0);
  release();await marketStop;
  assert.equal(s.state.active,false);assert.equal(s.state.state,'stopped');assert.equal(s.state.stopMode,'app-only');
  assert.equal(s.state.error,undefined);assert.equal(history.length,0);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,0);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
});

test('manual Stop during PnL-triggered closure cannot record a completed round or resume monitoring', {timeout:1000},async()=>{
  const {session:s,source,target,history}=setup({}, {pnl:10});s.start(config);await entry(s);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  target.getClosePlan=async()=>{entered();await new Promise(resolve=>{release=resolve;});throw new Error('profile disconnected');};
  const monitoring=s.tick();await started;await s.stop('app-only');release();await monitoring;
  assert.equal(s.state.state,'stopped');assert.equal(s.state.active,false);assert.equal(s.state.requiresAttention,false);
  assert.equal(history.length,0);assert.equal(s.state.completedRounds,0);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,0);assert.equal(target.placed.filter(o=>o.reduceOnly).length,0);
});

test('delayed confirmed source fill completes the same hedge without closing or reopening the source',async()=>{
  let time=0,visible=false;
  const {session:s,source,target,history}=setup({}, {}, {now:()=>time,sleep:async ms=>{time+=ms;}});
  const read=source.getOrder;
  source.getOrder=async(c,o)=>{if(!visible)throw Object.assign(new Error('indexing'),{code:'ORDER_PENDING_HISTORY'});return read(c,o);};
  s.start(config);await entry(s);
  const runId=s.engines[0].run.id,sourceId=s.engines[0].run.sourceOrders[0].clientOrderId;
  assert.equal(s.state.state,'waiting_exchange');assert.equal(s.state.requiresAttention,false);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,0);
  await s.tick();assert.equal(source.placed.length,1);
  visible=true;time+=2001;await s.tick();await s.reconcilePromise;await entry(s);
  assert.equal(history.length,0);assert.equal(s.state.requiresAttention,false);assert.equal(s.state.state,'monitoring');
  assert.equal(s.engines[0].run.id,runId);assert.equal(s.engines[0].run.sourceOrders[0].clientOrderId,sourceId);
  assert.equal(s.state.completedOrders,1);assert.equal(s.engines[0].run.hedgedQuantity,1);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,0);
  assert.equal(source.placed.filter(o=>!o.reduceOnly).length,1);
  assert.equal(target.placed.filter(o=>!o.reduceOnly).length,1);
  await s.stop('market');
});

test('delayed target fill is reconciled without a second target order or an unnecessary close',async()=>{
  let time=0,visible=false;
  const {session:s,source,target,history}=setup({}, {}, {now:()=>time,sleep:async ms=>{time+=ms;}});
  const read=target.getOrder;
  target.getOrder=async(c,o)=>{if(!visible)throw Object.assign(new Error('target indexing'),{code:'ORDER_PENDING_HISTORY'});return read(c,o);};
  s.start(config);await entry(s);
  const id=s.engines[0].run.id;
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,1);
  visible=true;time+=2001;await s.tick();await s.reconcilePromise;await s.tick();
  assert.equal(s.state.state,'monitoring');assert.equal(s.engines[0].run.id,id);
  assert.equal(s.engines[0].run.hedgedQuantity,1);assert.equal(s.state.completedOrders,1);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,1);assert.equal(history.length,0);
  await s.stop('market');
});

test('a confirmed partial source after history delay hedges only the actual fill and keeps its position',async()=>{
  let time=0,visible=false;
  const {session:s,source,target,history}=setup({status:o=>({status:'CANCELED',executedQty:o.quantity*.4})}, {}, {now:()=>time,sleep:async ms=>{time+=ms;}});
  const read=source.getOrder;
  source.getOrder=async(c,o)=>{if(!visible)throw Object.assign(new Error('indexing'),{code:'ORDER_PENDING_HISTORY'});return read(c,o);};
  s.start(config);await entry(s);visible=true;time+=2001;await s.tick();await s.reconcilePromise;await s.tick();
  assert.equal(s.state.state,'monitoring');assert.equal(s.engines[0].run.quantity,.4);assert.equal(s.engines[0].run.hedgedQuantity,.4);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,1);assert.equal(target.placed[0].quantity,.4);
  assert.equal(history.length,0);assert.equal(s.engines[0].run.pnlTarget.margin,4);
  await s.stop('app-only');
});

test('Stop while entry reconciliation is held preserves the confirmed reply but forbids target hedging', {timeout:1000},async t=>{
  let time=0,visible=false,release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const {session:s,source,target}=setup({}, {}, {now:()=>time,sleep:async ms=>{time+=ms;}});
  const read=source.getOrder;
  source.getOrder=async(c,o)=>{
    if(!visible)throw Object.assign(new Error('indexing'),{code:'ORDER_PENDING_HISTORY'});
    entered();await new Promise(resolve=>{release=resolve;});return read(c,o);
  };
  t.after(()=>release?.());
  s.start(config);await entry(s);visible=true;time+=2001;await s.tick();const reconciling=s.reconcilePromise;await started;
  await s.stop('pause');release();await reconciling;await s.tick();
  assert.equal(s.state.state,'stopped');assert.equal(s.state.closeStatus,'not_requested');assert.equal(s.state.active,false);
  assert.equal(s.engines[0].run.sourceOrders[0].executedQuantity,1);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,0);assert.equal(s.state.closeError,undefined);
});

test('Stop keeps reconciling an accepted close after delayed history and never reopens',async()=>{
  let time=0,visible=false;
  const {session:s,source,target,history}=setup({}, {}, {now:()=>time,sleep:async ms=>{time+=ms;}});
  s.start(config);await entry(s);
  const read=target.getOrder;
  target.getOrder=async(c,o)=>{if(o.reduceOnly&&!visible)throw Object.assign(new Error('indexing'),{code:'ORDER_PENDING_HISTORY'});return read(c,o);};
  await s.stop('market');
  assert.equal(s.state.state,'stopped');assert.equal(s.state.active,false);assert.equal(s.state.botStopped,true);
  assert.equal(s.state.closeStatus,'waiting_confirmation');assert.equal(s.state.requiresAttention,true);assert.equal(s.state.error,undefined);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
  visible=true;time+=2001;await s.tick();
  assert.equal(s.state.state,'stopped');assert.equal(s.state.active,false);assert.equal(history.length,1);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);
  await s.tick();assert.equal(target.placed.filter(o=>!o.reduceOnly).length,1);
});

test('permanently missing history remains unresolved, bounded recovery never invents a fill',async()=>{
  let time=0;
  const {session:s,source,target}=setup({}, {}, {now:()=>time,sleep:async ms=>{time+=ms;}});
  source.getOrder=async()=>{throw Object.assign(new Error('indexing'),{code:'ORDER_PENDING_HISTORY'});};
  s.start(config);await entry(s);time+=300001;await s.tick();await s.reconcilePromise;
  assert.equal(s.state.state,'emergency');assert.equal(s.state.requiresAttention,true);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,0);
  assert.equal(s.engines[0].run.sourceOrders[0].executedQuantity,0);
});

test('PnL monitoring sums own position rows while ignoring separate copy positions',async()=>{
  const {session:s,source,target}=setup();s.start(config);await entry(s);
  const read=target.getPositions;
  target.getPositions=async()=> (await read()).flatMap(p=>[{...p,id:'p1',isOwn:true,quantity:p.quantity*.4,unrealizedPnl:5},{...p,id:'p2',isOwn:true,quantity:p.quantity*.6,unrealizedPnl:5},{...p,id:'copy',isOwn:false,quantity:9,unrealizedPnl:-100}]);
  await s.monitorOnce();
  assert.equal(s.state.requiresAttention,false);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);
  await s.stop('market');
});

test('unsafe 95% request is reduced to the protected liquidation budget and uses actual entry margin', async () => {
  for (const sign of [1, -1]) {
    const { session:s, source, target } = setup({}, { status:o=>({status:'FILLED',executedQty:o.quantity,avgPrice:8}) });
    s.start({...config,hedgePercent:95});await entry(s);
    const basis=s.engines[0].run.pnlTarget;
    assert.equal(basis.margin,8);assert.equal(basis.requestedPercent,95);assert.equal(basis.percent,69.64999999999999);assert.equal(basis.threshold,5.571999999999999);
    const positions=target.getPositions;
    target.getPositions=async()=> (await positions()).map(p=>({...p,unrealizedPnl:sign*(basis.threshold-.01)}));
    await s.monitorOnce();assert.equal(target.placed.filter(o=>o.reduceOnly).length,0);
    target.getPositions=async()=> (await positions()).map(p=>({...p,unrealizedPnl:sign*basis.threshold}));
    await s.monitorOnce();assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
    assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);await s.stop('market');
  }
});

test('brief missing PnL is quiet synchronization, not error, and recovers without another Start',async()=>{
  let time=1000;const {session:s,source,target}=setup({}, {}, {now:()=>time});s.start(config);await entry(s);
  const original=target.getPositions;
  target.getPositions=async()=> (await original()).map(p=>({...p,unrealizedPnl:null}));
  await s.tick();assert.equal(s.state.state,'waiting_pnl');assert.equal(s.state.error,undefined);assert.equal(s.state.notice.level,'info');
  assert.equal(s.state.currentPnl.target,null);assert.equal(s.state.requiresAttention,false);
  time+=16000;await s.tick();assert.equal(s.state.notice.level,'warning');assert.equal(s.state.notice.since,1000);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,1);
  target.getPositions=original;await s.tick();assert.equal(s.state.state,'monitoring');assert.equal(s.state.notice,undefined);
  await s.stop('market');
});

test('missing source PnL never prevents closing on a confirmed target threshold',async()=>{
  const {session:s,source,target}=setup({}, {pnl:10});s.start(config);await entry(s);
  const original=source.getPositions;
  source.getPositions=async()=> (await original()).map(p=>({...p,unrealizedPnl:null}));
  await s.tick();
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,1);
  assert.equal(target.placed.filter(o=>o.reduceOnly).length,1);
  assert.equal(s.engines.length,0);await s.stop('market');
});

test('recovery between round accounting and pruning cannot count the same loss twice', async () => {
  const {session:s,source,target}=setup({},losing);
  s.start(config); await entry(s);
  const engine=s.engines[0]; await engine.stop('market'); await s.archive(engine,'pnl_threshold');
  assert.equal(s.state.lossCount,1); assert.equal(s.state.runs[0].roundRecorded,true);
  const credentials={a:config.sourceCredentials,b:config.targetCredentials};
  const recovered=recoverSession({snapshot:s.state,fingerprint:credentialFingerprint(credentials,'a','b')},credentials,id=>id==='a'?source:target);
  await recovered.stop('market');
  assert.equal(recovered.state.lossCount,1); assert.equal(recovered.state.completedRounds,1);
});
test('loss limit accepts zero and rejects negative, fractional, nonfinite values', () => {
  assert.equal(lossLimit(), 5); assert.equal(lossLimit(0), 0);
  for (const x of [-1, .5, Infinity, 'bad']) assert.throws(() => lossLimit(x));
});
test('Start persists through missing data, retries by itself, and opens target by trend', async () => {
  let time = 1000; const { session: s, source, target } = setup({}, {}, { now: () => time });
  const original = target.getDayOpen; let ready = false;
  target.getDayOpen = async (...args) => { if (!ready) throw new Error('temporarily unavailable'); return original(...args); };
  s.start(config); await entry(s);
  assert.equal(s.state.state, 'waiting_retry'); assert.equal(s.state.active, true); assert.equal(s.state.lossCount, 0);
  assert.equal(target.placed.length, 0); ready = true; await entry(s); assert.equal(target.placed.length, 0);
  time += 2001; await entry(s);
  assert.equal(target.placed[0].side, 'BUY'); assert.equal(source.placed[0].side, 'SELL');
  await s.stop('market');
});
test('a losing pair closes both legs then automatically opens the next round', async () => {
  const { session: s, source, target, history } = setup({}, losing);
  s.start({ ...config, maxLosses: 0 }); await entry(s); await entry(s);
  assert.equal(s.state.lossCount, 1); assert.equal(s.state.active, true); assert.equal(s.state.lossLimitReached, false);
  assert.equal(history.length, 1); assert.equal(history[0].outcome, 'loss');
  assert.equal(source.placed.filter(o => o.reduceOnly).length, 1);
  assert.equal(target.placed.filter(o => !o.reduceOnly).length, 2);
  assert.equal(s.engines.length, 1); await s.stop('market');
});
test('a rejected server TP/SL immediately unwinds the equal pair before retrying',async()=>{
  const {session:s,source,target}=setup();let protectionWrites=0;
  source.placeProtection=async()=>{protectionWrites++;throw Object.assign(new Error('TP/SL rejected'),{definitive:true});};
  s.start(config);await entry(s);
  assert.equal(protectionWrites,1);assert.equal(s.engines.length,0);
  assert.equal(source.placed.filter(order=>!order.reduceOnly).length,1);assert.equal(source.placed.filter(order=>order.reduceOnly).length,1);
  assert.equal(target.placed.filter(order=>!order.reduceOnly).length,1);assert.equal(target.placed.filter(order=>order.reduceOnly).length,1);
  assert.equal((await source.getPositions()).length,0);assert.equal((await target.getPositions()).length,0);
  assert.equal(s.state.state,'waiting_retry');assert.match(s.state.error,/TP\/SL rejected/);
  await s.stop('app-only');
});
test('one cumulative loss limit applies across all coins and never starts a third pair', async () => {
  const { session: s, target, history } = setup({}, losing);
  s.start({ ...config, symbols: ['BTCUSDT', 'ETHUSDT'], totalMargin: 20, maxLosses: 2 });
  await entry(s); await entry(s); await s.tick(); await s.stopPromise;
  assert.equal(s.state.lossCount, 2); assert.equal(s.state.state, 'loss_limit'); assert.equal(s.state.active, false);
  assert.equal(s.state.requiresAttention, true); assert.equal(target.placed.filter(o => !o.reduceOnly).length, 2);
  assert.deepEqual(history.map(h => h.symbols[0]), ['BTCUSDT', 'ETHUSDT']);
  await s.tick(); assert.throws(() => s.start(config), /завершите/);
});
test('a profitable round does not erase a previous session loss', async () => {
  const { session: s, target } = setup({}, losing); s.start(config);
  await entry(s); await entry(s); assert.equal(s.state.lossCount, 1);
  const old = target.getOrder;
  target.getOrder = async (c, o) => ({ ...await old(c, o), avgPrice: o.reduceOnly ? 20 : 10 });
  const positions = target.getPositions;
  target.getPositions = async () => (await positions()).map(p => ({ ...p, unrealizedPnl: 10 }));
  await entry(s); assert.equal(s.state.lossCount, 1); assert.equal(s.state.completedRounds, 2);
  await s.stop('market');
});
test('unknown order outcome blocks retries rather than duplicating an opening order', async () => {
  const { session: s, source, target } = setup({ unknown: () => true, unreadable: true });
  s.start(config); await entry(s);
  assert.equal(s.state.state, 'emergency'); assert.equal(s.state.requiresAttention, true);
  await entry(s); assert.equal(source.placed.length, 1); assert.equal(target.placed.length, 0);
});
test('Stop while awaiting preflight prevents all later leverage changes and orders', async () => {
  const { session: s, source, target } = setup(); let release;
  source.getAccount = () => new Promise(resolve => { release = () => resolve({ available: 1000 }); });
  s.start(config); await s.tick(); const pending = s.entryPromise;
  await s.stop('market'); release(); await pending;
  assert.equal(source.events.length, 0); assert.equal(target.placed.length, 0); assert.equal(s.state.active, false);
});
test('position polling resumes after network failure, without a second Start', async () => {
  const { session: s, target } = setup(); s.start(config); await entry(s);
  const original = target.getPositions; target.getPositions = async () => { throw new Error('offline'); };
  await s.tick(); assert.equal(s.state.active, true); assert.equal(s.state.state, 'waiting_exchange');
  target.getPositions = original; await s.tick(); assert.equal(s.state.state, 'monitoring');
  assert.equal(target.placed.length, 1); await s.stop('market');
});
test('loss lock survives a restart and an ordinary Stop cannot clear it', async () => {
  const { session: s, source, target } = setup({}, losing);
  s.start({ ...config, maxLosses: 1 }); await entry(s); await s.tick(); await s.stopPromise;
  const credentials = { a: {}, b: {} };
  const recovered = recoverSession({ fingerprint: credentialFingerprint(credentials, 'a', 'b'), snapshot: s.state }, credentials, id => id === 'a' ? source : target);
  assert.equal(recovered.state.state, 'stopped'); assert.equal(recovered.state.lossLimitReached, true); await recovered.stop('market');
  assert.equal(recovered.state.requiresAttention, true); assert.equal(recovered.state.lossCount, 1);
});
test('simultaneous Stop calls count the same realized round only once', async () => {
  const { session: s, history } = setup({}, losing); s.start(config); await entry(s);
  await Promise.all([s.stop('market'), s.stop('market')]);
  assert.equal(s.state.lossCount, 1); assert.equal(history.length, 1);
});

test('a held history recovery keeps another coin PnL monitored and concurrent Stop closes each exposure once', { timeout: 5000 }, async t => {
  let time = 0, visible = false, holdRecovery = false, release, heldReads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => { visible = true; release(); });
  const { session: s, source, target, history } = setup({}, {}, { now: () => time, sleep: async ms => { time += ms; } });
  const read = source.getOrder;
  source.getOrder = async (c, order) => {
    if (order.symbol === 'ETHUSDT' && !order.reduceOnly && !visible) {
      if (holdRecovery) { heldReads++; await gate; }
      if (!visible) throw Object.assign(new Error('ETH history indexing'), { code: 'ORDER_PENDING_HISTORY' });
    }
    return read(c, order);
  };
  s.start({ ...config, symbols: ['BTCUSDT', 'ETHUSDT'], totalMargin: 20, leverageBySymbol: { BTCUSDT: 1, ETHUSDT: 1 } });
  await entry(s); // BTC is fully hedged and stays open.
  await entry(s); // ETH's accepted first order has delayed history.
  assert.equal(s.engines.find(e => e.run.symbol === 'BTCUSDT').state, 'running');
  assert.equal(s.reconciliations.size, 1);

  const positions = target.getPositions;
  target.getPositions = async () => (await positions()).map(p => ({ ...p, unrealizedPnl: p.symbol === 'BTCUSDT' ? 10 : 0 }));
  holdRecovery = true; time += 2001;
  await s.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heldReads, 1);
  assert.ok(s.reconcilePromise);
  assert.equal(source.placed.filter(o => o.symbol === 'BTCUSDT' && o.reduceOnly).length, 1);
  assert.equal(target.placed.filter(o => o.symbol === 'BTCUSDT' && o.reduceOnly).length, 1);
  assert.equal(history.filter(round => round.symbols[0] === 'BTCUSDT').length, 1);
  assert.equal(source.placed.filter(o => o.symbol === 'ETHUSDT' && o.reduceOnly).length, 0);
  await s.tick();
  assert.equal(heldReads, 1, 'the same unresolved intent is read by one reconciliation only');
  assert.equal(source.placed.filter(o => !o.reduceOnly).length, 2, 'new rounds stay blocked');

  const recovery = s.reconcilePromise;
  const stops = [s.stop('market'), s.stop('market')];
  visible = true; release();
  await Promise.all([...stops, recovery]);
  assert.equal(s.state.state, 'stopped');
  assert.equal(s.state.active, false);
  assert.equal(source.placed.filter(o => o.symbol === 'ETHUSDT' && o.reduceOnly).length, 1);
  assert.equal(target.placed.filter(o => o.symbol === 'ETHUSDT').length, 0);
  assert.equal(history.length, 2);
  assert.equal(new Set(history.map(round => round.id)).size, 2);
  await s.tick();
  assert.equal(source.placed.filter(o => !o.reduceOnly).length, 2);
});

test('Stop then immediate Start cannot revive the previous session pending preflight', async t => {
  const { session: s, source, target } = setup();
  const original = source.getAccount;
  let release;
  source.getAccount = () => {
    source.getAccount = original;
    return new Promise(resolve => { release = () => resolve({ available: 1000, total: 1000 }); });
  };
  t.after(() => release?.());
  const next = { ...config, symbols: ['ETHUSDT'], leverageBySymbol: { ETHUSDT: 1 } };
  s.start(config);
  await s.tick();
  const previous = s.entryPromise;
  await s.stop('market');
  assert.equal(s.state.state, 'stopped');
  assert.throws(() => s.start(next), /запрос|заверш|ожид/i);
  release(); await previous;
  assert.equal(source.placed.length, 0);
  assert.equal(target.placed.length, 0);
  assert.equal(source.events.length, 0, 'the abandoned preflight cannot change leverage either');
  s.start(next); await entry(s);
  assert.deepEqual(source.placed.filter(o => !o.reduceOnly).map(o => o.symbol), ['ETHUSDT']);
  assert.deepEqual(target.placed.filter(o => !o.reduceOnly).map(o => o.symbol), ['ETHUSDT']);
  await s.stop('market');
});
