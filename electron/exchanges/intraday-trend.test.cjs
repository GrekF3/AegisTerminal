const test = require('node:test');
const assert = require('node:assert/strict');
const { dayStart, calculateTrend, fetchDayOpen, candleRequest } = require('./intraday-trend.cjs');
const now = Date.UTC(2026,8,7,11);
test('target direction follows current UTC-day open; yesterday, flat and missing data do not guess direction', () => {
  const candle = {time:dayStart(now),open:100};
  assert.equal(calculateTrend(candle,101,now).targetSide,'BUY');
  assert.equal(calculateTrend(candle,99,now).targetSide,'SELL');
  for (const price of [100,0,NaN,Infinity]) assert.throws(()=>calculateTrend(candle,price,now));
  assert.throws(()=>calculateTrend({...candle,time:candle.time-86400000},101,now));
});
test('all six venues use today UTC candle and pass the selected proxy credentials', async () => {
  const t = dayStart(now), credentials = {proxyUrl:'http://127.0.0.1:9999'};
  const fixtures = {
    binance:[[t-86400000,'90'],[t,'100']], bybit:{retCode:0,result:{list:[[String(t),'100']]}},
    okx:{code:'0',data:[[String(t),'100']]},gateio:[{t:t/1000,o:'100'}],
    bitget:{code:'00000',data:[[String(t),'100']]},mexc:{success:true,code:0,data:{time:[t/1000],open:['100']}},
  };
  for (const [venue,payload] of Object.entries(fixtures)) {
    const result = await fetchDayOpen(venue,'BTCUSDT',credentials,{now,request:async(url,options)=>{assert.equal(options.credentials,credentials); return payload;}});
    assert.equal(result.time,t); assert.equal(result.open,100);
  }
  assert.match(candleRequest('okx','BTCUSDT',now)[0],/1Dutc/);
  assert.match(candleRequest('mexc','BTCUSDT',now)[0],new RegExp('start='+t/1000));
  await assert.rejects(fetchDayOpen('binance','BTCUSDT',{}, {now,request:async()=>[[t-86400000,'100']]}),/нет цены/);
});
