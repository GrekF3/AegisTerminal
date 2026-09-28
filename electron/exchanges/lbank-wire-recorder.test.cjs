const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LBankWireRecorder, sanitize, parsePayload, isLBankCfdUrl } = require('./lbank-wire-recorder.cjs');

class Connection {
  constructor() { this.listener = null; this.calls = []; }
  onEvent(listener) { this.listener = listener; return () => { if (this.listener === listener) this.listener = null; }; }
  async send(method, params, sessionId) {
    this.calls.push({method,params,sessionId});
    if (method === 'Network.getResponseBody') return { body: JSON.stringify({ code: 0, data: [{ OrderSysID: '203224940138643900', AccountID: 'account-private', apiKey: 'response-secret' }] }), base64Encoded: false };
    return {};
  }
  emit(method, params, sessionId = 'tab') { this.listener?.({method,params,sessionId}); }
}

test('recorder captures only LBank CFD HTTP plus tab websocket frames and redacts before disk', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(),'lbank-wire-test-')); t.after(() => fs.promises.rm(directory,{recursive:true,force:true}));
  const connection = new Connection(); let clock = Date.parse('2026-09-12T10:00:00Z');
  const recorder = new LBankWireRecorder({connection,sessionId:'tab',directory,now:()=>clock++,id:()=> '12345678-1234-1234-1234-123456789abc'});
  await recorder.start(); await recorder.mark('baseline');
  connection.emit('Network.requestWillBeSent',{requestId:'ignored',request:{url:'https://evil.test/not-cfd/private',method:'POST',headers:{},postData:'{"secret":"leak"}'},type:'Fetch'});
  connection.emit('Network.requestWillBeSent',{requestId:'request-1',request:{url:'https://www.lbank.com/cfd/cff/v1/SendOrderInsert?AccountID=account-private&symbol=BTCUSDT',method:'POST',headers:{Authorization:'Bearer header-private','Content-Type':'application/json','X-Signature':'signature-private'},postData:JSON.stringify({InstrumentID:'BTCUSDT',Volume:2,AccountID:'account-private',TradeUnitID:'unit-private',Signature:'payload-private'})},type:'Fetch'});
  connection.emit('Network.responseReceived',{requestId:'request-1',response:{status:200,mimeType:'application/json',headers:{'content-type':'application/json','set-cookie':'cookie-private','retry-after':'2'}}});
  connection.emit('Network.loadingFinished',{requestId:'request-1',encodedDataLength:321});
  connection.emit('Network.webSocketCreated',{requestId:'socket-1',url:'wss://uuws.rerrkvifj.com/ws/v3?token=socket-private'});
  connection.emit('Network.webSocketFrameReceived',{requestId:'socket-1',response:{opcode:1,payloadData:JSON.stringify({topic:'order',UserID:'user-private',OrderSysID:'203224940138643900',token:'frame-private',subscribeKey:'subscription-private'})}});
  connection.emit('Network.webSocketFrameReceived',{requestId:'socket-other',response:{opcode:1,payloadData:'private third party'}});
  await new Promise(resolve => setImmediate(resolve));
  const status = await recorder.stop();
  const text = await fs.promises.readFile(status.filePath,'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.kind==='http_request' && row.url==='https://www.lbank.com/cfd/cff/v1/SendOrderInsert'));
  assert.ok(rows.some(row => row.kind==='http_response_body' && row.body.data[0].OrderSysID==='203224940138643900'));
  assert.ok(rows.some(row => row.kind==='websocket_frame' && row.payload.OrderSysID==='203224940138643900'));
  assert.ok(rows.some(row => row.kind==='marker' && row.marker==='baseline'));
  for (const secret of ['account-private','unit-private','user-private','header-private','signature-private','payload-private','response-secret','socket-private','frame-private','subscription-private','cookie-private','evil.test']) assert.equal(text.includes(secret),false,secret);
  assert.ok(text.includes('sha256:'));
  assert.deepEqual(connection.calls.map(call=>call.method),['Network.enable','Network.getResponseBody']);
  assert.ok(connection.calls.every(call=>call.sessionId==='tab'));
  assert.equal(connection.listener,null);
});

test('wrong session is ignored and markers use a closed allow-list', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(),'lbank-wire-test-')); t.after(() => fs.promises.rm(directory,{recursive:true,force:true}));
  const connection = new Connection(), recorder = new LBankWireRecorder({connection,sessionId:'selected',directory,id:()=> '87654321-1234-1234-1234-123456789abc'});
  await recorder.start();
  assert.throws(()=>recorder.mark('free form private text'),/Неизвестная/);
  connection.emit('Network.requestWillBeSent',{requestId:'wrong',request:{url:'https://www.lbank.com/cfd/query/v1.0/Account',method:'GET',headers:{}},type:'Fetch'},'other-tab');
  const status=await recorder.stop(), text=await fs.promises.readFile(status.filePath,'utf8');
  assert.equal(text.includes('http_request'),false);
});

test('sanitizer keeps trading fields but removes credentials and stable-pseudonymizes routing IDs', () => {
  const value=sanitize({OrderSysID:'123',TriggerOrderID:'456',TradeID:'789',Price:'80000',AccountID:'private',TradeUnitID:'route',Authorization:'Bearer abc',nested:{api_key:'key'}},'capture');
  assert.deepEqual([value.OrderSysID,value.TriggerOrderID,value.TradeID,value.Price],['123','456','789','80000']);
  assert.match(value.AccountID,/^sha256:/); assert.match(value.TradeUnitID,/^sha256:/); assert.equal(value.Authorization,'***'); assert.equal(value.nested.api_key,'***');
  assert.equal(parsePayload('opaque private value','capture').opaque,true);
  assert.equal(parsePayload('eyJiaW5hcnkiOiJmcmFtZSJ9=','capture').opaque,true);
  assert.equal(isLBankCfdUrl('https://www.lbank.com/cfd/query/v1.0/Account'),true);
  assert.equal(isLBankCfdUrl('https://evil.test/cfd/query/v1.0/Account'),false);
  assert.equal(isLBankCfdUrl('https://uuapi.rerrkvifj.com/cfd/query/v1.0/Account',true),true);
});
