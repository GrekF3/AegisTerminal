// Public protocol observed in the LBank Futures client (topics 1/2/3).
// Dedicated public socket: no credentials and no changes to the site's sockets.
function installLBankPublicStream() {
  const key = Symbol.for('hedge.lbank.public-stream.v1');
  if (self[key]) return;
  const subscriptions = new Map(), books = new Map(), markets = new Map(), candles = new Map();
  const connections = new Map();
  let sequence = 7100000000;
  const pending = () => Object.assign(new Error('LBank: ожидаем свежие данные WebSocket'), {code:'MARKET_STREAM_PENDING'});
  const send = item => item.connection.socket?.readyState === 1 && item.connection.socket.send(JSON.stringify({x:item.topic,y:item.id,z:1,a:{i:item.param},e:'{"bvc":"202","isUsd":1}'}));
  const connect = connection => {
    clearTimeout(connection.reconnect);
    const current = ++connection.generation;
    const socket = connection.socket = new WebSocket('wss://uuws.rerrkvifj.com/ws/v3');
    let lastMessage = Date.now();
    socket.addEventListener('open', () => {
      if(current !== connection.generation) return;
      lastMessage = Date.now(); connection.subscriptions.forEach(send);
      clearInterval(connection.heartbeat);
      connection.heartbeat = setInterval(() => { if(Date.now()-lastMessage>30000) socket.close(); else if(socket.readyState===1) socket.send('ping'); },10000);
    });
    socket.addEventListener('message', async event => {
      if(current !== connection.generation) return;
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        if(current !== connection.generation) return;
        lastMessage = Date.now(); if(text==='pong') return;
        const message = JSON.parse(text), item = [...connection.subscriptions.values()].find(s=>s.id===String(message.y));
        if(!item || Number(message.x)!==item.topic || ![3,4].includes(Number(message.z))) return;
        const serverTime = Number(message.w), receivedAt = Date.now();
        if(!Number.isFinite(serverTime) || Math.abs(receivedAt-serverTime)>5000) return;
        if(item.topic===3) {
          // Every order-book push replaces both sides (not a delta).
          const normalize = rows => {
            if(!Array.isArray(rows)||rows.length>1000) throw pending();
            return rows.map(row=>({price:Number(row[0]),quantity:Number(row[1])*item.multiplier})).filter(row=>row.quantity!==0);
          };
          books.delete(item.symbol);
          const bids=normalize(message.b).sort((a,b)=>b.price-a.price), asks=normalize(message.s).sort((a,b)=>a.price-b.price);
          if(!bids.length||!asks.length||[...bids,...asks].some(r=>!(r.price>0&&r.quantity>0&&Number.isFinite(r.price)&&Number.isFinite(r.quantity)))||bids[0].price>=asks[0].price) return;
          books.set(item.symbol,{symbol:item.symbol,bids,asks,receivedAt,serverTime,connectionKey:connection.key});
        } else {
          const rows=Array.isArray(message.d)?message.d:message.d&&typeof message.d==='object'?[message.d]:[];
          for(const row of rows) {
            if(!item.symbols.has(row.a)) continue;
            if(item.topic===1 && Number(row.i)>0 && Number(row.e)>0) markets.set(row.a,{symbol:row.a,lastPrice:Number(row.i),markPrice:Number(row.e),high24h:Number(row.p),low24h:Number(row.q),open24h:Number(row.t),volume24h:Number(row.r),turnover24h:Number(row.s),fundingRate:Number(row.o),receivedAt,serverTime,connectionKey:connection.key});
            if(item.topic===2 && Number(row.d)>0) candles.set(row.a,{time:Number(row.c)*1000,open:Number(row.d),receivedAt,serverTime,connectionKey:connection.key});
          }
        }
      } catch { /* An invalid frame cannot authorize a quote. */ }
    });
    socket.addEventListener('error', () => {if(current===connection.generation) socket.close();});
    socket.addEventListener('close', () => {
      if(current!==connection.generation) return;
      for(const cache of [books,markets,candles]) for(const [symbol,row] of cache) if(row.connectionKey===connection.key) cache.delete(symbol);
      clearInterval(connection.heartbeat);
      connection.reconnect=setTimeout(()=>connect(connection),2000);
    });
  };
  const subscribe = (topic,param,extra={}) => {
    const id=`${topic}:${param}`;
    if(subscriptions.has(id)) return;
    // The server retains only the latest subscription for each topic/socket.
    // A symbol shares its book and candle socket; ticker groups have their own.
    const connectionKey=topic===1?`markets:${param}`:`symbol:${extra.symbol || [...extra.symbols][0]}`;
    let connection=connections.get(connectionKey);
    if(!connection) {connection={key:connectionKey,generation:0,subscriptions:new Map()};connections.set(connectionKey,connection);}
    const previous=connection.subscriptions.get(topic);
    if(previous) {subscriptions.delete(`${previous.topic}:${previous.param}`);if(topic===3) books.delete(previous.symbol);}
    const item={topic,param,id:String(++sequence),...extra,connection}; subscriptions.set(id,item);connection.subscriptions.set(topic,item);
    if(!connection.socket) connect(connection); else send(item);
  };
  const wait = async getter => {
    const deadline=Date.now()+5000;
    do { const value=getter();if(value) return value;await new Promise(resolve=>setTimeout(resolve,50)); } while(Date.now()<deadline);
    throw pending();
  };
  const fresh = (row,age=3000) => row && connections.get(row.connectionKey)?.socket?.readyState===1 && Date.now()-row.receivedAt<=age && Date.now()-row.serverTime<=age;
  self[key]={
    peekDepth: symbol => fresh(books.get(symbol)) ? books.get(symbol) : null,
    depth: async (symbol,tick,multiplier) => {
      if(!/^[A-Z0-9]{1,20}USDT$/.test(symbol)||!(tick>0&&multiplier>0)) throw pending();
      subscribe(3,`${symbol}_${tick}_25`,{symbol,multiplier});
      return wait(()=>fresh(books.get(symbol))?books.get(symbol):null);
    },
    markets: async symbols => {
      const valid=[...new Set(symbols)].filter(s=>/^[A-Z0-9]{1,20}USDT$/.test(s));
      // Reuse existing subscriptions when callers ask for an individual symbol.
      const missing=valid.filter(s=>![...subscriptions.values()].some(item=>item.topic===1&&item.symbols.has(s)));
      for(let i=0;i<missing.length;i+=100) {const group=missing.slice(i,i+100);subscribe(1,group.join(','),{symbols:new Set(group)});}
      return wait(()=>{const rows=valid.map(s=>markets.get(s)).filter(r=>fresh(r,10000));return rows.length?rows:null;});
    },
    dayOpen: async symbol => {
      subscribe(2,`${symbol}_1d`,{symbols:new Set([symbol])});
      const start=Math.floor(Date.now()/86400000)*86400000;
      return wait(()=>{const row=candles.get(symbol);return fresh(row,10000)&&row.time===start?row:null;});
    },
  };
}
module.exports = { installLBankPublicStream };
