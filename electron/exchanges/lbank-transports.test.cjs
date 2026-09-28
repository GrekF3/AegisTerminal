const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {installLBankRequestQueue}=require('./lbank-request-queue.cjs');
const {installLBankPublicStream}=require('./lbank-public-stream.cjs');
function fixture(install) {
  let now=1788795574000, next=1;const timers=new Map(),sockets=[];
  const timeout=(fn,ms)=>{const id=next++;timers.set(id,{fn,at:now+ms});return id;};
  class Socket {
    constructor(){this.listeners={};this.sent=[];this.readyState=0;sockets.push(this);}
    addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
    send(text){this.sent.push(text);}
    emit(name,value){if(name==='open')this.readyState=1;for(const fn of this.listeners[name]||[])fn(value);}
    close(){this.readyState=3;this.emit('close');}
  }
  const self={},context=vm.createContext({self,WebSocket:Socket,Date:class extends Date{static now(){return now;}},setTimeout:timeout,clearTimeout:id=>timers.delete(id),setInterval:()=>next++,clearInterval:()=>{}});
  vm.runInContext(`(${install})()`,context);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  async function advance(ms){const end=now+ms;await flush();while(true){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}now=end;await flush();}
  return {self,sockets,now:()=>now,advance,flush};
}
test('all HTTP callers share one start per second, including slow requests and priority closes',async()=>{
  const f=fixture(installLBankRequestQueue),q=f.self[Symbol.for('hedge.lbank.http-queue.v1')],starts=[];
  const options={scope:'one',epoch:0,priority:0};let release;
  const a=q.run(()=>{starts.push(['slow',f.now()]);return new Promise(r=>release=r);},options);
  const b=q.run(()=>starts.push(['background',f.now()]),options);
  const c=q.run(()=>starts.push(['close',f.now()]),{...options,scope:'two',priority:20});
  await f.advance(1500);assert.equal(starts.length,1);release();await f.flush();
  await f.advance(1000);await Promise.all([a,b,c]);
  assert.deepEqual(starts.map(x=>x[0]),['slow','close','background']);
  assert.ok(starts[1][1]-starts[0][1]>=1000);assert.ok(starts[2][1]-starts[1][1]>=1000);
});
test('local Stop rejects queued commands before dispatch without consuming a request slot',async()=>{
  const f=fixture(installLBankRequestQueue),q=f.self[Symbol.for('hedge.lbank.http-queue.v1')];let calls=0;
  await q.run(()=>calls++,{scope:'s',epoch:0,priority:0});
  const queued=q.run(()=>calls++,{scope:'s',epoch:0,priority:20});const rejected=assert.rejects(queued,e=>e.code==='LOCAL_REQUEST_CANCELED');
  q.cancel('s');await f.advance(1000);await rejected;assert.equal(calls,1);
  await q.run(()=>calls++,{scope:'s',epoch:q.epoch('s'),priority:20});assert.equal(calls,2);
});
test('LBank public socket supplies full books with contract conversion and no HTTP',async()=>{
  const f=fixture(installLBankPublicStream),stream=f.self[Symbol.for('hedge.lbank.public-stream.v1')];
  const first=stream.depth('BTCUSDT',.1,.001),socket=f.sockets[0];socket.emit('open');
  const sub=JSON.parse(socket.sent[0]);assert.equal(sub.a.i,'BTCUSDT_0.1_25');
  const frame=(b,s)=>socket.emit('message',{data:JSON.stringify({x:3,y:sub.y,z:4,w:f.now(),b,s})});
  frame([['100','20'],['99','30']],[['101','10']]);await f.advance(50);
  assert.equal((await first).bids[0].quantity,.02);
  frame([['98','5']],[['99','7']]);
  assert.equal(stream.peekDepth('BTCUSDT').bids.length,1);
  assert.equal(stream.peekDepth('BTCUSDT').bids[0].price,98);
  assert.equal(socket.sent.length,1);
  await f.advance(3001);assert.equal(stream.peekDepth('BTCUSDT'),null);
  socket.close();assert.equal(stream.peekDepth('BTCUSDT'),null);
});
test('crossed books, unrelated subscriptions and disconnected streams never supply a quote',async()=>{
  const f=fixture(installLBankPublicStream),stream=f.self[Symbol.for('hedge.lbank.public-stream.v1')];
  const pending=stream.depth('BTCUSDT',.1,1),rejected=assert.rejects(pending,e=>e.code==='MARKET_STREAM_PENDING');
  const socket=f.sockets[0];socket.emit('open');const sub=JSON.parse(socket.sent[0]);
  socket.emit('message',{data:JSON.stringify({x:3,y:'wrong',z:3,w:f.now(),b:[[100,1]],s:[[101,1]]})});
  socket.emit('message',{data:JSON.stringify({x:3,y:sub.y,z:3,w:f.now(),b:[[102,1]],s:[[101,1]]})});
  assert.equal(stream.peekDepth('BTCUSDT'),null);await f.advance(5000);await rejected;
  socket.close();await f.advance(2000);assert.equal(f.sockets.length,2);
  f.sockets[1].emit('open');assert.equal(JSON.parse(f.sockets[1].sent[0]).a.i,sub.a.i);
});
test('ticker subscriptions are shared and prices are taken only from fresh socket frames',async()=>{
  const f=fixture(installLBankPublicStream),stream=f.self[Symbol.for('hedge.lbank.public-stream.v1')];
  const request=stream.markets(['BTCUSDT','ETHUSDT']),socket=f.sockets[0];socket.emit('open');const sub=JSON.parse(socket.sent[0]);
  socket.emit('message',{data:JSON.stringify({x:1,y:sub.y,z:3,w:f.now(),d:[{a:'BTCUSDT',i:'100',e:'101'},{a:'ETHUSDT',i:'50',e:'51'}]})});
  await f.advance(50);assert.equal((await request).length,2);
  assert.equal((await stream.markets(['ETHUSDT']))[0].markPrice,51);assert.equal(socket.sent.length,1);
  socket.emit('message',{data:JSON.stringify({x:1,y:sub.y,z:4,w:f.now(),d:{a:'ETHUSDT',i:'52',e:'53'}})});
  assert.equal((await stream.markets(['ETHUSDT']))[0].lastPrice,52);
  assert.equal((await stream.markets(['ETHUSDT']))[0].markPrice,53);
});

test('multiple LBank books remain independently subscribed and reconnect only their own cache',async()=>{
  const f=fixture(installLBankPublicStream),stream=f.self[Symbol.for('hedge.lbank.public-stream.v1')];
  const symbols=['BTCUSDT','ETHUSDT','BNBUSDT'];
  const requests=symbols.map(symbol=>stream.depth(symbol,.1,1));
  assert.equal(f.sockets.length,3);
  const push=socket=>{const sub=JSON.parse(socket.sent[0]);socket.emit('message',{data:JSON.stringify({x:3,y:sub.y,z:4,w:f.now(),b:[[100,1]],s:[[101,1]]})});};
  for(const socket of f.sockets){socket.emit('open');push(socket);}
  await f.advance(50);await Promise.all(requests);
  await f.advance(4000);for(const socket of f.sockets)push(socket);
  assert.ok(symbols.every(symbol=>stream.peekDepth(symbol)));
  f.sockets[0].close();assert.equal(stream.peekDepth('BTCUSDT'),null);assert.ok(stream.peekDepth('ETHUSDT'));assert.ok(stream.peekDepth('BNBUSDT'));
  await f.advance(2000);assert.equal(f.sockets.length,4);f.sockets[3].emit('open');push(f.sockets[3]);assert.ok(stream.peekDepth('BTCUSDT'));
});
