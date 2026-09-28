const WebSocket=require('ws');
const {resolveProxy}=require('./transport.cjs');
const {HttpsProxyAgent}=require('https-proxy-agent');
const {SocksProxyAgent}=require('socks-proxy-agent');
const {marketWithFallback}=require('./market-fallback.cjs');
const supported=['binance','bybit','bitget','gateio','mexc'];
const symbolOf=value=>String(value||'').replace(/_/g,'').toUpperCase();
const pending=()=>Object.assign(new Error('Ожидаем свежие данные WebSocket'),{code:'MARKET_STREAM_PENDING'});
function subscription(exchange,kind,symbol) {
  const wire=['gateio','mexc'].includes(exchange)?symbol.replace(/USDT$/,'_USDT'):symbol;
  if(exchange==='binance')return {method:'SUBSCRIBE',params:[kind==='depth'?`${symbol.toLowerCase()}@depth20@100ms`:kind==='day'?`${symbol.toLowerCase()}@kline_1d`:'!ticker@arr'],id:1};
  if(exchange==='bybit')return {op:'subscribe',args:[kind==='depth'?`orderbook.200.${symbol}`:kind==='day'?`kline.D.${symbol}`:`tickers.${symbol}`]};
  if(exchange==='bitget')return {op:'subscribe',args:[{instType:'USDT-FUTURES',instId:symbol,channel:kind==='depth'?'books15':kind==='day'?'candle1Dutc':'ticker'}]};
  if(exchange==='gateio')return {time:Math.floor(Date.now()/1000),channel:kind==='depth'?'futures.order_book':kind==='day'?'futures.candlesticks':'futures.tickers',event:'subscribe',payload:kind==='depth'?[wire,'100','0']:kind==='day'?['1d',wire]:[wire]};
  return {method:kind==='depth'?'sub.depth.full':kind==='day'?'sub.kline':'sub.tickers',param:kind==='depth'?{symbol:wire,limit:20}:kind==='day'?{symbol:wire,interval:'Day1'}:{},gzip:false};
}
function decode(exchange,message) {
  const m=message.data && message.stream?message.data:message,updates=[];
  const book=(symbol,bids,asks,time,delta=false,seq)=>updates.push({kind:'depth',symbol:symbolOf(symbol),bids,asks,time:Number(time),delta,seq});
  const ticker=(symbol,row,time)=>updates.push({kind:'ticker',symbol:symbolOf(symbol),row,time:Number(time)});
  const day=(symbol,time,open)=>updates.push({kind:'day',symbol:symbolOf(symbol),row:{time:Number(time),open:Number(open)},time:Date.now()});
  if(exchange==='binance') {
    if(Array.isArray(m))for(const r of m)ticker(r.s,{lastPrice:r.c,high24h:r.h,low24h:r.l,open24h:r.o,volume24h:r.v,turnover24h:r.q},r.E);
    else if(m.e==='depthUpdate' && (m.st==null||Number(m.st)===1))book(m.s,m.b,m.a,m.E);
    else if(m.e==='kline')day(m.s,m.k.t,m.k.o);
  } else if(exchange==='bybit'&&m.topic) {
    const symbol=m.topic.split('.').at(-1),r=m.data;
    if(m.topic.startsWith('orderbook.'))book(symbol,r.b,r.a,m.ts,m.type==='delta'&&r.u!==1,r.u);
    else if(m.topic.startsWith('tickers.'))ticker(symbol,{lastPrice:r.lastPrice,markPrice:r.markPrice,high24h:r.highPrice24h,low24h:r.lowPrice24h,open24h:r.prevPrice24h,volume24h:r.volume24h,turnover24h:r.turnover24h,fundingRate:r.fundingRate},m.ts);
    else if(m.topic.startsWith('kline.'))for(const row of r)day(symbol,row.start,row.open);
  } else if(exchange==='bitget'&&m.arg&&Array.isArray(m.data)) {
    const symbol=m.arg.instId;
    for(const r of m.data) {
      if(m.arg.channel==='books15'&&m.action==='snapshot')book(symbol,r.bids,r.asks,r.ts||m.ts);
      else if(m.arg.channel==='ticker')ticker(symbol,{lastPrice:r.lastPr,markPrice:r.markPrice,high24h:r.high24h,low24h:r.low24h,open24h:r.open24h,volume24h:r.baseVolume,turnover24h:r.quoteVolume,fundingRate:r.fundingRate},r.ts||m.ts);
      else if(m.arg.channel==='candle1Dutc')day(symbol,r[0],r[1]);
    }
  } else if(exchange==='gateio'&&m.result) {
    const r=m.result;
    if(m.channel==='futures.order_book'&&m.event==='all')book(r.contract,r.bids.map(x=>[x.p,x.s]),r.asks.map(x=>[x.p,x.s]),r.t||m.time_ms);
    if(m.channel==='futures.tickers'&&m.event==='update')for(const row of r)ticker(row.contract,{lastPrice:row.last,markPrice:row.mark_price,high24h:row.high_24h,low24h:row.low_24h,volume24h:row.volume_24h_base,turnover24h:row.volume_24h_quote,fundingRate:row.funding_rate},m.time_ms);
    if(m.channel==='futures.candlesticks'&&m.event==='update')for(const row of r)day(String(row.n).replace(/^1d_/,''),Number(row.t)*1000,row.o);
  } else if(exchange==='mexc') {
    if(m.channel==='push.depth.full')book(m.symbol,m.data.bids,m.data.asks,m.ts);
    if(m.channel==='push.tickers')for(const r of m.data)ticker(r.symbol,{lastPrice:r.lastPrice,markPrice:r.fairPrice,volume24h:r.volume24},m.ts);
    if(m.channel==='push.kline')day(m.symbol||m.data.symbol,Number(m.data.t)*1000,m.data.o);
  }
  return updates;
}
function updateBook(previous,update) {
  if(update.delta&&(!previous||!Number.isSafeInteger(update.seq)||update.seq<=previous.seq))throw pending();
  const bids=update.delta?new Map(previous.bids):new Map(),asks=update.delta?new Map(previous.asks):new Map();
  for(const [rows,map] of [[update.bids,bids],[update.asks,asks]]) {
    if(!Array.isArray(rows)||rows.length>5000)throw pending();
    for(const row of rows){const p=Number(row[0]),q=Number(row[1]);if(!(p>0)||q<0||!Number.isFinite(p)||!Number.isFinite(q))throw pending();if(q===0)map.delete(p);else map.set(p,q);}
    if(!map.size||map.size>5000)throw pending();
  }
  if(Math.max(...bids.keys())>=Math.min(...asks.keys()))throw pending();
  return {bids,asks,seq:update.seq,time:update.time,receivedAt:Date.now()};
}
class PublicMarketStream {
  constructor(exchange,credentials={}) {this.exchange=exchange;this.credentials={proxyEnabled:credentials.proxyEnabled,proxyUrl:credentials.proxyUrl};this.connections=new Map();this.values=new Map();this.subscribed=new Set();}
  endpoint(kind) {
    if(this.exchange==='binance')return `wss://fstream.binance.com/${kind==='depth'?'public':'market'}/stream`;
    return {bybit:'wss://stream.bybit.com/v5/public/linear',bitget:'wss://ws.bitget.com/v2/ws/public',gateio:'wss://fx-ws.gateio.ws/v4/ws/usdt',mexc:'wss://contract.mexc.com/edge'}[this.exchange];
  }
  ensure(kind,symbol) {
    if(!/^[A-Z0-9]{1,20}USDT$/.test(symbol))throw pending();
    this.subscribed.add(`${kind}:${symbol}`);
    const url=this.endpoint(kind);let entry=this.connections.get(url);
    if(!entry){entry={url,subs:new Map(),priorities:new Map(),sent:new Set(),generation:0,failures:0};this.connections.set(url,entry);this.open(entry);}
    const params=subscription(this.exchange,kind,symbol),key=JSON.stringify(params);
    if(!entry.subs.has(key)){entry.subs.set(key,params);entry.priorities.set(key,kind==='depth'?20:kind==='day'?10:0);if(!entry.timer)entry.timer=setTimeout(()=>this.flush(entry),0);}
  }
  open(entry) {
    const proxy=resolveProxy(this.credentials),agent=proxy?(proxy.protocol.startsWith('socks')?new SocksProxyAgent(proxy):new HttpsProxyAgent(proxy)):undefined;
    const socket=new WebSocket(entry.url,{agent,handshakeTimeout:10000,maxPayload:8*1024*1024,headers:this.exchange==='gateio'?{'X-Gate-Size-Decimal':'1'}:undefined}),generation=++entry.generation;
    entry.socket=socket;entry.sent.clear();
    socket.on('open',()=>{if(generation!==entry.generation)return;entry.last=Date.now();this.flush(entry);entry.heartbeat=setInterval(()=>{
      if(Date.now()-entry.last>60000){socket.close();return;}if(socket.readyState!==1)return;
      if(this.exchange==='bitget')socket.send('ping');else if(this.exchange==='bybit')socket.send('{"op":"ping"}');else if(this.exchange==='mexc')socket.send('{"method":"ping"}');else socket.ping();
    },15000);entry.heartbeat.unref?.();});
    socket.on('message',data=>{if(generation!==entry.generation)return;entry.last=Date.now();if(String(data)==='pong')return;
      try{const raw=JSON.parse(String(data));for(const update of decode(this.exchange,raw)){
        const key=`${update.kind}:${update.symbol}`;
        if(!this.subscribed.has(key)||!Number.isFinite(update.time)||Math.abs(Date.now()-update.time)>5000)continue;
        if(update.kind==='depth')this.values.set(key,updateBook(this.values.get(key),update));
        else if(update.kind==='ticker'){
          const previous=this.values.get(key)?.row||{},row={...previous};
          for(const [field,value]of Object.entries(update.row))if(value!=null&&value!==''&&Number.isFinite(Number(value)))row[field]=Number(value);
          if(row.lastPrice>0)this.values.set(key,{row:{...row,symbol:update.symbol},time:update.time,receivedAt:Date.now()});
        }else if(update.row.open>0)this.values.set(key,{row:update.row,time:update.time,receivedAt:Date.now()});
      }}catch{this.values.clear();socket.close();}
    });
    socket.on('error',()=>socket.close());
    socket.on('close',()=>{if(generation!==entry.generation)return;this.values.clear();clearTimeout(entry.timer);entry.timer=null;clearInterval(entry.heartbeat);entry.reconnect=setTimeout(()=>this.open(entry),Math.min(60000,2000*2**Math.min(entry.failures++,5)));entry.reconnect.unref?.();});
  }
  flush(entry) {
    clearTimeout(entry.timer);entry.timer=null;if(entry.socket.readyState!==1)return;
    const todo=[...entry.subs.keys()].filter(key=>!entry.sent.has(key)).sort((a,b)=>entry.priorities.get(b)-entry.priorities.get(a)).slice(0,50);if(!todo.length)return;
    const first=entry.subs.get(todo[0]);
    if(this.exchange==='bybit'||this.exchange==='bitget')entry.socket.send(JSON.stringify({...first,args:todo.flatMap(key=>entry.subs.get(key).args)}));
    else if(this.exchange==='binance')entry.socket.send(JSON.stringify({...first,params:todo.flatMap(key=>entry.subs.get(key).params)}));
    else if(this.exchange==='gateio'&&first.channel==='futures.tickers')entry.socket.send(JSON.stringify({...first,time:Math.floor(Date.now()/1000),payload:todo.flatMap(key=>entry.subs.get(key).payload)}));
    else {todo.splice(1);entry.socket.send(JSON.stringify({...first,...(this.exchange==='gateio'?{time:Math.floor(Date.now()/1000)}:{})}));}
    todo.forEach(key=>entry.sent.add(key));entry.timer=setTimeout(()=>this.flush(entry),1000);entry.timer.unref?.();
  }
  async wait(get) {const end=Date.now()+8000;do{const value=get();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<end);throw pending();}
  fresh(kind,symbol,age=3000) {const value=this.values.get(`${kind}:${symbol}`);return value&&this.connections.get(this.endpoint(kind))?.socket.readyState===1&&Date.now()-value.time<=age&&Date.now()-value.receivedAt<=age?value:null;}
  depth(symbol,limit) {this.ensure('depth',symbol);return this.wait(()=>{const value=this.fresh('depth',symbol);if(!value)return null;const list=(map,desc)=>[...map].sort((a,b)=>desc?b[0]-a[0]:a[0]-b[0]).slice(0,limit||100).map(([price,quantity])=>({price,quantity}));return {symbol,bids:list(value.bids,true),asks:list(value.asks,false),receivedAt:value.receivedAt,transport:'websocket'};});}
  markets(symbols) {symbols.forEach(s=>this.ensure('ticker',s));return this.wait(()=>{const rows=symbols.map(s=>this.fresh('ticker',s,10000)?.row).filter(Boolean);return rows.length?rows:null;});}
  dayOpen(symbol) {this.ensure('day',symbol);return this.wait(()=>{const value=this.fresh('day',symbol,70000);return value?.row.time===Math.floor(Date.now()/86400000)*86400000?value.row:null;});}
  close(){for(const e of this.connections.values()){e.generation++;clearTimeout(e.reconnect);clearTimeout(e.timer);clearInterval(e.heartbeat);e.socket.close();}this.connections.clear();this.values.clear();}
}
function installPublicMarketStream(exchange,adapter) {
  if(!supported.includes(exchange))return;
  const httpDepth=adapter.getDepth,httpMarkets=adapter.getMarkets;
  let stream,proxyKey,universe,loading;
  const get=credentials=>{const key=String(resolveProxy(credentials)||'');if(!stream||key!==proxyKey){stream?.close();stream=new PublicMarketStream(exchange,credentials);proxyKey=key;universe=null;}return stream;};
  adapter.getDepth=(symbol,depth,credentials={})=>{const ws=get(credentials);return marketWithFallback(`${exchange}:depth:${symbol}:${depth}:${proxyKey}`,()=>ws.depth(symbol,depth),()=>httpDepth(symbol,depth,credentials));};
  adapter.getMarkets=async(credentials={})=>{
    const ws=get(credentials);
    // Bootstrap the listed contracts once; prices subsequently come from WS.
    if(!universe||universe.until<Date.now()){
      loading ||= httpMarkets(credentials).then(rows=>({rows:rows.filter(row=>/^[A-Z0-9]{1,20}USDT$/.test(row.symbol)),until:Date.now()+600000})).finally(()=>{loading=null;});
      universe=await loading;
    }
    return marketWithFallback(`${exchange}:markets:${proxyKey}`,()=>ws.markets(universe.rows.map(row=>row.symbol)),()=>httpMarkets(credentials));
  };
  adapter.getDayOpen=(symbol,credentials={})=>{const ws=get(credentials);return marketWithFallback(`${exchange}:day:${symbol}:${proxyKey}`,()=>ws.dayOpen(symbol),()=>require('./intraday-trend.cjs').fetchDayOpen(exchange,symbol,credentials));};
}
module.exports={PublicMarketStream,installPublicMarketStream,decode,updateBook,subscription};
