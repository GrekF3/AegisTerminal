const test = require('node:test');
const assert = require('node:assert/strict');
const { AdaptiveHedgeEngine, passivePrice } = require('./adaptive-hedge-engine.cjs');
const { executionPolicy } = require('./execution-policy.cjs');
const { historyRecord } = require('./history-store.cjs');
const { recoverSession, credentialFingerprint } = require('./session-recovery.cjs');
const { venue, liveConfig } = require('./fixtures.cjs');

function setup(sourceOptions = {}, targetOptions = {}) {
  let time = 0;
  const source = venue('a', sourceOptions), target = venue('b', targetOptions);
  source.supportsPostOnly = target.supportsPostOnly = true;
  const engine = new AdaptiveHedgeEngine({ sourceAdapter: source, targetAdapter: target, now: () => time, sleep: async ms => { time += ms; } });
  return { source, target, engine, now: () => time, advance: ms => { time += ms; } };
}
const config = { ...liveConfig, quantityStep: .1, margin: 10, leverage: 1 };
const resting = o => ({ status: o.reduceOnly ? 'FILLED' : o.canceled ? 'CANCELED' : 'NEW', executedQty: o.reduceOnly ? o.quantity : 0 });

test('source maker price race is repriced after definitive 187 rejection without unwinding the session', async () => {
  const {engine,source,target,now} = setup();
  const place = source.placeOrder; const attempts = [];
  source.placeOrder = async (c,o,opts) => {
    attempts.push({...o});
    if (attempts.length === 1) throw Object.assign(new Error('Price exceeds sell one price [187]'), {definitive:true,code:'POST_ONLY_WOULD_TAKE'});
    return place(c,o,opts);
  };
  source.getDepth = async () => ({bids:[{price:now()>=1000?9.8:9.999,quantity:100}],asks:[{price:now()>=1000?9.9:10,quantity:100}]});
  await engine.start(config);
  assert.equal(engine.state,'running');
  assert.deepEqual(attempts.map(o=>o.price),[10,9.9]);
  assert.notEqual(attempts[0].clientOrderId,attempts[1].clientOrderId);
  assert.equal(engine.run.sourceOrders[0].status,'REJECTED');
  assert.equal(engine.run.sourceOrders[0].executedQuantity,0);
  assert.equal(target.placed.length,1);
  assert.equal(source.placed.filter(o=>o.reduceOnly).length,0);
});

test('a maker-looking timeout without definitive rejection never permits a replacement', async () => {
  const {engine,source,target} = setup({unknown:()=>true,unreadable:true});
  const place=source.placeOrder;
  source.placeOrder=async(...args)=>{try{return await place(...args);}catch(error){error.code='POST_ONLY_WOULD_TAKE';throw error;}};
  await assert.rejects(engine.start(config),/неизвестен/);
  assert.equal(source.placed.length,1);assert.equal(target.placed.length,0);
});

test('passive prices round away from crossing and reject stale/crossed books', () => {
  const book = { bids: [{price: 10.021}], asks: [{price: 10.079}], receivedAt: 5000 };
  assert.equal(passivePrice(book, 'BUY', .05, 6000), 10);
  assert.equal(passivePrice(book, 'SELL', .05, 6000), 10.1);
  assert.throws(() => passivePrice(book, 'BUY', .05, 9000), /устарел/);
  assert.throws(() => passivePrice({ bids: [{price: 2}], asks: [{price: 1}] }, 'BUY', .01), /bid/);
});
test('source leads with Post-Only, target follows with Post-Only; roles and directions do not swap', async () => {
  const {engine,source,target} = setup();
  const events = []; source.events.push = target.events.push = e => events.push(e);
  const result = await engine.start(config);
  assert.equal(result.state, 'running'); assert.equal(result.hedgedQuantity, 1);
  assert.equal(source.placed[0].side, 'SELL'); assert.equal(target.placed[0].side, 'BUY');
  assert.equal(source.placed[0].price, 10); assert.equal(target.placed[0].price, 9.999);
  assert.ok([...source.placed,...target.placed].every(o => o.type === 'LIMIT' && o.postOnly));
  assert.match(events[0], /^a:place/); assert.match(events[1], /^b:place/);
  await engine.stop('market'); assert.equal(source.placed.at(-1).side,'BUY'); assert.equal(target.placed.at(-1).side,'SELL');
});
test('unsupported Post-Only falls back to source LIMIT and target MARKET without maker claims', async () => {
  const {engine,source,target} = setup(); source.supportsPostOnly = false;
  await engine.start(config);
  assert.equal(source.placed[0].type,'LIMIT'); assert.equal(source.placed[0].postOnly,false);
  assert.equal(target.placed[0].type,'MARKET'); assert.equal(engine.run.execution.targetPostOnly,false);
});
test('an immediate target skips maker delay and safely tops up a confirmed partial market fill', async () => {
  const {engine,target} = setup({}, {status:o => {
    if (o.reduceOnly) return {status:'FILLED',executedQty:o.quantity};
    if (o.type !== 'MARKET') return resting(o);
    return o.quantity > .9 ? {status:'CANCELED',executedQty:.4} : {status:'FILLED',executedQty:o.quantity};
  }});
  target.preferImmediateHedge = true;
  await engine.start(config);
  assert.equal(engine.state,'running');
  assert.equal(engine.run.execution.immediateTarget,true);
  assert.equal(engine.run.execution.targetPostOnly,false);
  assert.deepEqual(target.placed.map(o=>[o.type,o.quantity]),[['MARKET',1],['MARKET',.6]]);
  assert.equal(engine.run.hedgedQuantity,1);
});
test('an unknown immediate-target result never authorizes a top-up', async () => {
  const {engine,target} = setup({}, {unknown:o=>o.type==='MARKET',unreadable:true});
  target.preferImmediateHedge = true;
  await assert.rejects(engine.start(config),/неизвестен/);
  assert.equal(target.placed.length,1);
});
test('fresh target depth is rechecked before any source order is exposed', async () => {
  const {engine,source,target} = setup();
  target.preferImmediateHedge = true;
  target.getDepth = async () => ({bids:[{price:9.999,quantity:.5}],asks:[{price:10,quantity:.5}]});
  await assert.rejects(engine.start(config),/свежей глубины ЦЕЛЕВОЙ недостаточно/);
  assert.equal(source.placed.length,0); assert.equal(target.placed.length,0);
});
test('target waits 1500 ms total, confirms cancellation, then markets only the unfilled remainder', async () => {
  const {engine,target,now} = setup({}, {status: o => o.type==='MARKET' ? {status:'FILLED',executedQty:o.quantity} : {status:o.canceled?'CANCELED':'PARTIALLY_FILLED',executedQty:.4}});
  const events = []; const cancel = target.cancelOrder, place = target.placeOrder;
  target.cancelOrder = async (...args) => { events.push(['cancel',now()]); return cancel(...args); };
  target.placeOrder = async (c,o,opts) => { events.push([o.type,now(),o.quantity]); return place(c,o,opts); };
  await engine.start(config);
  assert.deepEqual(events, [['LIMIT',500,1],['cancel',2000],['MARKET',2000,.6]]);
  assert.equal(engine.run.hedgedQuantity,1); assert.equal(engine.run.targetOrders.length,2);
});
test('fill racing target cancellation is reconciled before market fallback', async () => {
  const {engine,target} = setup({}, {status:o => ({status:o.canceled?'FILLED':'PARTIALLY_FILLED',executedQty:o.canceled?o.quantity:.2})});
  await engine.start(config); assert.equal(target.placed.length,1); assert.equal(engine.run.hedgedQuantity,1);
});
test('unknown target cancellation never sends a duplicate market', async () => {
  const {engine,target,source} = setup({}, {status:resting});
  target.cancelOrder = async () => {};
  await assert.rejects(engine.start(config), /отмена остатка/);
  assert.equal(engine.state,'emergency'); assert.equal(target.placed.length,1); assert.equal(source.placed.length,1);
});
test('asynchronous cancel acknowledgement is polled to terminal before the market remainder',async()=>{
  let pendingReads=0;
  const {engine,target}=setup({}, {status:o=>o.type==='MARKET'?{status:'FILLED',executedQty:o.quantity}:{status:o.canceled && ++pendingReads>=3?'CANCELED':'PARTIALLY_FILLED',executedQty:.4}});
  const place=target.placeOrder;
  target.placeOrder=async(c,o,opts)=>{if(o.type==='MARKET')assert.ok(pendingReads>=3);return place(c,o,opts);};
  await engine.start(config); assert.equal(engine.state,'running'); assert.equal(target.placed[1].quantity,.6);
});
test('unchanged bid/ask is not canceled every tick',async()=>{
  const {engine,source,now}=setup();
  const original=source.getOrder;
  source.getOrder=async(c,o)=>now()<4000?{status:'NEW',executedQty:0}:original(c,o);
  await engine.start(config); assert.equal(source.placed.length,1); assert.equal(source.canceled.length,0);
});
test('unknown maker acknowledgement never triggers a fallback or blind close', async () => {
  const {engine,target,source} = setup({}, {unknown:()=>true,unreadable:true});
  await assert.rejects(engine.start(config),/неизвестен/);
  assert.equal(engine.state,'emergency'); assert.equal(target.placed.length,1); assert.equal(source.placed.length,1);
});
test('definitive Post-Only rejection permits market fallback', async () => {
  const {engine,target} = setup({}, {reject:o=>o.postOnly});
  await engine.start(config); assert.deepEqual(target.placed.map(o=>o.type),['LIMIT','MARKET']);
  assert.equal(engine.run.targetOrders[0].status,'REJECTED'); assert.equal(engine.run.hedgedQuantity,1);
});
test('slow preparation consumes maker deadline and cannot send an expired limit', async () => {
  const {engine,target,advance} = setup();
  target.prepareOrder = async o => { if(o.postOnly) advance(1700); return o; };
  await engine.start(config); assert.deepEqual(target.placed.map(o=>o.type),['MARKET']);
  assert.equal(engine.run.targetOrders.length,1);
});
test('price follows the source ask after 1 second, not the original price or target book', async () => {
  const {engine,source,now} = setup({status:o=>o.price<10?{status:'FILLED',executedQty:o.quantity}:resting(o)});
  source.getDepth = async () => ({bids:[{price:now()>=1000?9.8:9.999,quantity:100}],asks:[{price:now()>=1000?9.9:10,quantity:100}]});
  await engine.start(config);
  assert.deepEqual(source.placed.map(o=>o.price),[10,9.9]); assert.equal(source.canceled.length,1);
  assert.equal(engine.run.hedgedQuantity,1);
});
test('source cancel/fill race hedges late fills and replaces only the remaining quantity', async () => {
  const {engine,source,target,now} = setup({status:o=>o.price<10?{status:'FILLED',executedQty:o.quantity}:o.canceled?{status:'CANCELED',executedQty:.4}:{status:'NEW',executedQty:0}});
  source.getDepth = async () => ({bids:[{price:now()>=1000?9.8:9.999,quantity:100}],asks:[{price:now()>=1000?9.9:10,quantity:100}]});
  await engine.start(config);
  assert.deepEqual(source.placed.map(o=>o.quantity),[1,.6]); assert.deepEqual(target.placed.map(o=>o.quantity),[.4,.6]);
  assert.equal(engine.orders().length,4); assert.equal(engine.run.hedgedQuantity,1);
});
test('Stop during repricing confirms a racing source fill and closes only owned exposure', async () => {
  const {engine,source,target,now} = setup({status:o=>o.reduceOnly?{status:'FILLED',executedQty:o.quantity}:o.canceled?{status:'FILLED',executedQty:o.quantity}:{status:'NEW',executedQty:0}});
  source.getDepth = async () => ({bids:[{price:9.8,quantity:100}],asks:[{price:now()>=1000?9.9:10,quantity:100}]});
  const cancel=source.cancelOrder;
  source.cancelOrder = async (...args) => { await cancel(...args); engine.stopRequested=true; };
  await engine.start(config); await engine.stop('market');
  assert.equal(target.placed.length,0); assert.equal(source.placed.length,2);
  assert.equal(source.placed[1].reduceOnly,true); assert.equal(source.placed[1].quantity,1);
});
test('stop while second maker waits prevents market entry and market Stop closes both actual partial fills', async () => {
  const {engine,source,target,advance} = setup({}, {status:o=>o.reduceOnly?{status:'FILLED',executedQty:o.quantity}:{status:o.canceled?'CANCELED':'PARTIALLY_FILLED',executedQty:.4}});
  engine.sleep = async ms => { advance(ms); if(engine.state==='waiting_target_maker') engine.stopRequested=true; };
  await engine.start(config); await engine.stop('market');
  assert.equal(target.placed.filter(o=>!o.reduceOnly).length,1);
  assert.equal(source.placed.at(-1).quantity,1); assert.equal(target.placed.at(-1).quantity,.4);
});
test('unhedgeable partial fill fails closed instead of rounding a naked residual away', async () => {
  const {engine,source,target} = setup({status:o=>o.reduceOnly?{status:'FILLED',executedQty:o.quantity}:{status:o.canceled?'CANCELED':'PARTIALLY_FILLED',executedQty:.15}});
  await assert.rejects(engine.start(config),/минимум\/шаг/);
  assert.equal(engine.state,'error'); assert.equal(target.placed.length,0); assert.equal(source.placed.at(-1).quantity,.15);
  assert.equal(source.placed.at(-1).reduceOnly,true);
});
test('rising quotes shrink quantity to the common step, never expand the margin budget', async () => {
  const {engine,source} = setup();
  source.getDepth = async () => ({bids:[{price:10.5,quantity:100}],asks:[{price:11,quantity:100}]});
  await engine.start(config); assert.equal(source.placed[0].quantity,.9); assert.equal(engine.run.quantity,.9);
  assert.ok(source.placed[0].price*source.placed[0].quantity <=10);
});
test('history and restart preserve every target maker/market ID; recovery sends only unique closes', async () => {
  const {engine,source,target} = setup({}, {status:o=>o.type==='MARKET'?{status:'FILLED',executedQty:o.quantity}:{status:o.canceled?'CANCELED':'PARTIALLY_FILLED',executedQty:.4}});
  await engine.start(config);
  const snapshot={id:'s',source:'a',target:'b',active:true,state:'running',runs:[engine.snapshot()]};
  const record=historyRecord(snapshot); assert.equal(record.orders.length,3); assert.equal(record.orders[0].postOnly,true);
  const credentials={a:{},b:{}};
  const recovered=recoverSession(JSON.parse(JSON.stringify({snapshot,fingerprint:credentialFingerprint(credentials,'a','b')})),credentials,id=>id==='a'?source:target);
  const before=source.placed.length+target.placed.length;
  await recovered.stop('market'); await recovered.stop('market');
  assert.equal(source.placed.length+target.placed.length,before+2); assert.equal(recovered.state.state,'stopped');
  assert.equal(target.placed.at(-1).quantity,1); assert.equal(source.placed.at(-1).quantity,1);
});
test('LBank maker capability is connection-mode aware and policy wait is not caller-overridable', () => {
  const lbank=require('../exchanges/lbank.cjs'),okx=require('../exchanges/okx.cjs');
  assert.equal(executionPolicy(lbank,okx,{sourceCredentials:{connectionMode:'official'}}).targetPostOnly,false);
  assert.equal(executionPolicy(lbank,okx,{sourceCredentials:{connectionMode:'undetectable'},makerWaitMs:999999}).makerWaitMs,1500);
  const targetPolicy=executionPolicy(okx,lbank,{targetCredentials:{connectionMode:'undetectable'}});
  assert.equal(targetPolicy.immediateTarget,true);assert.equal(targetPolicy.targetPostOnly,false);assert.equal(targetPolicy.targetMarketAttempts,3);
});

for (const stage of ['rules', 'quote']) {
  test(`local stop while adaptive ${stage} is pending prevents chained venue reads and all orders`, async () => {
    const { engine, source, target } = setup();
    let release, requests = 0, laterReads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    if (stage === 'rules') {
      const getRules = source.getTradingRules;
      source.getTradingRules = async (...args) => { requests++; await gate; return getRules(...args); };
      target.getTradingRules = async () => { laterReads++; throw new Error('must not request target rules'); };
    } else {
      const getDepth = source.getDepth;
      source.getDepth = async (...args) => { requests++; await gate; return getDepth(...args); };
      target.getDepth = async () => { laterReads++; throw new Error('must not request target quote'); };
    }
    const starting = engine.start(config); await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    const stopped = await engine.stop('app-only');
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.active, false);
    release(); const result = await starting;
    assert.equal(result.state, 'stopped'); assert.equal(result.error, undefined);
    assert.equal(laterReads, 0); assert.equal(source.placed.length + target.placed.length, 0);
  });
}
