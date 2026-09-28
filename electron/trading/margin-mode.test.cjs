const test=require('node:test'),assert=require('node:assert/strict');
const {HedgeEngine}=require('./hedge-engine.cjs');
const {venue,liveConfig}=require('./fixtures.cjs');
const {credentialFingerprint,recoverSession}=require('./session-recovery.cjs');
test('isolated mode survives the journal and reaches both entry and recovery close orders',async()=>{
  const a=venue('a'),b=venue('b'),engine=new HedgeEngine({sourceAdapter:a,targetAdapter:b,sleep:async()=>{}});
  await engine.start({...liveConfig,leverage:5});
  assert.equal(engine.run.marginMode,'isolated');
  assert.ok([...a.placed,...b.placed].every(o=>o.marginMode==='isolated'));
  const credentials={a:{},b:{}},snapshot={id:'margin-recovery',source:'a',target:'b',active:true,state:'monitoring',runs:[engine.snapshot()]};
  const session=recoverSession({snapshot,fingerprint:credentialFingerprint(credentials,'a','b')},credentials,id=>id==='a'?a:b);
  await session.stop('market');
  const closes=[...a.placed,...b.placed].filter(o=>o.reduceOnly);
  assert.equal(closes.length,2);assert.ok(closes.every(o=>o.marginMode==='isolated'));
});
