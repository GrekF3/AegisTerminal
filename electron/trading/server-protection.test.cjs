const test=require('node:test');
const assert=require('node:assert/strict');
const {HedgeEngine}=require('./hedge-engine.cjs');
const {venue}=require('./fixtures.cjs');
const {protectionBudget,bracketForSide}=require('./server-protection.cjs');

test('protection budget keeps a liquidation reserve and includes both venue fees',()=>{
  const value=protectionBudget({requestedPercent:95,leverage:20,feeRates:{
    source:{entry:.0002,exit:.0006},target:{entry:.0006,exit:.0006},
  }});
  assert.equal(value.safeSourceLossPercent,62.99999999999999);
  assert.ok(value.effectiveNetPercent<61);
  assert.ok(value.grossMovePercent>value.effectiveNetPercent);
  assert.ok(value.moveRatio<.04);
});

test('opposite legs use the same absolute server boundaries and require full-volume verification',async()=>{
  const source=venue('source'),target=venue('target');
  const sourceRead=source.getOrder;source.getOrder=async(...args)=>({...await sourceRead(...args),avgPrice:9.9});
  const engine=new HedgeEngine({sourceAdapter:source,targetAdapter:target,sleep:async()=>{}});
  await engine.start({source:'source',target:'target',sourceCredentials:{},targetCredentials:{},symbol:'BTCUSDT',quantity:1,price:10,
    targetSide:'BUY',leverage:2,margin:5,sourceRules:{tickSize:.001},targetRules:{tickSize:.001},protectionMoveRatio:.05,
    dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  await engine.ensureProtection();
  const [sourceProtection,targetProtection]=engine.run.protections;
  assert.equal(sourceProtection.takeProfitPrice,targetProtection.stopLossPrice);
  assert.equal(sourceProtection.stopLossPrice,targetProtection.takeProfitPrice);
  assert.equal(engine.run.serverProtected,true);

  const broken=venue('broken');
  const original=broken.getProtection;
  broken.getProtection=async(...args)=>({...await original(...args),quantity:.5});
  const unsafe=new HedgeEngine({sourceAdapter:broken,targetAdapter:venue('other'),sleep:async()=>{}});
  await unsafe.start({source:'broken',target:'other',sourceCredentials:{},targetCredentials:{},symbol:'BTCUSDT',quantity:1,price:10,
    targetSide:'BUY',leverage:2,margin:5,sourceRules:{tickSize:.001},targetRules:{tickSize:.001},protectionMoveRatio:.05,
    dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  await assert.rejects(unsafe.ensureProtection(),/не покрывает весь объём/);
  assert.notEqual(unsafe.run.serverProtected,true);
});

test('price rounding can only preserve or enlarge the stop safety reserve',()=>{
  const long=bracketForSide({side:'BUY',referencePrice:100,moveRatio:.01001,tickSize:.1});
  const short=bracketForSide({side:'SELL',referencePrice:100,moveRatio:.01001,tickSize:.1});
  assert.deepEqual(long,{takeProfitPrice:101.1,stopLossPrice:99,triggerPriceType:'mark',clientOrderId:undefined});
  assert.deepEqual(short,{takeProfitPrice:98.9,stopLossPrice:101,triggerPriceType:'mark',clientOrderId:undefined});
});

test('an unknown protection acknowledgement is reconciled without a duplicate write',async()=>{
  const source=venue('source'),target=venue('target');let writes=0;
  source.placeProtection=async(_credentials,protection)=>{
    writes++;source.protections.set(protection.clientOrderId,{...protection,orderId:'accepted-protection',status:'ACTIVE'});
    throw new Error('connection lost after dispatch');
  };
  const engine=new HedgeEngine({sourceAdapter:source,targetAdapter:target,sleep:async()=>{}});
  await engine.start({source:'source',target:'target',sourceCredentials:{},targetCredentials:{},symbol:'BTCUSDT',quantity:1,price:10,
    targetSide:'BUY',leverage:2,margin:5,sourceRules:{tickSize:.001},targetRules:{tickSize:.001},protectionMoveRatio:.05,
    dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  await engine.ensureProtection();await engine.ensureProtection();
  assert.equal(writes,1);assert.equal(engine.run.serverProtected,true);
});
