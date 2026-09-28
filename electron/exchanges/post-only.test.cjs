const test = require('node:test');
const assert = require('node:assert/strict');
const { assertOrderDeadline } = require('./order-deadline.cjs');
const order = { symbol:'BTCUSDT',side:'BUY',type:'LIMIT',quantity:1,contracts:1,price:70000,postOnly:true,clientOrderId:'fixture' };
for (const [id,field,value] of [['okx','ordType','post_only'],['binance','timeInForce','GTX'],['bybit','timeInForce','PostOnly'],['gateio','tif','poc'],['bitget','force','post_only']]) {
  test(`${id}: Post-Only is explicit on the wire, normal LIMIT unchanged, never allowed on MARKET`,()=>{
    const adapter=require('./'+id+'.cjs');
    assert.equal(adapter.supportsPostOnly,true);
    assert.equal(adapter.normalizeOrder(order)[field],value);
    const normalized=adapter.normalizeOrder(order);
    assert.equal(Number(normalized.px ?? normalized.price),70000);
    assert.notEqual(adapter.normalizeOrder({...order,postOnly:false})[field],value);
    assert.throws(()=>adapter.normalizeOrder({...order,type:'MARKET'}),/Post-Only/);
  });
}
test('expired intent fails definitively before the request, never sent as a stale maker order',()=>{
  assert.doesNotThrow(()=>assertOrderDeadline({expiresAt:101},100));
  assert.throws(()=>assertOrderDeadline({expiresAt:100},100),e=>e.definitive===true);
  assert.throws(()=>assertOrderDeadline({expiresAt:NaN},100),e=>e.definitive===true);
});
