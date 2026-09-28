const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {retainFuturesCommand,peekFuturesReceipt}=require('./lbank-command-receipts.cjs');
function fixture() {
  const context=vm.createContext({self:{}});
  const start=vm.runInContext(`(${retainFuturesCommand.toString()})`,context);
  const peek=vm.runInContext(`(${peekFuturesReceipt.toString()})`,context);
  return {context,start,peek};
}
test('the page retains the pending Promise and exact normalized response across a lost observer',async()=>{
  const {context,start,peek}=fixture();let resolve,calls=0;
  const execute=()=>{calls++;return new Promise(r=>{resolve=r;});};
  const promise=start(execute,'place',{clientOrderId:'intent'},'owner',{scope:'s'},'intent');
  assert.equal(vm.runInContext("[...self[Symbol.for('hedge.lbank.receipts.v1')].values()][0].promise !== null",context),true);
  assert.equal(peek('s','intent','owner').state,'pending');
  assert.equal(peek('s','intent','different-owner').state,'mismatch');
  assert.equal(peek('different-session','intent','owner').state,'missing');
  assert.equal(start(execute,'place',{clientOrderId:'intent'},'owner',{scope:'s'},'intent'),promise);
  const mismatch=start(execute,'place',{clientOrderId:'intent',quantity:2},'owner',{scope:'s'},'intent');
  assert.equal(mismatch.ok,false);assert.notEqual(mismatch.definitive,true);
  resolve({ok:true,value:{orderId:'900719925474099399'}});await promise;
  assert.equal(peek('s','intent','owner').response.value.orderId,'900719925474099399');
  assert.equal(calls,1);
});
test('completed read receipts are pruned without removing writes or pending reads',async()=>{
  const {start,peek}=fixture();
  const ok=()=>({ok:true,value:{orderId:'exact'}});
  await start(ok,'place',{},'o',{scope:'s'},'write');
  await start(ok,'protect',{},'o',{scope:'s'},'protect');
  await start(ok,'cancelProtection',{},'o',{scope:'s'},'cancel-protect');
  start(()=>new Promise(()=>{}),'account',{},'o',{scope:'s'},'pending');
  for(let i=0;i<300;i++) await start(ok,'account',{},'o',{scope:'s'},`read-${i}`);
  assert.equal(peek('s','write','o').state,'done');
  assert.equal(peek('s','protect','o').state,'done');
  assert.equal(peek('s','cancel-protect','o').state,'done');
  assert.equal(peek('s','pending','o').state,'pending');
  assert.equal(peek('s','read-0','o').state,'missing');
});
test('unexpected async failure is not mislabeled as a confirmed exchange rejection',async()=>{
  const {start,peek}=fixture();
  await start(async()=>{throw new Error('PRIVATE_AUTH_RESPONSE');},'place',{},'o',{scope:'s'},'write');
  const result=peek('s','write','o').response;
  assert.equal(result.ok,false);assert.notEqual(result.definitive,true);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
