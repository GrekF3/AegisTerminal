const test=require('node:test'),assert=require('node:assert/strict');
const {decode,updateBook,subscription}=require('./public-market-streams.cjs');
test('snapshot codecs preserve exchange quantities and symbols on all five additional venues',()=>{
  const time=Date.now(),rows=[
    ['binance',{e:'depthUpdate',s:'BTCUSDT',E:time,b:[[100,2]],a:[[101,3]]}],
    ['bybit',{topic:'orderbook.200.BTCUSDT',type:'snapshot',ts:time,data:{u:2,b:[[100,2]],a:[[101,3]]}}],
    ['bitget',{arg:{channel:'books15',instId:'BTCUSDT'},action:'snapshot',data:[{ts:time,bids:[[100,2]],asks:[[101,3]]}]}],
    ['gateio',{channel:'futures.order_book',event:'all',result:{contract:'BTC_USDT',t:time,bids:[{p:'100',s:'2.5'}],asks:[{p:'101',s:'3'}]}}],
    ['mexc',{channel:'push.depth.full',symbol:'BTC_USDT',ts:time,data:{bids:[[100,2,1]],asks:[[101,3,1]]}}],
  ];
  for(const [exchange,message]of rows){const update=decode(exchange,message)[0],book=updateBook(null,update);assert.equal(update.symbol,'BTCUSDT');assert.equal(book.bids.get(100),exchange==='gateio'?2.5:2);assert.equal(book.asks.get(101),3);}
});
test('Bybit deltas require an initialized book and preserve unmodified levels',()=>{
  const snapshot={symbol:'BTCUSDT',bids:[[100,2],[99,4]],asks:[[101,3]],time:Date.now(),seq:10,delta:false};
  const initial=updateBook(null,snapshot),delta={...snapshot,bids:[[100,0]],asks:[],delta:true,seq:12};
  assert.throws(()=>updateBook(null,delta));
  const final=updateBook(initial,delta);assert.equal(final.bids.has(100),false);assert.equal(final.bids.get(99),4);
  assert.throws(()=>updateBook(final,{...delta,seq:11}));assert.throws(()=>updateBook(initial,{...delta,bids:[[102,1]]}));
});
test('UTC candle codecs preserve start time instead of substituting rolling 24-hour open',()=>{
  const start=Math.floor(Date.now()/86400000)*86400000;
  for(const [exchange,message]of [
    ['binance',{e:'kline',s:'BTCUSDT',k:{t:start,o:'100'}}],
    ['bybit',{topic:'kline.D.BTCUSDT',data:[{start,open:'100'}]}],
    ['bitget',{arg:{channel:'candle1Dutc',instId:'BTCUSDT'},data:[[String(start),'100']]}],
    ['gateio',{channel:'futures.candlesticks',event:'update',result:[{n:'1d_BTC_USDT',t:start/1000,o:'100'}]}],
    ['mexc',{channel:'push.kline',symbol:'BTC_USDT',data:{t:start/1000,o:'100'}}],
  ]){const value=decode(exchange,message)[0];assert.equal(value.symbol,'BTCUSDT');assert.equal(value.row.time,start);assert.equal(value.row.open,100);}
});
test('market subscriptions never contain order operations or account authentication',()=>{
  for(const exchange of ['binance','bybit','bitget','gateio','mexc'])for(const kind of ['depth','ticker','day']){
    const value=JSON.stringify(subscription(exchange,kind,'BTCUSDT'));
    assert.doesNotMatch(value,/apiKey|signature|token|login|order_place|cancel-order/);
  }
});
