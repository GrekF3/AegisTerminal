const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {LBankBrowser}=require('./lbank-browser.cjs');
const {HedgeEngine}=require('../trading/hedge-engine.cjs');
const {AdaptiveHedgeEngine}=require('../trading/adaptive-hedge-engine.cjs');
const {ContinuousHedgeSession}=require('../trading/continuous-session.cjs');
const {venue}=require('../trading/fixtures.cjs');
const credentials={connectionMode:'undetectable',undetectableProfileId:'fixture'};
function fixture({ clock, orderObserver = true } = {}) {
  const state={writes:[],reads:[],owner:'PRIVATE_ACCOUNT',marginMode:'isolated',leverage:3,positions:[],orders:[],protections:[],history:[],next:203224940138643900n,placement:null};
  const methods={};
  function method(path,fn) {const wrapped=async p=>{state.reads.push(path);return fn(p);};wrapped.toString=()=>`function(p){return read(${JSON.stringify(path)},{...p})}`;methods[path]=wrapped;return wrapped;}
  const account=method('/cfd/query/v1.0/Account',()=>{if(state.accountError)throw state.accountError;return {data:[{Currency:'USDT',AccountID:state.owner,MemberID:'PRIVATE_MEMBER',Available:'1000',Balance:'1200'}]};});
  method('/cfd/query/v1.0/Position',()=>state.positions);
  method('/cfd/query/v1.0/Order',()=>({data:state.onReadOrders?state.onReadOrders():state.orders}));
  method('/cfd/query/v1.0/TriggerOrder',p=>({data:String(p.TriggerOrderType)==='12'?state.protections.filter(order=>String(order.TriggerStatus)!=='4'):[]}));
  method('/cfd/order/v1/historyAllOrderPage',p=>state.historyPage?state.historyPage(p):({resultList:state.history.map(row=>({...row,Volume:Number(row.Volume)*.001,VolumeTraded:Number(row.VolumeTraded)*.001})),hasNext:false,totalPages:1}));
  method('/cfd/query/v1.0/Trade',p=>state.tradePage?state.tradePage(p):({data:state.trades||[],totalSize:(state.trades||[]).length,totalPage:1}));
  method('/cfd/market/v1.0/SendQryMarketOrder',p=>state.depth?state.depth(p):[{data:{Direction:p.Direction,Price:p.Direction==='0'?'79999':'80001',Volume:'100'}}]);
  method('/cfd/query/v1.0/KLinelst',()=>[{BeginTime:Math.floor(Date.now()/86400000)*86400,OpenPrice:'79000'}]);
  method('/cfd/action/v1.0/SendQryLeverage',()=>({tradeUnitID:'PRIVATE_UNIT',isCrossMargin:state.marginMode==='isolated'?0:1,longLeverage:state.leverage,shortLeverage:state.leverage,longMaxLeverage:100,shortMaxLeverage:100}));
  const switchMargin=method('/cfd/action/v1.0/SendPositionAction',p=>{const wire={...p,ActionType:'4'};state.writes.push(['margin',wire]);if(!state.ignoreMarginSwitch)state.marginMode=wire.Amount==='0'?'isolated':'cross';return true;});
  switchMargin.toString=()=>`function(p){return read("/cfd/action/v1.0/SendPositionAction",{...p,ActionType:"4"})}`;
  method('/cfd/position/v1/setMultiLeverage',p=>{state.writes.push(['leverage',p]);state.leverage=p.longLeverage;return true;});
  method('/cfd/action/v1.0/SendOrderAction',p=>{state.writes.push(['cancel',p]);state.cancelOrderHook?.(p);if(state.cancelOrderError)throw state.cancelOrderError;const o=state.orders.find(o=>o.OrderSysID===p.OrderSysID);if(o){o.OrderStatus='6';state.history.push(o);state.orders=state.orders.filter(x=>x!==o);}return true;});
  method('/cfd/action/v1.0/SendTriggerOrderAction',p=>{state.writes.push(['cancelProtection',p]);if(state.cancelProtectionError)throw state.cancelProtectionError;const o=state.protections.find(o=>o.OrderSysID===p.OrderSysID);if(o)o.TriggerStatus='4';return true;});
  method('/cfd/cff/v1/SendOrderInsert',p=>{state.writes.push(['place',p]);if(state.placement)return state.placement(p);return [{data:{OrderSysID:String(state.next++)}}];});
  method('/cfd/cff/v1/SendTriggerOrderInsert',p=>{
    if(String(p.TriggerOrderType)==='1') {
      const id=String(state.next++);state.writes.push(['protect',p]);
      state.protections.push({...p,OrderSysID:id,TriggerStatus:'1'});
      return [{data:{TriggerOrderType:'1',OrderSysID:id}}];
    }
    state.writes.push(['place',p]);if(state.placement)return state.placement(p);return [{data:{OrderSysID:String(state.next++)}}];
  });
  const meta={instrument:{instrumentID:'BTCUSDT',baseCurrency:'BTC',clearCurrency:'USDT',exchangeID:'Exchange',isInverse:0,volumeMultiple:'.001',volumeTick:'1',minOrderVolume:'1',maxOrderVolume:'100000',minOrderCost:'1',priceTick:'.1'},marketData:{lastPrice:'80000',markedPrice:'80001',openPrice24:'79000'},fee:{makerOpenFeeRate:'.0002',takerOpenFeeRate:'.0006'},futuresInstrumentExtend:{tradeIsOpen:true,isOnlyClose:0}};
  const api={...methods,catalog:{cfdAggV1Instrument:async()=>{state.reads.push('catalog');return state.catalog||[meta];}}};
  const eventListeners=new Set();
  const observer={observeMessage:callback=>{eventListeners.add(callback);return()=>eventListeners.delete(callback);}};
  state.emitOrder=row=>{for(const callback of eventListeners)callback({topic:12,type:4,data:[row]});};
  const require=id=>String(id)==='2'?{A:observer}:api;
  require.m={1:()=>'/cfd/query/v1.0/Account /cfd/cff/v1/SendOrderInsert',2:()=>'observeMessage WS_MESSAGES_PARSED_BATCH'};
  if(!orderObserver)delete require.m[2];
  const chunks=[];chunks.push=c=>c[2](require);
  const PageDate=clock?class extends Date{static now(){return clock.now;}}:Date;
  const context=vm.createContext({location:{origin:'https://www.lbank.com',pathname:'/futures/btcusdt'},self:{webpackChunk_N_E:chunks},crypto:webcrypto,TextEncoder,Uint8Array,Date:PageDate,Math});
  // Adapter tests mock the transport; the actual queue and WebSocket protocol
  // have separate clock/socket tests and a real public-stream smoke check.
  context.self[Symbol.for('hedge.lbank.http-queue.v1')]={epoch:()=>0,cancel:()=>{},run:async(fn,options)=>{options.check?.();return fn();}};
  const depth=()=>{
    const sides=['0','1'].map(Direction=>state.depth?state.depth({Direction}):[{data:{Direction,Price:Direction==='0'?'79999':'80001',Volume:'100'}}]);
    const convert=list=>list.map(item=>({price:Number((item.data||item).Price),quantity:Number((item.data||item).Volume)*Number(meta.instrument.volumeMultiple)}));
    return {symbol:'BTCUSDT',bids:convert(sides[0]),asks:convert(sides[1]),receivedAt:PageDate.now()};
  };
  context.self[Symbol.for('hedge.lbank.public-stream.v1')]={depth:async()=>depth(),peekDepth:()=>depth(),markets:async symbols=>symbols.map(symbol=>({symbol,lastPrice:Number(meta.marketData.lastPrice),markPrice:Number(meta.marketData.markedPrice)})),dayOpen:async()=>({time:Math.floor(PageDate.now()/86400000)*86400000,open:79000})};
  const browser=new LBankBrowser();browser.connection={closed:false,close(){this.closed=true;},send:async(method,p)=>({result:{value:await vm.runInContext(p.expression,context)}})};
  browser.key=browser.configKey(credentials);browser.sessionId='test-session';
  return {state,browser,api,meta,context,account,eventListeners};
}
const request={symbol:'BTCUSDT',side:'BUY',type:'LIMIT',quantity:.002,price:80000,leverage:3,clientOrderId:'test-order'};
const live={allowLiveTrading:true};

test('isolated is the default and LBank confirms a margin switch before configuring leverage',async()=>{
  const {browser,state}=fixture();await browser.getAccount(credentials);state.marginMode='cross';
  const result=await browser.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:3},live);
  assert.equal(result.marginMode,'isolated');assert.equal(state.marginMode,'isolated');
  assert.equal(state.writes[0][0],'margin');
  assert.deepEqual(state.writes[0][1],{ExchangeID:'Exchange',InstrumentID:'BTCUSDT',Amount:'0',ActionType:'4'});
  assert.equal(state.writes.filter(w=>w[0]==='place').length,0);
});
test('unconfirmed LBank margin and changes before entry block all order writes',async()=>{
  const {browser,state}=fixture();await browser.getAccount(credentials);state.marginMode='cross';state.ignoreMarginSwitch=true;
  await assert.rejects(browser.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:3},live),/режим маржи не подтверждён/);
  await assert.rejects(browser.placeOrder(credentials,request,live),e=>e.definitive===true&&/режим маржи/.test(e.message));
  assert.equal(state.writes.filter(w=>w[0]==='place').length,0);
});
test('LBank never changes the margin mode of an existing position',async()=>{
  const {browser,state}=fixture();await browser.getAccount(credentials);state.marginMode='cross';state.positions=[{InstrumentID:'BTCUSDT',Position:'1'}];
  await assert.rejects(browser.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:3},live),/маржу открытой позиции/);
  assert.equal(state.writes.length,0);
});
test('an explicit cross choice reaches LBank configuration and entry unchanged',async()=>{
  const {browser,state}=fixture();await browser.getAccount(credentials);
  await browser.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:3,marginMode:'cross'},live);
  assert.equal(state.marginMode,'cross');
  assert.deepEqual(state.writes[0][1],{ExchangeID:'Exchange',InstrumentID:'BTCUSDT',Amount:'1',ActionType:'4'});
  await browser.placeOrder(credentials,{...request,marginMode:'cross'},live);
  assert.equal(state.writes.filter(w=>w[0]==='place').length,1);
});

test('healthy WebSocket depth and day-open never use the HTTP market endpoints',async()=>{
  const {browser:b,state}=fixture();await b.getDepth('BTCUSDT',25,credentials);await b.getDayOpen('BTCUSDT',credentials);await b.getMarkets(credentials);
  assert.equal(state.reads.some(path=>path.includes('SendQryMarketOrder')||path.includes('KLinelst')),false);
});
test('lost WebSocket uses one shared HTTP reserve book for concurrent consumers',async()=>{
  const {browser:b,state,context}=fixture();const stream=context.self[Symbol.for('hedge.lbank.public-stream.v1')];
  stream.depth=async()=>{throw Object.assign(new Error('stream down'),{code:'MARKET_STREAM_PENDING'});};
  const books=await Promise.all([b.getDepth('BTCUSDT',25,credentials),b.getDepth('BTCUSDT',25,credentials)]);
  assert.equal(books[0].transport,'http-fallback');assert.equal(books[0].bids[0].price,79999);
  assert.equal(state.reads.filter(path=>path.includes('SendQryMarketOrder')).length,2);
});
test('actual SDK HTTP calls share the real limiter across account, rules, orders and positions',async()=>{
  const clock={now:100000}, {browser:b,state,context}=fixture({clock});
  delete context.self[Symbol.for('hedge.lbank.http-queue.v1')];
  context.setTimeout=(resolve,ms)=>{clock.now+=ms;queueMicrotask(resolve);};
  vm.runInContext(`(${require('./lbank-request-queue.cjs').installLBankRequestQueue})()`,context);
  const times=[],push=state.reads.push.bind(state.reads);state.reads.push=(...rows)=>{times.push(clock.now);return push(...rows);};
  await b.getAccount(credentials);
  await Promise.all([b.getPositions(credentials),b.getOpenOrders(credentials),b.getTradingRules('BTCUSDT',credentials)]);
  assert.ok(times.length>=5);
  for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=1000,`request gap ${times[i]-times[i-1]}`);
});

test('observed BTC terminal stream receipt confirms the exact fill while REST lists and history lag',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);meta.instrument.volumeMultiple='1';
  const order={symbol:'BTCUSDT',orderId:'1008009397092400',quantity:.0025,side:'BUY'};
  state.emitOrder({orderSysID:order.orderId,instrumentID:order.symbol,volume:.0025,volumeTraded:.0025,orderStatus:'1',direction:'0',tradePrice:79175.3});
  const before=state.reads.length;
  const result=await b.getOrder(credentials,order);
  assert.equal(result.status,'FILLED');assert.equal(result.executedQty,.0025);assert.equal(result.avgPrice,79175.3);
  assert.equal(result.confirmationSource,'private_stream');
  assert.equal(state.reads.slice(before).some(path=>path.endsWith('/Order')||path.endsWith('/Trade')||path.endsWith('/historyAllOrderPage')),false);
  state.emitOrder({orderSysID:order.orderId,instrumentID:order.symbol,volume:.0025,volumeTraded:0,orderStatus:'4',direction:'0'});
  assert.equal((await b.getOrder(credentials,order)).status,'FILLED');assert.equal(state.writes.length,0);
  await assert.rejects(b.getOrder(credentials,{...order,side:'SELL'}),error=>error.code==='ORDER_PENDING_HISTORY');
  await assert.rejects(b.getOrder(credentials,{...order,quantity:.005}),error=>error.code==='ORDER_PENDING_HISTORY');
});

test('an unavailable private stream blocks new LBank exposure before submission but permits explicit reduce-only cleanup',async()=>{
  const {browser:b,state}=fixture({orderObserver:false});await b.getAccount(credentials);
  await assert.rejects(b.placeOrder(credentials,request,live),error=>error.definitive&&error.code==='ORDER_EVENTS_UNAVAILABLE');
  assert.equal(state.writes.length,0);
  state.positions=[{InstrumentID:'BTCUSDT',Direction:'1',PosiDirection:'1',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT'}];
  await b.placeOrder(credentials,{...request,type:'MARKET',reduceOnly:true,clientOrderId:'explicit-close'},live);
  assert.equal(state.writes.length,1);assert.equal(state.writes[0][1].OffsetFlag,'1');
});

test('missing stream price cannot let stale or contradictory REST data erase a confirmed terminal quantity',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);meta.instrument.volumeMultiple='1';
  const order={symbol:'BTCUSDT',orderId:'terminal-no-price',quantity:.0025,side:'BUY'};
  const base={OrderSysID:order.orderId,InstrumentID:order.symbol,Volume:order.quantity,Direction:'0'};
  state.emitOrder({...base,OrderStatus:'1',VolumeTraded:order.quantity});
  state.orders=[{...base,OrderStatus:'6',VolumeTraded:0}];
  await assert.rejects(b.getOrder(credentials,order),error=>error.code==='ORDER_PENDING_HISTORY');
  state.orders=[{...base,OrderStatus:'4',VolumeTraded:0}];
  await assert.rejects(b.getOrder(credentials,order),error=>error.code==='ORDER_PENDING_HISTORY');
  state.trades=[{...base,TradeID:'confirmed-fill',Price:79175.3,Volume:order.quantity}];
  const result=await b.getOrder(credentials,order);
  assert.equal(result.status,'FILLED');assert.equal(result.executedQty,order.quantity);assert.equal(result.avgPrice,79175.3);
  assert.equal(state.writes.length,0);
});

test('private stream completes entry and close through the real adapter while every historical read stays empty',async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock});await b.getAccount(credentials);
  state.placement=payload=>{
    const id=String(state.next++), quantity=payload.Volume*.001;
    state.emitOrder({orderSysID:id,instrumentID:payload.InstrumentID,volume:quantity,volumeTraded:quantity,orderStatus:'1',direction:payload.Direction,tradePrice:80000});
    state.positions=payload.OffsetFlag==='1'?[]:[{InstrumentID:'BTCUSDT',Direction:payload.Direction,Position:payload.Volume,ClosePosition:payload.Volume,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000,Leverage:3}];
    return {orderSysID:id};
  };
  const adapter={supportsPostOnly:true};
  for(const method of ['placeOrder','getOrder','cancelOrder','getTradingRules','getDepth','getClosePlan'])adapter[method]=b[method].bind(b);
  const other=venue('other');other.supportsPostOnly=true;
  other.getDepth=async()=>({bids:[{price:79999,quantity:1}],asks:[{price:80001,quantity:1}]});
  other.getTradingRules=async()=>({quantityStep:.001,minQuantity:.001,minNotional:1,tickSize:.1});
  const engine=new AdaptiveHedgeEngine({sourceAdapter:adapter,targetAdapter:other,now:()=>clock.now,sleep:async ms=>{clock.now+=ms;}});
  await engine.start({source:'lbank',target:'other',sourceCredentials:credentials,targetCredentials:credentials,symbol:'BTCUSDT',quantity:.002,quantityStep:.001,price:80000,targetSide:'BUY',leverage:3,margin:54,dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  assert.equal(engine.state,'running');assert.equal(engine.run.hedgedQuantity,.002);
  await engine.stop('market');assert.equal(engine.run.closeStatus,'closed');assert.equal(engine.snapshot().active,false);
  assert.equal(state.writes.filter(([kind])=>kind==='place').length,2);
  assert.equal(state.writes.filter(([kind])=>kind==='cancel').length,0);
  assert.equal(state.history.length,0);assert.equal(state.orders.length,0);
  assert.equal(state.reads.some(path=>path.endsWith('/historyAllOrderPage')),false);
});

test('observed ETH order is confirmed by exact executions while order history is empty',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);
  state.catalog=[{...meta,instrument:{...meta.instrument,instrumentID:'ETHUSDT',volumeMultiple:'1',volumeTick:'.001'}}];
  const order={symbol:'ETHUSDT',orderId:'1008009351765676',quantity:.04,side:'BUY'};
  state.trades=[{OrderSysID:order.orderId,InstrumentID:'ETHUSDT',TradeID:'observed-eth-fill',Volume:.04,Price:2495.9,Direction:'0',Fee:.0199672}];
  const confirmed=await b.getOrder(credentials,order);
  assert.equal(confirmed.status,'FILLED');assert.equal(confirmed.executedQty,.04);assert.equal(confirmed.avgPrice,2495.9);
  assert.equal(confirmed.orderId,order.orderId);assert.equal(state.writes.length,0);
  assert.ok(state.reads.some(path=>path.endsWith('/Trade')));
});

test('execution fallback deduplicates exact trade IDs and does not guess partial, mismatched or incomplete fills',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);meta.instrument.volumeMultiple='1';
  const order={symbol:'BTCUSDT',orderId:'1008009351765676',quantity:2,side:'BUY'};
  const row={OrderSysID:order.orderId,InstrumentID:'BTCUSDT',TradeID:'t1',Volume:1,Price:80000,Direction:'0'};
  state.trades=[row,row,{...row,TradeID:'unrelated',OrderSysID:'other',Volume:2}];
  await assert.rejects(b.getOrder(credentials,order),e=>e.code==='ORDER_PENDING_HISTORY'&&e.orderId===order.orderId);
  state.trades=[row,{...row,TradeID:'other-symbol',InstrumentID:'ETHUSDT'}];
  await assert.rejects(b.getOrder(credentials,order),e=>e.code==='ORDER_PENDING_HISTORY');
  state.trades=[row,{...row,TradeID:'t2',Price:80002}];
  state.tradePage=()=>({data:state.trades,totalSize:3,totalPage:2});
  await assert.rejects(b.getOrder(credentials,order),e=>e.code==='ORDER_PENDING_HISTORY');
  state.tradePage=null;
  const confirmed=await b.getOrder(credentials,order);
  assert.equal(confirmed.status,'FILLED');assert.equal(confirmed.executedQty,2);assert.equal(confirmed.avgPrice,80001);
  assert.equal(state.writes.length,0);
});

test('execution fallback supplies exact average for a confirmed partial cancellation without promoting it to filled',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);meta.instrument.volumeMultiple='1';
  const order={symbol:'BTCUSDT',orderId:'partial-cancel',quantity:2,side:'BUY'};
  state.orders=[{InstrumentID:order.symbol,OrderSysID:order.orderId,OrderStatus:'3',Volume:2,VolumeTraded:1,Direction:'0'}];
  state.trades=[{InstrumentID:order.symbol,OrderSysID:order.orderId,TradeID:'t1',Volume:1,Price:80000,Direction:'0'}];
  const result=await b.getOrder(credentials,order);
  assert.equal(result.status,'CANCELED');assert.equal(result.executedQty,1);assert.equal(result.avgPrice,80000);
});

test('a delayed history source does not prevent an independent exact trade confirmation',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);meta.instrument.volumeMultiple='1';
  state.historyPage=()=>{throw new Error('History temporarily unavailable');};
  const order={symbol:'BTCUSDT',orderId:'history-outage',quantity:2};
  state.trades=[{InstrumentID:order.symbol,OrderSysID:order.orderId,TradeID:'t1',Volume:2,Price:80000}];
  assert.equal((await b.getOrder(credentials,order)).status,'FILLED');
  state.trades=[];
  await assert.rejects(b.getOrder(credentials,order),/History temporarily unavailable/);
});

test('history follows hasNext even when fake pagination totals are zero',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const pages=[];
  state.historyPage=p=>{pages.push(p.pageNo);return p.pageNo===1?{resultList:[{orderSysID:'unrelated'}],totalPages:0,hasNext:true}:{resultList:[{instrumentID:'BTCUSDT',orderSysID:'paged-fill',orderStatus:'1',volume:.002,volumeTraded:.002,tradePrice:80000}],totalPages:0,hasNext:false};};
  assert.equal((await b.getOrder(credentials,{symbol:'BTCUSDT',orderId:'paged-fill'})).executedQty,.002);
  assert.deepEqual(pages,[1,2]);
});

test('Post-Only preflight catches both crossing sides before write and does not change intended prices',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  for(const [side,price] of [['BUY',80001],['SELL',79999]]) {
    await assert.rejects(b.placeOrder(credentials,{...request,side,price,postOnly:true,clientOrderId:`cross-${side}`},live),e=>e.definitive===true&&e.code==='POST_ONLY_WOULD_TAKE');
  }
  assert.equal(state.writes.length,0);
  await b.placeOrder(credentials,{...request,price:79999,postOnly:true,clientOrderId:'fresh-maker'},live);
  assert.equal(state.writes[0][1].Price,79999);assert.equal(state.writes[0][1].OrderType,'3');
});

test('MARKET entry rechecks full zero-impact depth immediately before the LBank write',async()=>{
  const healthy=fixture();await healthy.browser.getAccount(credentials);
  await healthy.browser.placeOrder(credentials,{symbol:'BTCUSDT',side:'BUY',type:'MARKET',quantity:.002,leverage:3,marginMode:'isolated',
    maxEntrySlippageBps:0,depthSafetyMultiplier:2,clientOrderId:'depth-safe-market'},live);
  assert.equal(healthy.state.writes.filter(([kind])=>kind==='place').length,1);

  const thin=fixture();await thin.browser.getAccount(credentials);
  thin.state.depth=p=>[{data:{Direction:p.Direction,Price:p.Direction==='0'?'79999':'80001',Volume:'2'}}];
  await assert.rejects(thin.browser.placeOrder(credentials,{symbol:'BTCUSDT',side:'BUY',type:'MARKET',quantity:.002,leverage:3,marginMode:'isolated',
    maxEntrySlippageBps:0,depthSafetyMultiplier:2,clientOrderId:'thin-market'},live),error=>error.definitive===true&&error.code==='ENTRY_DEPTH_CHANGED');
  assert.equal(thin.state.writes.filter(([kind])=>kind==='place').length,0);
});

test('LBank position protection is a verified full-volume mark-price TP/SL and cancels by exact ID',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  state.positions=[{InstrumentID:'BTCUSDT',Direction:'0',PosiDirection:'2',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000}];
  const request={symbol:'BTCUSDT',quantity:.002,side:'BUY',takeProfitPrice:80800,stopLossPrice:79200,clientOrderId:'protect-btc',marginMode:'isolated'};
  const placed=await b.placeProtection(credentials,request,live);
  const payload=state.writes.find(([type])=>type==='protect')[1];
  assert.deepEqual({Direction:payload.Direction,PosiDirection:payload.PosiDirection,OffsetFlag:payload.OffsetFlag,TriggerOrderType:payload.TriggerOrderType,Volume:payload.Volume},
    {Direction:'1',PosiDirection:'2',OffsetFlag:'8',TriggerOrderType:'1',Volume:2});
  assert.equal(payload.TPTriggerPriceType,'1');assert.equal(payload.SLTriggerPriceType,'1');
  const verified=await b.getProtection(credentials,{...request,orderId:placed.orderId});
  assert.equal(verified.status,'ACTIVE');assert.equal(verified.quantity,.002);assert.equal(verified.takeProfitPrice,80800);assert.equal(verified.stopLossPrice,79200);
  await b.cancelProtection(credentials,{...request,orderId:placed.orderId},live);
  assert.equal(state.writes.at(-1)[0],'cancelProtection');assert.equal(state.writes.at(-1)[1].ActionFlag,'1');
  await assert.rejects(b.getProtection(credentials,{...request,orderId:placed.orderId}),error=>error.code==='PROTECTION_NOT_FOUND');
});

test('LBank code 24 while canceling an already absent protection is definitive and idempotent',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  state.cancelProtectionError=Object.assign(new Error('Order does not exist'),{code:24});
  await assert.rejects(
    b.cancelProtection(credentials,{symbol:'BTCUSDT',orderId:'203224940138643900',clientOrderId:'missing-guard'},live),
    error=>error.code==='PROTECTION_NOT_FOUND'&&error.definitive===true&&/\[24\]/.test(error.message),
  );
  assert.equal(state.writes.filter(([kind])=>kind==='cancelProtection').length,1);
});

test('LBank code 24 during entry cancel recovers an exact race fill without a second write',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);meta.instrument.volumeMultiple='1';
  const order={symbol:'BTCUSDT',orderId:'1008017105720258',quantity:2,side:'SELL'};
  state.orders=[{OrderSysID:order.orderId,InstrumentID:order.symbol,OrderStatus:'4',Volume:2,VolumeTraded:0,Direction:'1'}];
  state.cancelOrderHook=()=>{
    state.orders=[];
    state.emitOrder({orderSysID:order.orderId,instrumentID:order.symbol,orderStatus:'1',volume:2,volumeTraded:2,direction:'1',tradePrice:80000});
  };
  state.cancelOrderError=Object.assign(new Error('Order does not exist'),{code:24});
  const recovered=await b.cancelOrder(credentials,order,live);
  assert.equal(recovered.status,'FILLED');assert.equal(recovered.executedQty,2);assert.equal(recovered.avgPrice,80000);
  assert.equal(state.writes.filter(([kind])=>kind==='cancel').length,1);
});

test('captured BTC units and LBank close/TPSL enums remain exact at the SDK boundary',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);
  Object.assign(meta.instrument,{volumeMultiple:'1',volumeTick:'.0001',minOrderVolume:'.0001',maxOrderVolume:'60',minOrderCost:'1',priceTick:'.1'});
  await b.placeOrder(credentials,{symbol:'BTCUSDT',side:'BUY',type:'LIMIT',quantity:.0008,price:66666,leverage:3,postOnly:true,clientOrderId:'observed-btc-maker'},live);
  const maker=state.writes.find(([kind])=>kind==='place')[1];
  assert.deepEqual({Direction:maker.Direction,OffsetFlag:maker.OffsetFlag,OrderPriceType:maker.OrderPriceType,OrderType:maker.OrderType,Volume:maker.Volume,Price:maker.Price},
    {Direction:'0',OffsetFlag:'0',OrderPriceType:'0',OrderType:'3',Volume:.0008,Price:66666});

  state.positions=[{InstrumentID:'BTCUSDT',Direction:'0',PosiDirection:'0',Position:.0001,ClosePosition:.0001,TradeUnitID:'PRIVATE_UNIT',OpenPrice:77338.6}];
  await b.placeProtection(credentials,{symbol:'BTCUSDT',quantity:.0001,side:'BUY',takeProfitPrice:77400,stopLossPrice:77200,clientOrderId:'observed-btc-protection'},live);
  const protection=state.writes.find(([kind])=>kind==='protect')[1];
  assert.deepEqual({Direction:protection.Direction,PosiDirection:protection.PosiDirection,OffsetFlag:protection.OffsetFlag,TriggerOrderType:protection.TriggerOrderType,Volume:protection.Volume,TPTriggerPriceType:protection.TPTriggerPriceType,SLTriggerPriceType:protection.SLTriggerPriceType},
    {Direction:'1',PosiDirection:'0',OffsetFlag:'8',TriggerOrderType:'1',Volume:.0001,TPTriggerPriceType:'1',SLTriggerPriceType:'1'});

  await b.placeOrder(credentials,{symbol:'BTCUSDT',side:'SELL',type:'MARKET',quantity:.0001,reduceOnly:true,positionId:(await b.getPositions(credentials))[0].id,clientOrderId:'observed-btc-close'},live);
  const close=state.writes.filter(([kind])=>kind==='place').at(-1)[1];
  assert.deepEqual({Direction:close.Direction,PosiDirection:close.PosiDirection,OffsetFlag:close.OffsetFlag,OrderPriceType:close.OrderPriceType,OrderType:close.OrderType,Volume:close.Volume},
    {Direction:'1',PosiDirection:'0',OffsetFlag:'1',OrderPriceType:'4',OrderType:'1',Volume:.0001});
});

test('unknown or missing LBank trigger status can never be promoted to ACTIVE',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const base={InstrumentID:'BTCUSDT',Direction:'1',Volume:2,TPTriggerPrice:80800,SLTriggerPrice:79200,OrderSysID:'trigger-status'};
  for(const [raw,status] of [['0','PENDING'],['1','ACTIVE'],['2','TRIGGERED'],['3','FAILED']]) {
    state.protections=[{...base,TriggerStatus:raw}];
    assert.equal((await b.getProtection(credentials,{symbol:'BTCUSDT',orderId:base.OrderSysID})).status,status);
  }
  state.protections=[{...base,TriggerStatus:'99'}];
  await assert.rejects(b.getProtection(credentials,{symbol:'BTCUSDT',orderId:base.OrderSysID}),/неизвестный статус/);
  state.protections=[base];
  await assert.rejects(b.getProtection(credentials,{symbol:'BTCUSDT',orderId:base.OrderSysID}),/не содержит статус/);
});

test('observed LBank code 31 becomes NO_POSITION but only a fresh position snapshot may close the journal',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  state.positions=[{InstrumentID:'BTCUSDT',Direction:'0',PosiDirection:'0',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT'}];
  state.placement=()=>{state.positions=[];throw Object.assign(new Error('Close position failed, amount exceeds available amount for closing.'),{code:31});};
  await assert.rejects(b.placeOrder(credentials,{...request,side:'SELL',type:'MARKET',reduceOnly:true,clientOrderId:'close-code-31'},live),error=>
    error.code==='NO_POSITION'&&error.exchangeCode==='31'&&error.definitive===true);
  assert.equal(state.writes.filter(([kind])=>kind==='place').length,1);
  assert.equal((await b.getPositions(credentials)).length,0);
});

test('exchange maker races 187 and 188 are definitive repricing outcomes, and ambiguous transport is never retried',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  for(const code of [187,188]) {
    state.placement=()=>{throw Object.assign(new Error('Price exceeds sell one price'),{code});};
    const maker={...request,postOnly:true,clientOrderId:`maker-race-${code}`};
    await assert.rejects(b.placeOrder(credentials,maker,live),e=>e.code==='POST_ONLY_WOULD_TAKE'&&e.definitive===true);
    await assert.rejects(b.placeOrder(credentials,maker,live));
  }
  assert.equal(state.writes.length,2,'identical intentions never dispatch twice');
  state.placement=()=>{throw new Error('Price exceeds sell one price - connection lost');};
  await assert.rejects(b.placeOrder(credentials,{...request,postOnly:true,clientOrderId:'unknown'},live),e=>e.definitive===false&&e.code!=='POST_ONLY_WOULD_TAKE');
  assert.equal(state.writes.length,3);
});

test('close plan allocates multiple own positions, ignores copy/empty rows and binds exact position selectors',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const own={InstrumentID:'BTCUSDT',Direction:'0',PosiDirection:'2',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000,CopyMemberID:'0'};
  state.positions=[{...own,PositionID:'first'},{...own,PositionID:'second',TradeUnitID:'PRIVATE_SECOND_UNIT',Position:3,ClosePosition:1},{...own,PositionID:'copy',TradeUnitID:'PRIVATE_COPY_UNIT',CopyMemberID:'PRIVATE_COPY'},{...own,PositionID:'empty',Position:0,ClosePosition:0}];
  const positions=await b.getPositions(credentials);
  assert.equal(positions[0].isOwn,true);assert.equal(positions[2].isOwn,false);assert.equal(positions[1].closeQuantity,.001);
  assert.notEqual(positions[0].id,positions[1].id);assert.equal(JSON.stringify(positions).includes('PRIVATE'),false);
  const plan=await b.getClosePlan(credentials,{symbol:'BTCUSDT',side:'SELL',quantity:.003});
  assert.deepEqual(JSON.parse(JSON.stringify(plan)),[{positionId:positions[0].id,quantity:.002},{positionId:positions[1].id,quantity:.001}]);
  const leverageReads=state.reads.filter(path=>path.endsWith('/SendQryLeverage')).length;
  for(const [index,part] of plan.entries()) await b.placeOrder(credentials,{...request,...part,side:'SELL',type:'MARKET',reduceOnly:true,clientOrderId:`close-part-${index}`},live);
  assert.deepEqual(state.writes.map(([,p])=>p.Volume),[2,1]);
  assert.ok(state.writes.every(([,p])=>p.OffsetFlag==='1'&&p.PosiDirection==='2'));
  assert.equal(state.reads.filter(path=>path.endsWith('/SendQryLeverage')).length,leverageReads,'exact position close does not depend on open-order leverage lookup');
});

test('close planning fails before writes on missing capacity and rechecks capacity after a plan',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const own={InstrumentID:'BTCUSDT',Direction:'0',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT',PositionID:'position'};
  state.positions=[own];
  const plan=await b.getClosePlan(credentials,{symbol:'BTCUSDT',side:'SELL',quantity:.002});
  state.positions=[{...own,ClosePosition:1}];
  await assert.rejects(b.getClosePlan(credentials,{symbol:'BTCUSDT',side:'SELL',quantity:.002}),/занята другими заявками/);
  await assert.rejects(b.placeOrder(credentials,{...request,...plan[0],side:'SELL',type:'MARKET',reduceOnly:true,clientOrderId:'stale-plan'},live),e=>e.definitive===true&&/доступного объёма/.test(e.message));
  assert.equal(state.writes.length,0);
});

test('a zero or copy position beside the exact own row does not prevent a close',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const own={InstrumentID:'BTCUSDT',Direction:'0',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT'};
  state.positions=[own,{...own,Position:0,ClosePosition:0},{...own,TradeUnitID:'COPY_UNIT',CopyMemberID:'copy'}];
  await b.placeOrder(credentials,{...request,side:'SELL',type:'MARKET',reduceOnly:true},live);
  assert.equal(state.writes.length,1);assert.equal(state.writes[0][1].Volume,2);
});

test('different position IDs sharing the same close wire route cannot be used as false exact selectors',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const own={InstrumentID:'BTCUSDT',Direction:'0',PosiDirection:'2',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_UNIT'};
  state.positions=[{...own,PositionID:'first'},{...own,PositionID:'second'}];
  const positions=await b.getPositions(credentials);
  await assert.rejects(b.getClosePlan(credentials,{symbol:'BTCUSDT',side:'SELL',quantity:.002}),/одним счётом закрытия/);
  await assert.rejects(b.placeOrder(credentials,{...request,positionId:positions[0].id,side:'SELL',type:'MARKET',reduceOnly:true},live),e=>e.definitive===true&&/счёт закрытия неоднозначен/.test(e.message));
  assert.equal(state.writes.length,0);
});

test('observed LBank filled close and canceled ETH history are already in base units',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);
  state.catalog=[meta,{...meta,instrument:{...meta.instrument,instrumentID:'ETHUSDT',volumeMultiple:'.01'}}];
  state.historyPage=()=>({hasNext:false,totalPages:1,resultList:[
    {instrumentID:'BTCUSDT',orderSysID:'1008009336339177',orderStatus:'1',volume:'0.0062',volumeTraded:'0.0062',tradePrice:'79584.9'},
    {instrumentID:'ETHUSDT',orderSysID:'1008009337950148',orderStatus:'6',volume:'0.079',volumeTraded:'0',tradePrice:'0'},
  ]});
  const btc=await b.getOrder(credentials,{symbol:'BTCUSDT',orderId:'1008009336339177'});
  assert.equal(btc.status,'FILLED');assert.equal(btc.executedQty,.0062);assert.equal(btc.avgPrice,79584.9);
  const eth=await b.getOrder(credentials,{symbol:'ETHUSDT',orderId:'1008009337950148'});
  assert.equal(eth.status,'CANCELED');assert.equal(eth.quantity,.079);assert.equal(eth.executedQty,0);
  await b.cancelOrder(credentials,{symbol:'BTCUSDT',orderId:btc.orderId},live);
  await b.cancelOrder(credentials,{symbol:'ETHUSDT',orderId:eth.orderId},live);
  assert.equal(state.writes.length,0,'terminal history must not send cancellations');
});

test('three-coin LBank session keeps every position and closes all owned coins exactly once',async()=>{
  const {browser:b,state,meta}=fixture();await b.getAccount(credentials);
  const symbols=['BTCUSDT','ETHUSDT','BNBUSDT'];
  state.catalog=symbols.map(symbol=>({...meta,instrument:{...meta.instrument,instrumentID:symbol}}));
  state.placement=p=>{
    const id=String(state.next++);
    state.history.push({InstrumentID:p.InstrumentID,OrderSysID:id,OrderStatus:'1',Volume:p.Volume,VolumeTraded:p.Volume,TradePrice:80000,Direction:p.Direction});
    state.positions=state.positions.filter(position=>position.InstrumentID!==p.InstrumentID);
    if(p.OffsetFlag==='0')state.positions.push({InstrumentID:p.InstrumentID,Direction:p.Direction,PosiDirection:p.Direction==='0'?'2':'3',Position:p.Volume,ClosePosition:p.Volume,TradeUnitID:`PRIVATE_${p.InstrumentID}`,OpenPrice:80000,Leverage:3});
    return {orderSysID:id};
  };
  const source={supportsPostOnly:true,supportsNativeProtection:true};
  for(const method of ['getAccount','getPositions','getOpenOrders','getFeeRates','getTradingRules','getDepth','getDayOpen','configureLeverage','placeOrder','getOrder','cancelOrder','placeProtection','getProtection','cancelProtection'])source[method]=b[method].bind(b);
  const target=venue('other');target.supportsPostOnly=true;
  target.getDepth=async()=>({bids:[{price:79999,quantity:100}],asks:[{price:80001,quantity:100}]});
  target.getDayOpen=async()=>({time:Math.floor(Date.now()/86400000)*86400000,open:79000});
  target.getTradingRules=async()=>({quantityStep:.001,minQuantity:.001,minNotional:1,tickSize:.1,maxLeverage:100});
  const read=target.getOrder;target.getOrder=async(...args)=>({...await read(...args),avgPrice:80000});
  const session=new ContinuousHedgeSession({sourceAdapter:source,targetAdapter:target,autoSchedule:false,sleep:async()=>{}});
  session.start({source:'lbank',target:'other',sourceCredentials:credentials,targetCredentials:{},symbols,totalMargin:180,leverage:3,hedgePercent:95,maxLosses:5,dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  for(const symbol of symbols) {
    await session.tick();await session.entryPromise;
    assert.equal(session.engines.at(-1).run.symbol,symbol);assert.equal(session.engines.at(-1).state,'running',session.state.error);
    assert.equal(state.positions.length,session.engines.length);
  }
  assert.equal((await b.getPositions(credentials)).length,3);
  assert.equal(await session.monitorOnce(),true);assert.equal(session.state.requiresAttention,false);
  const positions=target.getPositions;
  target.getPositions=async()=> (await positions()).map(p=>({...p,unrealizedPnl:p.symbol==='ETHUSDT'?60:0}));
  await session.monitorOnce();
  assert.deepEqual(state.positions.map(p=>p.InstrumentID).sort(),['BNBUSDT','BTCUSDT']);
  assert.deepEqual(session.engines.map(e=>e.run.symbol).sort(),['BNBUSDT','BTCUSDT']);
  assert.equal(session.state.completedRounds,1);
  target.getPositions=positions;
  await session.tick();await session.entryPromise;
  assert.equal(session.engines.length,3);assert.equal(state.positions.length,3);
  await session.stop('market');
  assert.equal(session.state.state,'stopped',session.state.error);assert.equal(state.positions.length,0);
  assert.equal((await target.getPositions()).length,0);
  const writes=state.writes.filter(([type])=>type==='place').map(([,p])=>p);
  for(const symbol of symbols)assert.deepEqual(writes.filter(p=>p.InstrumentID===symbol).map(p=>p.OffsetFlag),symbol==='ETHUSDT'?['0','1','0','1']:['0','1']);
  assert.equal(new Set(session.engines.flatMap(e=>e.orders().map(o=>o.clientOrderId))).size,12);
});

test('lost CDP acknowledgement reads the retained receipt and never repeats place',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const original=b.connection.send;let drop=true,lookups=0;
  b.connection.send=async(method,p)=>{
    const result=await original(method,p);
    if(p.expression.includes('function peekFuturesReceipt')) lookups++;
    if(drop && p.expression.includes('},"place:test-order")')) { drop=false;throw new Error('CDP Runtime.evaluate [-32000]: promise_collected'); }
    return result;
  };
  const ack=await b.placeOrder(credentials,request,live);
  assert.equal(drop,false);assert.equal(lookups,1);assert.equal(state.writes.length,1);
  assert.equal(ack.orderId,'203224940138643900');
  assert.equal((await b.placeOrder(credentials,request,live)).orderId,ack.orderId);
  assert.equal(state.writes.length,1);
});

test('lost preflight rejection is recovered as definitive with no order sent',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const original=b.connection.send;let drop=true;
  b.connection.send=async(method,p)=>{
    const result=await original(method,p);
    if(drop && p.expression.includes('},"place:bad-volume")')) {drop=false;throw new Error('Lost CDP reply');}
    return result;
  };
  await assert.rejects(b.placeOrder(credentials,{...request,quantity:.0015,clientOrderId:'bad-volume'},live),e=>e.definitive===true && /шагу/.test(e.message));
  assert.equal(drop,false);assert.equal(state.writes.length,0);
});

test('context loss cannot turn a missing receipt into a repeated write or a guessed rejection',async()=>{
  const {browser:b,state,context}=fixture();await b.getAccount(credentials);
  const original=b.connection.send;let drop=true;
  b.connection.send=async(method,p)=>{
    const result=await original(method,p);
    if(drop && p.expression.includes('},"place:test-order")')) {
      drop=false;vm.runInContext("delete self[Symbol.for('hedge.lbank.receipts.v1')]",context);
      throw new Error('Context lost');
    }
    return result;
  };
  await assert.rejects(b.placeOrder(credentials,request,live),e=>e.definitive!==true && /Context lost/.test(e.message));
  await assert.rejects(b.placeOrder(credentials,request,live));
  await assert.rejects(b.getOrder(credentials,request),/не подтверждён/);
  assert.equal(state.writes.length,1);
});

test('later reconciliation recovers exact order ID after both initial acknowledgement and receipt read failed',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const original=b.connection.send;
  state.placement=p=>{
    const id=String(state.next++);
    state.orders=[{OrderSysID:id,InstrumentID:'BTCUSDT',Volume:p.Volume,VolumeTraded:0,OrderStatus:'4',Direction:'0'}];
    return {orderSysID:id};
  };
  b.connection.send=async(method,p)=>{await original(method,p);throw new Error('Transient transport failure');};
  await assert.rejects(b.placeOrder(credentials,request,live),/transport/);
  b.connection.send=original;
  await assert.rejects(b.getOrder(credentials,{...request,symbol:'ETHUSDT'}),/исходного запроса/);
  const adapter={getOrder:b.getOrder.bind(b)},engine=new HedgeEngine({sourceAdapter:adapter,targetAdapter:venue('other'),sleep:async()=>{}});
  const order={...request,leg:'source',status:'UNKNOWN',executedQuantity:0};
  engine.config={symbol:'BTCUSDT',sourceCredentials:credentials};engine.run={sourceOrders:[order],closeOrders:[]};
  await engine.readOrder(order);
  assert.equal(order.orderId,'203224940138643900');assert.equal(order.status,'NEW');
  await b.cancelOrder(credentials,order,live);
  assert.equal(state.writes.filter(x=>x[0]==='place').length,1);
  assert.equal(state.writes.find(x=>x[0]==='cancel')[1].OrderSysID,order.orderId);
});

for(const lbankLeg of ['source','target']) test(`adaptive hedge uses LBank Post-Only as ${lbankLeg}, preserves exact contract units and closes via the SDK (fixture only)`,async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock}); await b.getAccount(credentials);
  state.placement=p=>{
    const id=String(state.next++);
    state.history.push({InstrumentID:p.InstrumentID,OrderSysID:id,OrderStatus:'1',Volume:p.Volume,VolumeTraded:p.Volume,TradePrice:80000,Direction:p.Direction});
    state.positions=p.OffsetFlag==='1'?[]:[{InstrumentID:'BTCUSDT',Direction:p.Direction,Position:p.Volume,ClosePosition:p.Volume,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000,Leverage:3}];
    return {orderSysID:id};
  };
  const adapter={supportsPostOnly:true};
  for(const method of ['placeOrder','getOrder','cancelOrder','getTradingRules','getDepth']) adapter[method]=b[method].bind(b);
  const other=venue('other'); other.supportsPostOnly=true;
  other.getDepth=async()=>({bids:[{price:79999,quantity:1}],asks:[{price:80001,quantity:1}]});
  other.getTradingRules=async()=>({quantityStep:.001,minQuantity:.001,minNotional:1,tickSize:.1});
  const engine=new AdaptiveHedgeEngine({sourceAdapter:lbankLeg==='source'?adapter:other,targetAdapter:lbankLeg==='target'?adapter:other,now:()=>clock.now,sleep:async ms=>{clock.now+=ms;}});
  await engine.start({source:lbankLeg==='source'?'lbank':'other',target:lbankLeg==='target'?'lbank':'other',sourceCredentials:credentials,targetCredentials:credentials,symbol:'BTCUSDT',quantity:.002,quantityStep:.001,price:80000,targetSide:'BUY',leverage:3,margin:54,dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  assert.equal(engine.state,'running'); assert.equal(engine.run.hedgedQuantity,.002);
  assert.equal(state.writes[0][1].OrderType,'3'); assert.equal(state.writes[0][1].Volume,2);
  assert.equal(state.writes[0][1].Direction,lbankLeg==='source'?'1':'0');
  assert.equal(state.writes[0][1].Price,lbankLeg==='source'?80001:79999);
  await engine.stop('market'); assert.equal(engine.state,'stopped');
  assert.equal(state.writes[1][1].OrderPriceType,'4'); assert.equal(state.writes[1][1].OffsetFlag,'1');
  assert.equal(state.writes[1][1].Direction,lbankLeg==='source'?'0':'1');
  assert.equal(state.writes[1][1].Volume,2);
});

test('Post-Only uses the verified ONLY_MAKER wire enum and rejects expired or market combinations',async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock}); await b.getAccount(credentials);
  await b.placeOrder(credentials,{...request,postOnly:true,expiresAt:clock.now+1500},live);
  assert.equal(state.writes[0][1].OrderType,'3'); assert.equal(state.writes[0][1].OrderPriceType,'0');
  assert.equal('expiresAt' in state.writes[0][1],false);
  await assert.rejects(b.placeOrder(credentials,{...request,postOnly:true,expiresAt:clock.now-1,clientOrderId:'expired'},live),e=>e.definitive===true && /устарели/.test(e.message));
  await assert.rejects(b.placeOrder(credentials,{...request,postOnly:true,type:'MARKET',clientOrderId:'invalid-post'},live),/Post-Only/);
  assert.equal(state.writes.length,1);
});

test('Post-Only expiry is checked again after the final book read and before the write',async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock}); await b.getAccount(credentials);
  state.depth=p=>{
    clock.now+=60;
    return [{data:{Direction:p.Direction,Price:p.Direction==='0'?'79999':'80001',Volume:'100'}}];
  };
  await assert.rejects(
    b.placeOrder(credentials,{...request,postOnly:true,expiresAt:clock.now+100,clientOrderId:'expired-after-book'},live),
    error=>error.definitive===true && /устарели/.test(error.message),
  );
  assert.equal(state.writes.filter(row=>row[0]==='place').length,0);
});

test('feed, preview and positions share one account read per fresh snapshot',async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock});
  await Promise.all([b.getAccount(credentials),b.getPositions(credentials),b.getOpenOrders(credentials)]);
  assert.equal(state.reads.filter(p=>p.endsWith('/Account')).length,1);
  await b.getAccount(credentials);
  assert.equal(state.reads.filter(p=>p.endsWith('/Account')).length,1);
  clock.now+=901;
  await b.getAccount(credentials);
  assert.equal(state.reads.filter(p=>p.endsWith('/Account')).length,2);
});

test('network latency does not extend a cached balance beyond the next one-second poll',async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock});
  const initial=clock.now;
  const pending=b.getAccount(credentials);
  clock.now+=300;
  await pending;
  clock.now=initial+1000;
  await b.getAccount(credentials);
  assert.equal(state.reads.filter(p=>p.endsWith('/Account')).length,2);
});

test('catalog is deduplicated across concurrent markets, fees, rules and book reads',async()=>{
  const {browser:b,state}=fixture();
  const [, , rules] = await Promise.all([b.getMarkets(credentials),b.getFeeRates(credentials),b.getTradingRules('BTCUSDT',credentials),b.getDepth('BTCUSDT',100,credentials)]);
  assert.equal(state.reads.filter(p=>p==='catalog').length,1);
  assert.equal(rules.maxLeverage,100);
  assert.equal(state.writes.length,0);
});
test('a LBank placement performs one fresh account binding before dispatch, not two',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const before=state.reads.filter(path=>path.endsWith('/Account')).length;
  await b.placeOrder(credentials,request,live);
  const after=state.reads.filter(path=>path.endsWith('/Account')).length;
  assert.equal(after-before,1);assert.equal(state.writes.filter(([kind])=>kind==='place').length,1);
});

test('Impulse prepared entry consumes one short-lived lease and sends no private pre-write reads',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  await b.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:3,marginMode:'isolated'},live);
  const before=state.reads.length;
  await b.placeOrder(credentials,{...request,fastPrepared:true,expiresAt:Date.now()+1200},live);
  const entryReads=state.reads.slice(before).filter(path=>path.endsWith('/Account')||path.endsWith('/SendQryLeverage'));
  assert.deepEqual(entryReads,[]);assert.equal(state.writes.filter(([kind])=>kind==='place').length,1);
  await assert.rejects(b.placeOrder(credentials,{...request,fastPrepared:true,expiresAt:Date.now()+1200,clientOrderId:'second-fast'},live),
    error=>error.definitive===true&&error.code==='ENTRY_PREFLIGHT_EXPIRED');
  assert.equal(state.writes.filter(([kind])=>kind==='place').length,1);
});

test('fill reconciliation never reuses a completed background order snapshot',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const row={InstrumentID:'BTCUSDT',OrderSysID:'203224940138643900',OrderStatus:'4',Volume:2,VolumeTraded:0,VolumeRemain:2,Direction:'0'};
  state.orders=[row];await b.getOpenOrders(credentials);
  const order={symbol:'BTCUSDT',orderId:row.OrderSysID};
  assert.equal((await b.getOrder(credentials,order)).executedQty,0);
  state.orders=[{...row,OrderStatus:'1',VolumeTraded:2,TradePrice:80000}];
  assert.equal((await b.getOrder(credentials,order)).executedQty,.002);
  assert.equal(state.reads.filter(p=>p.endsWith('/Order')).length,3);
});

test('reconciliation does not cache empty history while a market fill is being indexed',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const order={symbol:'BTCUSDT',orderId:'203224940138643900'};
  await assert.rejects(b.getOrder(credentials,order),error=>error.code==='ORDER_PENDING_HISTORY');
  state.history=[{InstrumentID:order.symbol,OrderSysID:order.orderId,OrderStatus:'1',Volume:2,VolumeTraded:2,TradePrice:80000}];
  assert.equal((await b.getOrder(credentials,order)).executedQty,.002);
  assert.equal(state.reads.filter(p=>p.endsWith('/historyAllOrderPage')).length,2);
});

test('429 pauses all callers, honors Retry-After, does not cache the error and sends no writes',async()=>{
  const clock={now:Date.now()}, {browser:b,state}=fixture({clock});
  state.accountError=Object.assign(new Error('HTTP error! status: 429'),{response:{status:429,headers:{'retry-after':'12'}}});
  await assert.rejects(b.getAccount(credentials),e=>e.httpStatus===429&&e.retryAfterMs===12000&&e.endpoint.endsWith('/Account'));
  await assert.rejects(b.getPositions(credentials),e=>e.httpStatus===429);
  await assert.rejects(b.placeOrder(credentials,{...request,clientOrderId:'during-limit'},live),e=>e.httpStatus===429&&e.definitive===true);
  assert.equal(state.reads.filter(p=>p.endsWith('/Account')).length,1);
  assert.equal(state.writes.length,0);
  clock.now+=12001;state.accountError=null;
  assert.equal((await b.getAccount(credentials)).available,1000);
  assert.equal(state.reads.filter(p=>p.endsWith('/Account')).length,2);
});

test('a successful write invalidates cached empty positions and late pre-write reads',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  let release;
  state.positions=new Promise(resolve=>{release=resolve;});
  const stale=b.getPositions(credentials);
  await new Promise(resolve=>setImmediate(resolve));
  await b.placeOrder(credentials,request,live);
  state.positions=[];release([]);assert.equal((await stale).length,0);
  assert.equal((await b.getPositions(credentials)).length,0);
  assert.equal(state.reads.filter(p=>p.endsWith('/Position')).length,2);
  assert.equal(state.writes.length,1);
});

test('429 after write dispatch remains unknown and the same intention is never resent',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  state.placement=()=>{throw Object.assign(new Error('HTTP error! status: 429'),{status:429});};
  await assert.rejects(b.placeOrder(credentials,request,live),e=>e.httpStatus===429&&e.definitive===false);
  await assert.rejects(b.placeOrder(credentials,request,live));
  assert.equal(state.writes.length,1);
});
test('all read capabilities use the browser SDK and keep identifiers private',async()=>{
  const {browser:b,state}=fixture();const account=await b.getAccount(credentials);
  assert.equal(account.available,1000);assert.equal(JSON.stringify(account).includes('PRIVATE'),false);
  assert.equal((await b.getTradingRules('BTCUSDT',credentials)).quantityStep,.001);
  assert.equal((await b.getDepth('BTCUSDT',100,credentials)).bids[0].quantity,.1);
  assert.equal((await b.getDayOpen('BTCUSDT',credentials)).open,79000);
  assert.equal((await b.getFeeRates(credentials)).BTCUSDT.takerFee,.0006);
  assert.equal((await b.getMarkets(credentials))[0].symbol,'BTCUSDT');
  assert.equal((await b.getPositions(credentials)).length,0);assert.equal((await b.getOpenOrders(credentials)).length,0);
  assert.equal(state.writes.length,0);
});
test('LIMIT and reduce-only MARKET use opposite direction and contract units',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const placed=await b.placeOrder(credentials,request,live);
  assert.equal(placed.orderId,'203224940138643900');
  assert.deepEqual(JSON.parse(JSON.stringify(state.writes[0][1])),{InstrumentID:'BTCUSDT',ExchangeID:'Exchange',Direction:'0',OffsetFlag:'0',OrderPriceType:'0',OrderType:'0',TradeUnitID:'PRIVATE_UNIT',Volume:2,Price:80000});
  state.positions=[{InstrumentID:'BTCUSDT',Direction:'0',Position:2,ClosePosition:2,TradeUnitID:'PRIVATE_POSITION_UNIT',OpenPrice:80000,Leverage:3}];
  await b.placeOrder(credentials,{...request,side:'SELL',type:'MARKET',price:undefined,reduceOnly:true,clientOrderId:'test-close'},live);
  const close=state.writes[1][1];assert.equal(close.OffsetFlag,'1');assert.equal(close.Direction,'1');assert.equal(close.OrderPriceType,'4');assert.equal(close.OrderType,'1');assert.equal(close.TradeUnitID,'PRIVATE_POSITION_UNIT');assert.equal('Price' in close,false);
  const positions=await b.getPositions(credentials);assert.ok(Math.abs(positions[0].unrealizedPnl-.002)<1e-10);assert.equal(JSON.stringify(positions).includes('PRIVATE'),false);
});
test('write permission, amount step, missing close position and account changes fail before submission',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  await assert.rejects(b.placeOrder(credentials,request),/подтверждения/);
  await assert.rejects(b.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:4}),/подтверждения/);
  await assert.rejects(b.placeOrder(credentials,{...request,quantity:.0015,clientOrderId:'bad-step'},live),/шагу/);
  await assert.rejects(b.placeOrder(credentials,{...request,type:'MARKET',side:'SELL',reduceOnly:true,clientOrderId:'no-position'},live),/собственная позиция.*не подтверждена/);
  state.owner='DIFFERENT_ACCOUNT';await assert.rejects(b.placeOrder(credentials,{...request,clientOrderId:'changed-account'},live),/изменился аккаунт/);
  assert.equal(state.writes.length,0);
});
test('leverage changes both sides and is read back; occupied symbol is not reconfigured',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  await b.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:5},live);
  assert.equal(state.writes.length,1);assert.equal(state.writes[0][1].shortLeverage,5);
  state.positions=[{InstrumentID:'BTCUSDT'}];await assert.rejects(b.configureLeverage(credentials,{symbol:'BTCUSDT',leverage:6},live),/нельзя менять плечо/);
  assert.equal(state.writes.length,1);
});
test('unknown acknowledgements and repeated intentions never duplicate an order',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);state.placement=()=>({accepted:true});
  let error;try{await b.placeOrder(credentials,request,live);}catch(e){error=e;}
  assert.equal(error.definitive,false);await assert.rejects(b.placeOrder(credentials,request,live),/точный ID/);
  await assert.rejects(b.placeOrder(credentials,{...request,quantity:.003},live),/ID уже/);
  assert.equal(state.writes.length,1);
});
test('acknowledged same intent is deduplicated; explicit exchange rejection differs from timeout',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const [a,c]=await Promise.all([b.placeOrder(credentials,request,live),b.placeOrder(credentials,request,live)]);
  assert.equal(a.orderId,c.orderId);assert.equal(state.writes.length,1);
  state.placement=()=>{throw Object.assign(new Error('Insufficient margin'),{code:22001});};
  await assert.rejects(b.placeOrder(credentials,{...request,clientOrderId:'rejected'},live),e=>e.definitive===true);
  state.placement=()=>{throw new Error('timeout');};
  await assert.rejects(b.placeOrder(credentials,{...request,clientOrderId:'timeout'},live),e=>e.definitive===false);
});
test('status, partial fills and cancel preserve large string IDs and exact base quantities',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  const row={InstrumentID:'BTCUSDT',OrderSysID:'203224940138643900',OrderStatus:'2',Volume:2,VolumeTraded:1,TradePrice:80000,Direction:'0'};state.orders=[row];
  const order={symbol:'BTCUSDT',orderId:row.OrderSysID};const partial=await b.getOrder(credentials,order);
  assert.equal(partial.status,'PARTIALLY_FILLED');assert.equal(partial.executedQty,.001);
  await b.cancelOrder(credentials,order,live);assert.equal(state.writes[0][1].OrderSysID,row.OrderSysID);
  assert.equal((await b.getOrder(credentials,order)).status,'CANCELED');
  await assert.rejects(b.getOrder(credentials,{symbol:'BTCUSDT',clientOrderId:'unknown-intent'}),/неточный ID/);
  await assert.rejects(b.getOrder(credentials,{symbol:'BTCUSDT',orderId:203224940138643900}),/неточный ID/);
});
test('full hedge engine opens LBank target, hedges source and closes both legs through real adapter interface (fixture only)',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  state.placement=p=>{
    const id=String(state.next++),order={InstrumentID:p.InstrumentID,OrderSysID:id,OrderStatus:'1',Volume:p.Volume,VolumeTraded:p.Volume,TradePrice:80000,Direction:p.Direction};
    state.history.push(order);
    state.positions=p.OffsetFlag==='1'?[]:[{InstrumentID:'BTCUSDT',Direction:p.Direction,Position:p.Volume,ClosePosition:p.Volume,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000,Leverage:3}];
    return [{data:{OrderSysID:id}}];
  };
  const source=venue('source');
  const target={placeOrder:b.placeOrder.bind(b),getOrder:b.getOrder.bind(b),cancelOrder:b.cancelOrder.bind(b)};
  const engine=new HedgeEngine({sourceAdapter:source,targetAdapter:target,sleep:async()=>{}});
  await engine.start({source:'source',target:'lbank',sourceCredentials:{},targetCredentials:credentials,symbol:'BTCUSDT',quantity:.002,price:80000,targetSide:'BUY',leverage:3,margin:54,sourceQuantityStep:.001,dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  assert.equal(engine.state,'running');assert.equal(source.placed[0].side,'SELL');assert.equal(source.placed[0].quantity,.002);
  await engine.stop('market');assert.equal(engine.state,'stopped');assert.equal(state.writes.filter(x=>x[0]==='place').length,2);assert.equal(state.writes[1][1].OffsetFlag,'1');assert.equal(source.placed[1].reduceOnly,true);
});

test('partial LBank LIMIT fills create two equal incremental market hedges, never the full quantity twice',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);let targetOrder;
  state.placement=p=>{
    const id=String(state.next++),order={InstrumentID:'BTCUSDT',OrderSysID:id,OrderStatus:p.OffsetFlag==='0'?'4':'1',Volume:p.Volume,VolumeTraded:p.OffsetFlag==='0'?0:p.Volume,TradePrice:80000,Direction:p.Direction};
    if(p.OffsetFlag==='0'){targetOrder=order;state.orders=[order];}else{state.history.push(order);state.positions=[];}
    return [{data:{OrderSysID:id}}];
  };
  state.onReadOrders=()=>{
    if(targetOrder && targetOrder.VolumeTraded<targetOrder.Volume){
      targetOrder.VolumeTraded++;
      targetOrder.OrderStatus=targetOrder.VolumeTraded===targetOrder.Volume?'1':'2';
      state.positions=[{InstrumentID:'BTCUSDT',Direction:'0',Position:targetOrder.VolumeTraded,ClosePosition:targetOrder.VolumeTraded,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000}];
      if(targetOrder.OrderStatus==='1'){state.orders=[];state.history.push(targetOrder);}
    }
    return state.orders;
  };
  const source=venue('source'), target={placeOrder:b.placeOrder.bind(b),getOrder:b.getOrder.bind(b),cancelOrder:b.cancelOrder.bind(b)};
  const engine=new HedgeEngine({sourceAdapter:source,targetAdapter:target,sleep:async()=>{}});
  await engine.start({source:'source',target:'lbank',sourceCredentials:{},targetCredentials:credentials,symbol:'BTCUSDT',quantity:.002,price:80000,targetSide:'BUY',leverage:3,margin:54,sourceQuantityStep:.001,dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  assert.deepEqual(source.placed.map(p=>p.quantity),[.001,.001]);assert.equal(engine.run.hedgedQuantity,.002);
  await engine.stop('market');assert.equal(engine.state,'stopped');
});

test('LBank works as source MARKET and closes the exact opposite-side position',async()=>{
  const {browser:b,state}=fixture();await b.getAccount(credentials);
  state.placement=p=>{
    const id=String(state.next++);state.history.push({InstrumentID:'BTCUSDT',OrderSysID:id,OrderStatus:'1',Volume:p.Volume,VolumeTraded:p.Volume,TradePrice:80000,Direction:p.Direction});
    state.positions=p.OffsetFlag==='1'?[]:[{InstrumentID:'BTCUSDT',Direction:p.Direction,Position:p.Volume,ClosePosition:p.Volume,TradeUnitID:'PRIVATE_UNIT',OpenPrice:80000}];
    return {orderSysID:id};
  };
  const source={placeOrder:b.placeOrder.bind(b),getOrder:b.getOrder.bind(b),cancelOrder:b.cancelOrder.bind(b)},target=venue('target');
  const engine=new HedgeEngine({sourceAdapter:source,targetAdapter:target,sleep:async()=>{}});
  await engine.start({source:'lbank',target:'target',sourceCredentials:credentials,targetCredentials:{},symbol:'BTCUSDT',quantity:.002,price:80000,targetSide:'BUY',leverage:3,margin:54,sourceQuantityStep:.001,dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED'});
  assert.equal(state.writes[0][1].Direction,'1');assert.equal(state.writes[0][1].OrderPriceType,'4');
  await engine.stop('market');assert.equal(state.writes[1][1].Direction,'0');assert.equal(state.writes[1][1].OffsetFlag,'1');assert.equal(engine.state,'stopped');
});
