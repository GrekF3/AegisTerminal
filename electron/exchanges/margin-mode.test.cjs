const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {installAccountCapabilities}=require('./account-capabilities.cjs');
const {marginMode}=require('../trading/margin-mode.cjs');
test('margin defaults are explicit and unknown values cannot fall back to cross',()=>{
  assert.equal(marginMode(),'isolated');assert.throws(()=>marginMode('portfolio'));
  for(const [id,field] of [['okx','tdMode'],['bitget','marginMode'],['mexc','openType']]) {
    const adapter=require(`./${id}.cjs`),order={symbol:'BTCUSDT',side:'BUY',type:'MARKET',quantity:1,volume:1};
    assert.equal(adapter.normalizeOrder(order)[field],id==='mexc'?1:'isolated');
    assert.equal(adapter.normalizeOrder({...order,marginMode:'cross'})[field],id==='mexc'?2:id==='bitget'?'crossed':'cross');
  }
});
test('unverified account-wide margin blocks entry but never blocks reduction',async()=>{
  let placed=0;const adapter={privateRequest:async()=>({result:{marginMode:'REGULAR_MARGIN'}}),placeOrder:async()=>{placed++;return {};}};
  installAccountCapabilities('bybit',adapter);
  await assert.rejects(adapter.placeOrder({}, {symbol:'BTCUSDT',marginMode:'isolated'}, {allowLiveTrading:true}),e=>e.definitive&&e.code==='MARGIN_MODE_MISMATCH');
  assert.equal(placed,0);
  await adapter.placeOrder({}, {symbol:'BTCUSDT',reduceOnly:true}, {allowLiveTrading:true});assert.equal(placed,1);
});
test('Binance recognizes CROSSED and refuses automatic margin additions in isolated mode',async()=>{
  let row={symbol:'BTCUSDT',marginType:'CROSSED',isAutoAddMargin:false};
  const adapter={signedRequest:async()=>[row]};installAccountCapabilities('binance',adapter);
  await adapter.verifyMarginMode({}, {symbol:'BTCUSDT',marginMode:'cross'});
  row={...row,marginType:'ISOLATED',isAutoAddMargin:true};
  await assert.rejects(adapter.verifyMarginMode({}, {symbol:'BTCUSDT',marginMode:'isolated'}),/автоматическое добавление/);
  row.isAutoAddMargin=false;await adapter.verifyMarginMode({}, {symbol:'BTCUSDT'});
});
test('OKX requires the selected side, leverage and isolated mode to be confirmed before any order',async()=>{
  const path=require.resolve('./okx.cjs'),realRequire=createRequire(path),calls=[];let verifiedMode='cross';
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path,'utf8'),{module,exports:module.exports,URLSearchParams,require:id=>id==='./transport.cjs'?{requestJson:async(url,options)=>{
    const endpoint=new URL(url).pathname;calls.push({endpoint,body:options.body&&JSON.parse(options.body)});
    if(endpoint.endsWith('leverage-info'))return {code:'0',data:[{instId:'BTC-USDT-SWAP',mgnMode:verifiedMode,lever:'20',posSide:'short'}]};
    if(endpoint.endsWith('/order'))return {code:'0',data:[{ordId:'test-order',sCode:'0'}]};
    return {code:'0',data:[]};
  }}:realRequire(id)});
  const adapter=module.exports,c={apiKey:'fixture',secret:'fixture',passphrase:'fixture'},order={symbol:'BTCUSDT',side:'SELL',type:'MARKET',contracts:1,positionMode:'long_short_mode',leverage:20,marginMode:'isolated'};
  await assert.rejects(adapter.placeOrder(c,order,{allowLiveTrading:true}),/не подтверждены/);
  assert.equal(calls.some(c=>c.endpoint.endsWith('/order')),false);
  assert.equal(calls[0].body.posSide,'short');assert.equal(calls[0].body.mgnMode,'isolated');
  verifiedMode='isolated';await adapter.placeOrder(c,order,{allowLiveTrading:true});assert.equal(calls.at(-1).body.tdMode,'isolated');
  const before=calls.length;await adapter.placeOrder(c,{...order,side:'BUY',reduceOnly:true},{allowLiveTrading:true});
  assert.equal(calls.length,before+1);assert.equal(calls.at(-1).body.posSide,'short');
});
