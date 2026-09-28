const test=require('node:test'),assert=require('node:assert/strict');
const {applyBook}=require('./okx-public-stream.cjs');
const {marketWithFallback}=require('./market-fallback.cjs');
test('OKX snapshot and sequenced deltas preserve levels, zero deletes and reset snapshots replace everything',()=>{
  const now=Date.now(),row={seqId:10,prevSeqId:-1,ts:String(now),bids:[['100','2'],['99','3']],asks:[['101','4']]};
  const first=applyBook(null,'snapshot',row,now);
  const second=applyBook(first,'update',{seqId:12,prevSeqId:10,ts:String(now),bids:[['100','0'],['98','7']],asks:[]},now);
  assert.equal(second.bids.has(100),false);assert.equal(second.bids.get(98),7);assert.equal(first.bids.has(100),true);
  const reset=applyBook(second,'snapshot',{...row,seqId:2,bids:[['90','1']]},now);
  assert.equal(reset.bids.size,1);assert.equal(reset.bids.get(90),1);
});
test('OKX gaps, stale frames and crossed depth cannot become executable quotes',()=>{
  const now=Date.now(),row={seqId:10,prevSeqId:-1,ts:String(now),bids:[['100','2']],asks:[['101','4']]};
  const first=applyBook(null,'snapshot',row,now);
  for(const value of [{...row,prevSeqId:8,seqId:12},{...row,prevSeqId:10,seqId:12,ts:String(now-6000)},{...row,prevSeqId:10,seqId:12,bids:[['102','1']]}])assert.throws(()=>applyBook(first,'update',value,now),e=>e.code==='MARKET_STREAM_PENDING');
  assert.equal(first.bids.size,1);
});
test('HTTP reserve only activates for a missing stream and coalesces concurrent consumers',async()=>{
  let http=0,ws=0;
  const primary=async()=>{ws++;throw Object.assign(new Error('no stream'),{code:'MARKET_STREAM_PENDING'});};
  const fallback=async()=>{http++;return {price:100};};
  const values=await Promise.all(Array.from({length:20},()=>marketWithFallback('test:reserve',primary,fallback)));
  assert.equal(http,1);assert.equal(ws,1);assert.equal(values[0].price,100);
  const result=await marketWithFallback('test:live',async()=>({price:101}),fallback);assert.equal(result.price,101);assert.equal(http,1);
  await assert.rejects(marketWithFallback('test:bad',async()=>{throw new Error('account mismatch');},fallback),/account mismatch/);assert.equal(http,1);
});
