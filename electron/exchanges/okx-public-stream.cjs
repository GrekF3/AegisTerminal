const WebSocket=require('ws');
const {resolveProxy}=require('./transport.cjs');
const {HttpsProxyAgent}=require('https-proxy-agent');
const {SocksProxyAgent}=require('socks-proxy-agent');
const pending=()=>Object.assign(new Error('OKX: ожидаем свежие данные WebSocket'),{code:'MARKET_STREAM_PENDING'});

function applyBook(previous,action,row,now=Date.now()) {
  const seq=Number(row.seqId),prev=Number(row.prevSeqId),time=Number(row.ts);
  if(!Number.isSafeInteger(seq)||!Number.isSafeInteger(prev)||!Number.isFinite(time)||Math.abs(now-time)>5000) throw pending();
  if(action!=='snapshot' && (action!=='update'||!previous||prev!==previous.seq)) throw pending();
  const bids=action==='snapshot'?new Map():new Map(previous.bids),asks=action==='snapshot'?new Map():new Map(previous.asks);
  for(const [levels,map] of [[row.bids,bids],[row.asks,asks]]) {
    if(!Array.isArray(levels)||levels.length>5000) throw pending();
    for(const level of levels) {
      const price=Number(level[0]),quantity=Number(level[1]);
      if(!(price>0)||quantity<0||!Number.isFinite(price)||!Number.isFinite(quantity)) throw pending();
      if(quantity===0)map.delete(price);else map.set(price,quantity);
    }
    if(!map.size||map.size>5000)throw pending();
  }
  if(Math.max(...bids.keys())>=Math.min(...asks.keys()))throw pending();
  // OKX deprecated checksum in June 2026; continuity uses seqId/prevSeqId.
  return {bids,asks,seq,receivedAt:now,serverTime:time};
}
class OKXPublicStream {
  constructor(credentials={},Socket=WebSocket) {this.credentials={proxyEnabled:credentials.proxyEnabled,proxyUrl:credentials.proxyUrl};this.Socket=Socket;this.connections=new Map();this.books=new Map();this.tickers=new Map();this.candles=new Map();}
  connection(business=false) {
    const key=business?'business':'public';if(this.connections.has(key))return this.connections.get(key);
    const entry={key,subs:new Map(),sent:new Set(),socket:null,generation:0,failures:0};this.connections.set(key,entry);
    this.open(entry);return entry;
  }
  open(entry) {
    const proxy=resolveProxy(this.credentials),agent=proxy?(proxy.protocol.startsWith('socks')?new SocksProxyAgent(proxy):new HttpsProxyAgent(proxy)):undefined;
    const socket=new this.Socket(`wss://ws.okx.com:8443/ws/v5/${entry.key}`,{agent,handshakeTimeout:10000,maxPayload:8*1024*1024});
    const generation=++entry.generation;entry.socket=socket;entry.sent.clear();
    socket.on('open',()=>{
      if(generation!==entry.generation)return;
      entry.lastMessage=Date.now();this.flush(entry);
      entry.heartbeat=setInterval(()=>{if(Date.now()-entry.lastMessage>30000)socket.close();else if(socket.readyState===1)socket.send('ping');},10000);entry.heartbeat.unref?.();
    });
    socket.on('message',data=>{
      if(generation!==entry.generation)return;
      entry.lastMessage=Date.now();if(String(data)==='pong')return;
      try {
        const m=JSON.parse(String(data));if(m.event==='error')throw pending();
        if(!m.arg||!Array.isArray(m.data)||!entry.sent.has(JSON.stringify({channel:m.arg.channel,instId:m.arg.instId})))return;
        const {channel,instId}=m.arg;
        for(const row of m.data) {
          if(channel==='books')this.books.set(instId,applyBook(this.books.get(instId),m.action,row));
          if(channel==='tickers'&&row.instId===instId&&Number(row.last)>0&&Math.abs(Date.now()-Number(row.ts))<=5000)this.tickers.set(instId,{...row,receivedAt:Date.now(),serverTime:Number(row.ts)});
          if(channel==='candle1Dutc'&&Number(row[1])>0)this.candles.set(instId,{time:Number(row[0]),open:Number(row[1]),receivedAt:Date.now()});
        }
      } catch {this.books.clear();socket.close();}
    });
    socket.on('error',()=>socket.close());
    socket.on('close',()=>{
      if(generation!==entry.generation)return;
      clearInterval(entry.heartbeat);clearTimeout(entry.flushTimer);
      if(entry.key==='public'){this.books.clear();this.tickers.clear();}else this.candles.clear();
      const delay=Math.min(60000,2000*2**Math.min(entry.failures++,5));
      entry.reconnect=setTimeout(()=>this.open(entry),delay);entry.reconnect.unref?.();
    });
  }
  flush(entry) {
    clearTimeout(entry.flushTimer);entry.flushTimer=null;if(entry.socket.readyState!==1)return;
    const keys=[...entry.subs.keys()].filter(key=>!entry.sent.has(key)).sort((a,b)=>Number(entry.subs.get(b).channel==='books')-Number(entry.subs.get(a).channel==='books')).slice(0,100);
    if(!keys.length)return;
    entry.socket.send(JSON.stringify({op:'subscribe',args:keys.map(key=>entry.subs.get(key))}));keys.forEach(key=>entry.sent.add(key));
    entry.flushTimer=setTimeout(()=>this.flush(entry),1000);entry.flushTimer.unref?.();
  }
  subscribe(channel,instId) {
    const entry=this.connection(channel==='candle1Dutc'),arg={channel,instId},key=JSON.stringify(arg);
    if(!entry.subs.has(key)){entry.subs.set(key,arg);if(!entry.flushTimer)entry.flushTimer=setTimeout(()=>{entry.flushTimer=null;this.flush(entry);},0);}
  }
  fresh(row,age=3000,business=false) {return row&&this.connections.get(business?'business':'public')?.socket.readyState===1&&Date.now()-row.receivedAt<=age&&(row.serverTime==null||Date.now()-row.serverTime<=age);}
  async wait(get) {const deadline=Date.now()+10000;do{const value=get();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);throw pending();}
  async depth(instId,depth=100) {
    this.subscribe('books',instId);
    return this.wait(()=>{const row=this.books.get(instId);if(!this.fresh(row))return null;
      const levels=(map,descending)=>[...map].sort((a,b)=>descending?b[0]-a[0]:a[0]-b[0]).slice(0,Math.min(depth,400)).map(([price,quantity])=>({price,quantity}));
      return {symbol:instId.replace('-USDT-SWAP','USDT'),bids:levels(row.bids,true),asks:levels(row.asks,false),receivedAt:row.receivedAt};});
  }
  async markets(instruments) {
    instruments.forEach(id=>this.subscribe('tickers',id));
    return this.wait(()=>{const rows=instruments.map(id=>this.tickers.get(id)).filter(row=>this.fresh(row,10000));return rows.length?rows.map(row=>({symbol:row.instId.replace('-USDT-SWAP','USDT'),exchangeSymbol:row.instId,lastPrice:Number(row.last),markPrice:null,high24h:Number(row.high24h),low24h:Number(row.low24h),open24h:Number(row.open24h),volume24h:Number(row.vol24h),turnover24h:Number(row.volCcy24h),fundingRate:null})):null;});
  }
  async dayOpen(instId) {this.subscribe('candle1Dutc',instId);return this.wait(()=>{const row=this.candles.get(instId);return this.fresh(row,10000,true)&&row.time===Math.floor(Date.now()/86400000)*86400000?row:null;});}
  close(){for(const entry of this.connections.values()){entry.generation++;clearTimeout(entry.reconnect);clearTimeout(entry.flushTimer);clearInterval(entry.heartbeat);entry.socket.close();}this.connections.clear();this.books.clear();this.tickers.clear();this.candles.clear();}
}
let singleton,proxyKey;
function publicStream(credentials={}) {const key=String(resolveProxy(credentials)||'');if(!singleton||proxyKey!==key){singleton?.close();singleton=new OKXPublicStream(credentials);proxyKey=key;}return singleton;}
module.exports={OKXPublicStream,publicStream,applyBook};
