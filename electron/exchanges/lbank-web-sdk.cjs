// Serialized into the selected LBank Futures document. Credentials and signing
// remain in the site's SDK; only normalized business data crosses CDP.
async function executeFuturesCommand(operation, args = {}, expectedIdentity = null, requestContext = {}) {
  let writeStarted = false;
  const startedAt = Date.now();
    const writes = ['place', 'cancel', 'leverage', 'protect', 'cancelProtection'];
  try {
    const fail = message => { throw new Error(message); };
    const beforeWrite = () => { if (Date.now()-startedAt>30000) fail('LBank: данные устарели до отправки заявки, выполните новый расчёт'); };
    if (location.origin !== 'https://www.lbank.com' || !/\/futures\//.test(location.pathname)) fail('Откройте LBank Futures в выбранном профиле');
    if (!['account', 'positions', 'closePlan', 'orders', 'markets', 'rules', 'depth', 'dayOpen', 'fees', 'order', 'protection', ...writes].includes(operation)) fail('Неизвестная операция LBank');
    if (writes.includes(operation) && args.allowLiveTrading !== true) fail('Нет подтверждения реальной торговли');
    // Shared by feed, preview and trading in this explicitly attached session.
    // Raw credentials stay in the page. No stale-on-error fallback and no write retries.
    const registryKey = Symbol.for('hedge.lbank.requests.v1');
    const registry = self[registryKey] ||= new Map();
    const scope = String(requestContext.scope || 'readonly-diagnostics');
    const limiter = self[Symbol.for('hedge.lbank.http-queue.v1')];
    const stream = self[Symbol.for('hedge.lbank.public-stream.v1')];
    if (!limiter || !stream) fail('LBank: транспорт приложения не готов');
    const epoch = limiter.epoch(scope);
    const priority = operation==='closePlan'||args.reduceOnly||['protect','protection','cancelProtection'].includes(operation) ? 20 : writes.includes(operation)||operation==='order' ? 10 : 0;
    const dispatch = (fn, check) => limiter.run(fn,{scope,epoch,priority,check:()=>{checkCooldown();check?.();}});
    let shared = registry.get(scope);
    if (!shared) {
      shared = { cache: new Map(), preparedEntries: new Map(), epoch: 0, cooldownUntil: 0, rateStrikes: 0, lastRateAt: 0 };
      registry.set(scope, shared);
      if (registry.size > 4) registry.delete(registry.keys().next().value);
    }
    shared.preparedEntries ||= new Map();
    const cooldownError = () => Object.assign(new Error('LBank: лимит запросов (HTTP 429), пауза ' + Math.max(1, Math.ceil((shared.cooldownUntil-Date.now())/1000)) + ' с'), { httpStatus: 429, localCooldown: true, retryAfterMs: Math.max(0, shared.cooldownUntil-Date.now()) });
    const checkCooldown = () => { if (shared.cooldownUntil > Date.now()) throw cooldownError(); };
    const tradingSnapshot = endpoint => /\/(Account|Position|Order|Trade|TriggerOrder|historyAllOrderPage)$/.test(endpoint);
    const invalidate = () => {
      shared.epoch++;
      for(const [key,entry] of shared.cache)if(tradingSnapshot(entry.endpoint))shared.cache.delete(key);
    };
    const requestError = (error, endpoint) => {
      if (error?.localCooldown) return error;
      const status = Number(error?.httpStatus || error?.status || error?.response?.status || (/\b429\b/.test(String(error?.message)) ? 429 : 0) || (Number(error?.code) === 429 ? 429 : 0));
      if (status === 429) {
        shared.rateStrikes = Date.now()-shared.lastRateAt > 60000 ? 1 : Math.min(shared.rateStrikes+1, 5);
        shared.lastRateAt = Date.now();
        const retry = error?.response?.headers?.get?.('retry-after') ?? error?.response?.headers?.['retry-after'];
        const retryMs = retry == null ? 0 : Number.isFinite(Number(retry)) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
        shared.cooldownUntil = Math.max(shared.cooldownUntil, Date.now()+Math.max(5000 * 2 ** (shared.rateStrikes-1), Number.isFinite(retryMs) ? retryMs : 0));
        for(const [key,entry] of shared.cache) if(tradingSnapshot(entry.endpoint)) shared.cache.delete(key);
        return Object.assign(cooldownError(), { endpoint });
      }
      return Object.assign(new Error(String(error?.message || error)), { code: error?.code, httpStatus: status || undefined, endpoint });
    };
    const cachedRead = (endpoint, values, fn, ttl = 900, refreshes = 0) => {
      // A write must recheck identity/positions/leverage with fresh reads.
      if (endpoint !== 'cfdAggV1Instrument' && (writes.includes(operation) || operation === 'closePlan')) return dispatch(() => fn(...values)).catch(error => { throw requestError(error, endpoint); });
      const key = JSON.stringify([endpoint, values]), existing = shared.cache.get(key);
      if (existing && (existing.pending || (existing.until > Date.now() && existing.storedAt+ttl > Date.now()))) return existing.promise;
      let epoch = shared.epoch, readStartedAt = Date.now();
      const entry = { endpoint, pending: true, until: 0, storedAt: 0, promise: null };
      entry.promise = dispatch(() => { epoch=shared.epoch;readStartedAt=Date.now();return fn(...values); }).then(value => {
        if (tradingSnapshot(endpoint) && shared.epoch !== epoch) {
          entry.pending=false;
          if(shared.cache.get(key)===entry)shared.cache.delete(key);
          // Retry only the invalidated read, never the trading command. Quotes
          // and contract metadata are independent of this account's order writes.
          if(refreshes<2)return cachedRead(endpoint,values,fn,ttl,refreshes+1);
          throw Object.assign(new Error('Обновляем данные LBank после исполнения заявки'),{code:'SNAPSHOT_REFRESH_PENDING',retryAfterMs:250});
        }
        // Age from request start so latency cannot turn a 1 Hz balance poll into 0.5 Hz.
        entry.pending = false; entry.storedAt = readStartedAt; entry.until = readStartedAt+ttl;
        return value;
      }, error => { throw requestError(error, endpoint); }).catch(error => {
        if (shared.cache.get(key) === entry) shared.cache.delete(key);
        throw error;
      });
      shared.cache.set(key, entry);
      if (shared.cache.size > 256) for (const [oldKey, old] of shared.cache) { if (!old.pending && oldKey !== key) { shared.cache.delete(oldKey); break; } }
      return entry.promise;
    };
    let require;
    self.webpackChunk_N_E.push([[`hedge_sdk_${Date.now()}_${Math.random()}`], {}, r => { require = r; }]);
    const moduleId = Object.keys(require?.m || {}).find(id => String(require.m[id]).includes('/cfd/query/v1.0/Account') && String(require.m[id]).includes('/cfd/cff/v1/SendOrderInsert'));
    if (!moduleId) fail('Не найдена совместимая версия LBank Futures SDK');
    const api = require(moduleId);
    const method = (path, predicate = () => true) => {
      const fn = Object.values(api).find(fn => typeof fn === 'function' && String(fn).includes(JSON.stringify(path)) && predicate(String(fn)));
      if (!fn) fail(`Метод LBank недоступен: ${path}`);
      return (...values) => {
        if (['/cfd/cff/v1/SendOrderInsert', '/cfd/cff/v1/SendTriggerOrderInsert', '/cfd/action/v1.0/SendOrderAction', '/cfd/action/v1.0/SendTriggerOrderAction', '/cfd/position/v1/setMultiLeverage', '/cfd/action/v1.0/SendPositionAction'].includes(path)) {
          return dispatch(() => { invalidate(); writeStarted=true; return fn(...values); },()=>{
            beforeWrite();
            if(['/cfd/cff/v1/SendOrderInsert','/cfd/cff/v1/SendTriggerOrderInsert'].includes(path) && args.postOnly) {
              const reserveBook=shared.fallbackBooks?.get(args.symbol);
              const book=stream.peekDepth(args.symbol)||(reserveBook && Date.now()-reserveBook.receivedAt<=3000 ? reserveBook : null), payload=values[0];
              if(!book) throw Object.assign(new Error('LBank: ожидаем свежий стакан WebSocket'),{code:'MARKET_STREAM_PENDING'});
              if(args.side==='BUY'?payload.Price>=book.asks[0].price:payload.Price<=book.bids[0].price) throw Object.assign(new Error('LBank: рынок сдвинулся; пересчитываем цену maker-заявки'),{code:'POST_ONLY_WOULD_TAKE'});
            }
          }).catch(error => { throw requestError(error, path); }).finally(invalidate);
        }
        const reconcile = (operation === 'order' || operation === 'protection') && (path.endsWith('/Order') || path.endsWith('/Trade') || path.endsWith('/TriggerOrder') || path.endsWith('/historyAllOrderPage'));
        const ttl = reconcile ? 0 : path.endsWith('/KLinelst') ? 60000 : path.endsWith('/SendQryMarketOrder') ? 200 : 900;
        return cachedRead(path, values, fn, ttl);
      };
    };
    const proxy = Object.values(api).find(value => value && typeof value === 'object' && typeof value.cfdAggV1Instrument === 'function');
    const number = v => v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    const positive = (v, label) => { const n = number(v); if (!(n > 0)) fail(`LBank: некорректное ${label}`); return n; };
    const get = (row, key) => row?.[key] ?? row?.[key[0].toLowerCase() + key.slice(1)];
    const getAny = (row, ...keys) => {
      for (const key of keys) {
        const direct = get(row, key);
        if (direct != null && direct !== '') return direct;
        const found = Object.keys(row || {}).find(candidate => candidate.toLowerCase() === key.toLowerCase());
        if (found && row[found] != null && row[found] !== '') return row[found];
      }
      return undefined;
    };
    const exactId = value => {
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
      fail('LBank: неизвестный или неточный ID ордера');
    };
    const rows = value => {
      const list = Array.isArray(value) ? value : value?.data;
      if (!Array.isArray(list) || list.length >= 1000) fail('LBank: неполный ответ списка');
      return list;
    };
    const params = { ProductGroup: 'SwapU', ExchangeID: 'Exchange', pageIndex: 1, pageSize: 1000 };
    const positionsRaw = () => method('/cfd/query/v1.0/Position')({ ...params, Valid: '1' }).then(rows);
    const ordersRaw = () => method('/cfd/query/v1.0/Order')(params).then(rows);
    const protectionsRaw = () => method('/cfd/query/v1.0/TriggerOrder')({ ...params, TriggerOrderType: '12' }).then(rows);
    let catalogPromise;
    const catalog = () => catalogPromise ||= (async () => {
      if (!proxy) fail('LBank: нет спецификаций контрактов');
      const result = await cachedRead('cfdAggV1Instrument', [{ ProductGroup: 'SwapU' }], (...values) => proxy.cfdAggV1Instrument(...values), 600000);
      if (!Array.isArray(result) || !result.length) fail('LBank: пустой список контрактов');
      return result;
    })();
    const specFor = async symbol => {
      if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol)) fail('LBank: некорректный USDT-контракт');
      const row = (await catalog()).find(row => row.instrument?.instrumentID === symbol), instrument = row?.instrument;
      if (!instrument || Number(instrument.isInverse) !== 0 || instrument.clearCurrency !== 'USDT' || instrument.exchangeID !== 'Exchange') fail('LBank: нужен линейный USDT Futures контракт');
      return { row, instrument, multiplier: positive(instrument.volumeMultiple, 'множитель контракта') };
    };
    shared.marketFallback ||= new Map();
    shared.fallbackBooks ||= new Map();
    const reserve = (key,primary,fallback) => {
      const previous=shared.marketFallback.get(key);
      if(previous?.pending || previous?.until>Date.now())return previous.promise;
      const entry={pending:true,until:0,promise:null};
      entry.promise=primary().catch(error=>{if(error.code!=='MARKET_STREAM_PENDING')throw error;return fallback();}).then(value=>{entry.until=Date.now()+500;return value;}).finally(()=>{entry.pending=false;});
      shared.marketFallback.set(key,entry);return entry.promise;
    };
    const quotesFor = symbols => reserve(`quotes:${symbols.join(',')}`,()=>stream.markets(symbols),async()=>{
      const rows=await cachedRead('cfdAggV1Instrument',[{ProductGroup:'SwapU'}],(...values)=>proxy.cfdAggV1Instrument(...values),0);
      return rows.filter(row=>symbols.includes(row.instrument?.instrumentID)).map(row=>({symbol:row.instrument.instrumentID,lastPrice:number(row.marketData?.lastPrice),markPrice:number(row.marketData?.markedPrice),high24h:number(row.marketData?.highestPrice),low24h:number(row.marketData?.lowestPrice),open24h:number(row.marketData?.openPrice24),volume24h:number(row.marketData?.volume24),turnover24h:number(row.marketData?.turnover24),fundingRate:number(row.marketData?.prePositionFeeRate),transport:'http-fallback'})).filter(row=>row.lastPrice>0);
    });
    const depthFor = (symbol,tick,multiplier) => reserve(`depth:${symbol}`,()=>stream.depth(symbol,tick,multiplier),async()=>{
      const endpoint='/cfd/market/v1.0/SendQryMarketOrder';
      const sides=[];let receivedAt;
      for(const Direction of ['0','1']) {
        const list=await method(endpoint)({InstrumentID:symbol,ExchangeID:'Exchange',Direction});
        receivedAt ??= Date.now();
        if(!Array.isArray(list)||list.length>20000)fail('LBank: некорректный резервный стакан');
        sides.push(list.map(item=>{const row=item.data??item;if(String(get(row,'Direction'))!==Direction||(get(row,'InstrumentID')&&get(row,'InstrumentID')!==symbol))fail('LBank: неверная сторона резервного стакана');return {price:positive(get(row,'Price'),'цена стакана'),quantity:positive(get(row,'Volume'),'объём стакана')*multiplier};}));
      }
      const book={symbol,bids:sides[0].sort((a,b)=>b.price-a.price),asks:sides[1].sort((a,b)=>a.price-b.price),receivedAt,transport:'http-fallback'};
      if(!book.bids.length||!book.asks.length||book.bids[0].price>=book.asks[0].price||Date.now()-receivedAt>3000)fail('LBank: резервный стакан рассинхронизирован');
      shared.fallbackBooks.set(symbol,book);return book;
    });
    const bindAccount = async () => {
      const list = rows(await method('/cfd/query/v1.0/Account')({SettlementGroup:'SwapU',Currency:'USDT',isSubAccount:0,pageIndex:1,pageSize:20}));
      const matches = list.filter(r => get(r,'Currency') === 'USDT');
      if (matches.length !== 1) fail('Войдите в основной USDT Futures аккаунт LBank');
      const row = matches[0];
      const accountId = get(row,'AccountID'), memberId = get(row,'MemberID');
      if (!accountId || !memberId) fail('LBank: не удалось определить владельца счёта');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([String(accountId),String(memberId),'SwapU','USDT'])));
      const identity = Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
      if (expectedIdentity && expectedIdentity !== identity) fail('В профиле изменился аккаунт LBank. Верните исходный аккаунт перед продолжением хеджа.');
      const available = number(get(row,'Available')), total = number(get(row,'Balance'));
      if (available === null || total === null) fail('LBank не вернул корректный futures-баланс');
      return { identity, account: {exchange:'lbank',asset:'USDT',available,total,balanceKind:'wallet',rawUpdatedAt:Date.now()} };
    };
    const ownPosition = row => !get(row,'CopyMemberID') || String(get(row,'CopyMemberID')) === '0';
    const closeRoute = row => JSON.stringify([get(row,'InstrumentID'),get(row,'Direction'),get(row,'TradeUnitID'),get(row,'PosiDirection')]);
    const positionId = async row => {
      // Different isolated positions may have the same direction and trade unit.
      // Bind the opaque selector to the actual position, never the array index.
      const key = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([
        String(get(row,'TradeUnitID') || ''),String(get(row,'PositionID') || ''),String(get(row,'PosiDirection') ?? ''),
      ])));
      const hash = Array.from(new Uint8Array(key),b=>b.toString(16).padStart(2,'0')).join('').slice(0,24);
      return `lbank:${get(row,'InstrumentID')}:${get(row,'Direction')}:${hash}`;
    };
    const positionView = async row => {
      const symbol = String(get(row,'InstrumentID')), {multiplier,instrument,row:meta} = await specFor(symbol);
      const volume = number(get(row,'Position')), direction = String(get(row,'Direction'));
      if (volume === null || volume < 0 || !['0','1'].includes(direction)) fail('LBank: некорректная позиция');
      let quote;
      try { quote=(await quotesFor([symbol])).find(row=>row.symbol===symbol); }
      catch { /* Position quantity remains authoritative without a public price. */ }
      const quantity = volume * multiplier, entryPrice = number(get(row,'OpenPrice')), markPrice = number(quote?.markPrice);
      const pnl = entryPrice > 0 && markPrice > 0 ? (markPrice-entryPrice)*quantity*(direction==='0'?1:-1) : null;
      const closeVolume=number(get(row,'ClosePosition'));
      return {id:await positionId(row),exchange:'lbank',symbol,side:direction==='0'?'long':'short',quantity,isOwn:ownPosition(row),closeQuantity:closeVolume===null?null:Math.min(volume,Math.max(0,closeVolume))*multiplier,entryPrice,markPrice,unrealizedPnl:pnl,realizedPnl:null,margin:number(get(row,'UseMargin')),leverage:number(get(row,'Leverage')),liquidationPrice:number(get(row,'EstimateLiquidationPrice') ?? get(row,'LiquidationPrice')),marginMode:String(get(row,'IsCrossMargin'))==='1'?'cross':String(get(row,'IsCrossMargin'))==='0'?'isolated':undefined};
    };
    const protectionView = async row => {
      const symbol = String(getAny(row,'InstrumentID')), {multiplier} = await specFor(symbol);
      const id = exactId(getAny(row,'OrderSysID','TriggerOrderID'));
      const rawStatusValue = getAny(row,'TriggerStatus','OrderStatus','Status');
      if(rawStatusValue==null) fail('LBank: серверный TP/SL не содержит статус');
      const rawStatus = String(rawStatusValue);
      // Observed site enum: NOT_IN_QUEUE=0, NOT_TRIGGER=1,
      // TRIGGER_SUCCESS=2, TRIGGER_FAILED=3, REVOKE=4.
      const status = ({'0':'PENDING','1':'ACTIVE','2':'TRIGGERED','3':'FAILED','4':'CANCELED'})[rawStatus];
      if(!status) fail(`LBank: неизвестный статус серверного TP/SL (${rawStatus.slice(0,20)})`);
      const volume = number(getAny(row,'VolumeRemain','Volume'));
      return { orderId:id, symbol, status, quantity:volume == null ? null : volume*multiplier,
        takeProfitPrice:number(getAny(row,'TPTriggerPrice','TpTriggerPrice','tptriggerPrice')),
        stopLossPrice:number(getAny(row,'SLTriggerPrice','SlTriggerPrice','sltriggerPrice')),
        actualPrice:number(getAny(row,'TradePrice','ActualPrice','Price')), triggerPrice:number(getAny(row,'TriggerPrice')),
        side:String(getAny(row,'Direction'))==='0'?'BUY':'SELL', triggerPriceType:String(getAny(row,'TPTriggerPriceType','TriggerPriceType') ?? '1')==='1'?'mark':'last' };
    };
    const statusView = async (row, units = 'contracts') => {
      const symbol = String(get(row,'InstrumentID')), {multiplier} = await specFor(symbol);
      const quantity = number(get(row,'Volume')), executed = number(get(row,'VolumeTraded'));
      if (quantity === null || executed === null || quantity < 0 || executed < 0 || executed > quantity + 1e-10) fail('LBank: нет точного исполненного объёма');
      const status = {'1':'FILLED','2':'PARTIALLY_FILLED','3':'CANCELED','4':'NEW','6':'CANCELED'}[String(get(row,'OrderStatus'))];
      if (!status) fail('LBank: неизвестный статус заявки');
      if(status==='FILLED' && Math.abs(executed-quantity)>Math.max(1e-12,quantity*1e-8)) fail('LBank: исполненный объём не совпадает со статусом FILLED');
      const avgPrice = number(get(row,'TradePrice'));
      // /query/Order uses contracts; /historyAllOrderPage already reports base
      // coin units. Applying volumeMultiple to history a second time loses fills.
      const scale = units === 'base' ? 1 : multiplier;
      if (args.quantity != null && (!(number(args.quantity)>0) || Math.abs(quantity*scale-Number(args.quantity))>Math.max(1e-12,Number(args.quantity)*1e-8))) fail('LBank: объём подтверждения не совпадает с исходной заявкой');
      if (args.side && get(row,'Direction') != null && String(get(row,'Direction')) !== (args.side==='BUY'?'0':'1')) fail('LBank: сторона подтверждения не совпадает с исходной заявкой');
      return {orderId:exactId(get(row,'OrderSysID')),symbol,status,quantity:quantity*scale,executedQty:executed*scale,avgPrice:avgPrice>0?avgPrice:null,fee:number(get(row,'Fee'))};
    };
    const tradeConfirmation = async (symbol,id,known) => {
      // Independent exact execution records cover the gap before order history
      // is indexed. Only a full, uniquely identified fill can finish an absent
      // order; a partial execution can never prove the remainder was canceled.
      const {multiplier}=await specFor(symbol);
      const quantity=number(args.quantity) ?? known?.quantity;
      // The live Trade endpoint was verified for unit-multiplier contracts.
      // Keep other contract units on order/history confirmation until verified.
      if(multiplier!==1 || !(quantity>0) || !Object.values(api).some(fn=>typeof fn==='function'&&String(fn).includes('"/cfd/query/v1.0/Trade"'))) return null;
      // Match the site's exact-order detail request. Account-wide history uses
      // a different pageNo/instrumentID contract and is not an exact-ID query.
      const response=await method('/cfd/query/v1.0/Trade')({ProductGroup:'SwapU',OrderSysID:id,pageIndex:1,pageSize:100});
      const list=rows(response);
      if(Number(response?.totalSize)>list.length || Number(response?.totalPage)>1) return null;
      const fills=new Map();
      for(const row of list) {
        if(String(get(row,'OrderSysID'))!==id || String(get(row,'InstrumentID'))!==symbol) continue;
        const tradeId=exactId(get(row,'TradeID')), volume=positive(get(row,'Volume'),'объём исполнения'), price=positive(get(row,'Price'),'цена исполнения');
        if(args.side && get(row,'Direction')!=null && String(get(row,'Direction'))!==(args.side==='BUY'?'0':'1')) fail('LBank: сторона исполнения не совпадает с исходной заявкой');
        const fill={volume,price,fee:number(get(row,'Fee'))}, previous=fills.get(tradeId);
        if(previous && JSON.stringify(previous)!==JSON.stringify(fill)) fail('LBank: противоречивые записи исполнения');
        fills.set(tradeId,fill);
      }
      const executed=[...fills.values()].reduce((sum,fill)=>sum+fill.volume,0);
      const expected=known?.executedQty>0 ? known.executedQty : quantity;
      if(!(executed>0) || Math.abs(executed-expected)>quantity*1e-8) return null;
      if(!known && Math.abs(executed-quantity)>quantity*1e-8) return null;
      const avgPrice=[...fills.values()].reduce((sum,fill)=>sum+fill.volume*fill.price,0)/executed;
      const fee=[...fills.values()].every(fill=>fill.fee!==null)?[...fills.values()].reduce((sum,fill)=>sum+fill.fee,0):null;
      return known?{...known,avgPrice,fee}:{orderId:id,symbol,status:'FILLED',quantity,executedQty:executed,avgPrice,fee};
    };
    const findOrder = async (symbol, id) => {
      const match = row => String(get(row,'InstrumentID')) === symbol && String(get(row,'OrderSysID')) === id;
      let known, readFailure, conflictingProof=false;
      const rememberFailure=error=>{if(error.httpStatus===429)throw error;readFailure=error;};
      // Capture private stream receipts before the site removes terminal orders
      // from its open list. REST history can lag even while a position is live.
      const eventRegistry=self[Symbol.for('hedge.lbank.order-events.v1')];
      const event=expectedIdentity && typeof eventRegistry?.read==='function' ? eventRegistry.read(scope,expectedIdentity,{...args,symbol,orderId:id}) : null;
      if(event?.state==='conflict') throw Object.assign(new Error('LBank: противоречивое подтверждение ордера; нужна сверка исходного ID'),{code:'ORDER_PENDING_HISTORY',orderId:id,retryAfterMs:500});
      if(event?.state==='matched') {
        const streamed=await statusView(event.row,'base');
        const terminal=['FILLED','CANCELED','REJECTED','EXPIRED'].includes(streamed.status);
        if((streamed.executedQty===0 || streamed.avgPrice>0) && (terminal || Date.now()-event.receivedAt<=2000)) return {...streamed,confirmationSource:'private_stream'};
        if(terminal)known=streamed;
      }
      const acceptStatus = candidate => {
        if(known && ['FILLED','CANCELED','REJECTED','EXPIRED'].includes(known.status)) {
          // A lagging NEW row cannot erase a terminal stream receipt merely
          // because that receipt still needs its execution price from Trade.
          if(!['FILLED','CANCELED','REJECTED','EXPIRED'].includes(candidate.status) && candidate.executedQty<=known.executedQty) return known;
          if(candidate.status!==known.status || Math.abs(candidate.executedQty-known.executedQty)>Math.max(1e-12,known.quantity*1e-8)) {
            conflictingProof=true;
            throw new Error('LBank: источники подтверждения расходятся по статусу или исполненному объёму');
          }
          known={...known,...candidate,avgPrice:candidate.avgPrice||known.avgPrice};
        } else known=candidate;
        return known;
      };
      try {
        const current=(await ordersRaw()).find(match);
        if(current) {acceptStatus(await statusView(current));if(known.executedQty===0 || known.avgPrice>0)return known;}
      } catch(error) {rememberFailure(error);}
      try {
        for (let pageNo=1;pageNo<=20;pageNo++) {
          const page = await method('/cfd/order/v1/historyAllOrderPage')({pageNo,pageSize:100,fakeOnePage:1,orderBusType:4,instrumentID:symbol});
          if (!Array.isArray(page?.resultList)) fail('LBank: история ордеров недоступна');
          const row = page.resultList.find(match);
          if(row) {acceptStatus(await statusView(row,'base'));if(!conflictingProof && (known.executedQty===0 || known.avgPrice>0))return known;break;}
          // fakeOnePage may omit totals or return zero. An explicit next page
          // wins over those placeholders; don't mistake them for an empty history.
          if (page.resultList.length === 0 || page.hasNext === false || (page.hasNext !== true && Number(page.totalPages)>0 && Number(page.totalPages)<=pageNo)) break;
        }
      } catch(error) {rememberFailure(error);}
      if(!conflictingProof)try {const confirmed=await tradeConfirmation(symbol,id,known);if(confirmed)return confirmed;} catch(error) {rememberFailure(error);}
      // Unavailable sources remain an unresolved read, not a rejected order.
      // The engine can supervise this exact ID without creating another intent.
      const reason=readFailure?`; источник сверки недоступен: ${String(readFailure.message).slice(0,120)}`:'';
      throw Object.assign(new Error(`LBank: подтверждаем результат ордера ${id} по активным заявкам, истории и исполнениям${reason}`), {code:'ORDER_PENDING_HISTORY',orderId:id,retryAfterMs:500,httpStatus:readFailure?.httpStatus,endpoint:readFailure?.endpoint});
    };
    // Reads bind the response to the selected account up front. Trading writes
    // perform their own fresh identity check immediately before dispatch; doing
    // both added another full rate-limiter interval after the source had filled.
    const auth = (!writes.includes(operation) && !['markets','rules','depth','dayOpen','fees'].includes(operation) || writes.includes(operation) && !expectedIdentity) ? await bindAccount() : null;
    if (operation === 'account') return {ok:true,value:auth.account,identity:auth.identity};
    if (writes.includes(operation) && !expectedIdentity) fail('LBank: сначала подключите профиль вручную');
    if (operation === 'positions') return {ok:true,value:await Promise.all((await positionsRaw()).map(positionView))};
    if (operation === 'orders') {
      const groups = await Promise.all([ordersRaw(),method('/cfd/query/v1.0/TriggerOrder')({...params,TriggerOrderType:'3'}).then(rows),method('/cfd/query/v1.0/TriggerOrder')({...params,TriggerOrderType:'12'}).then(rows)]);
      const value = await Promise.all(groups.flatMap((group,index)=>group.map(async row=>{
        const symbol=String(get(row,'InstrumentID')), {multiplier}=await specFor(symbol), direction=String(get(row,'Direction'));
        const quantity=number(get(row,'VolumeRemain') ?? get(row,'Volume'));
        if (quantity===null || quantity<0 || !['0','1'].includes(direction)) fail('LBank: неизвестный объём/сторона заявки');
        return {id:`lbank:${index}:${exactId(get(row,'OrderSysID'))}`,exchange:'lbank',symbol,side:direction==='0'?'buy':'sell',quantity:quantity*multiplier,price:number(get(row,'Price')),type:index?'TRIGGER':String(get(row,'OrderPriceType'))==='4'?'MARKET':'LIMIT',status:index?'CONDITIONAL':({'1':'FILLED','2':'PARTIALLY_FILLED','3':'CANCELED','4':'NEW','6':'CANCELED'}[String(get(row,'OrderStatus'))]||'UNKNOWN')};
      })));
      return {ok:true,value};
    }
    if (operation === 'markets') {
      const symbols=(await catalog()).filter(r=>r.instrument?.clearCurrency==='USDT' && Number(r.instrument.isInverse)===0 && r.futuresInstrumentExtend?.tradeIsOpen!==false && Number(r.futuresInstrumentExtend?.isOnlyClose||0)===0).map(r=>r.instrument.instrumentID);
      const value=await quotesFor(symbols);
      if(!value.length) fail('LBank: котировки временно недоступны, ожидаем новый снимок');
      return {ok:true,value};
    }
    if (operation === 'fees') return {ok:true,value:Object.fromEntries((await catalog()).map(r=>[r.instrument.instrumentID,{makerFee:number(r.fee?.makerOpenFeeRate),takerFee:number(r.fee?.takerOpenFeeRate),source:'account'}]))};
    const symbol = String(args.symbol || '').toUpperCase();
    const {instrument,multiplier,row:meta}=await specFor(symbol);
    const leverageInfo = () => method('/cfd/action/v1.0/SendQryLeverage')({instrumentID:symbol,exchangeID:'Exchange'});
    if (operation === 'closePlan') {
      if(!['BUY','SELL'].includes(args.side)) fail('LBank: неизвестная сторона закрытия');
      const quantity=positive(args.quantity,'объём закрытия'), step=positive(instrument.volumeTick,'шаг количества')*multiplier;
      if(Math.abs(quantity/step-Math.round(quantity/step))>1e-7) fail('LBank: объём закрытия не соответствует шагу');
      const all=(await positionsRaw()).filter(row=>get(row,'InstrumentID')===symbol && String(get(row,'Direction'))===(args.side==='SELL'?'0':'1') && number(get(row,'Position'))>0);
      const matches=all.filter(ownPosition);
      const plan=[];let remaining=quantity;
      const ids=new Set();
      for(const row of matches) {
        // The verified close wire selects TradeUnitID + PosiDirection, not
        // PositionID. Distinct rows sharing that route cannot be closed exactly.
        if(!get(row,'TradeUnitID') || all.filter(other=>closeRoute(other)===closeRoute(row)).length!==1) fail('LBank: биржа вернула несколько позиций с одним счётом закрытия; точное закрытие не определено');
        const id=await positionId(row), available=number(get(row,'ClosePosition')), volume=number(get(row,'Position'));
        if(ids.has(id)) fail('LBank: неоднозначные строки позиции, обновите снимок');
        ids.add(id);
        if(available===null || available<0 || volume===null) fail('LBank: доступный объём закрытия не подтверждён');
        const amount=Math.min(remaining,Math.floor((Math.min(available,volume)*multiplier+step*1e-8)/step)*step);
        if(amount>quantity*1e-10) {plan.push({positionId:id,quantity:Number(amount.toPrecision(15))});remaining-=amount;}
        if(remaining<=quantity*1e-8) break;
      }
      if(remaining>quantity*1e-8) fail(matches.length?'LBank: часть позиции занята другими заявками; свободного объёма для закрытия недостаточно':'LBank: собственная позиция нужной стороны ещё не подтверждена');
      return {ok:true,value:plan};
    }
    if (operation === 'rules') {
      const leverage=await leverageInfo(), maxima=[number(leverage?.longMaxLeverage),number(leverage?.shortMaxLeverage)].filter(value=>value>0);
      if(!maxima.length) fail('LBank: максимальное плечо контракта не подтверждено');
      return {ok:true,value:{quantityStep:positive(instrument.volumeTick,'шаг количества')*multiplier,minQuantity:positive(instrument.minOrderVolume,'минимальный объём')*multiplier,minNotional:positive(instrument.minOrderCost,'минимальная стоимость'),tickSize:positive(instrument.priceTick,'шаг цены'),contractSize:multiplier,maxLeverage:Math.min(...maxima),maxQuantity:number(instrument.maxOrderVolume)*multiplier}};
    }
    if (operation === 'dayOpen') {
      return {ok:true,value:await reserve(`day:${symbol}:${Math.floor(Date.now()/86400000)}`,()=>stream.dayOpen(symbol),async()=>{
        const start=Math.floor(Date.now()/86400000)*86400000;
        const list=await method('/cfd/query/v1.0/KLinelst')(symbol,'Exchange','15m',Math.floor(Math.min(Date.now(),start+900000)/1000),2);
        const row=rows(list).find(row=>Number(get(row,'BeginTime'))*1000===start);
        return {time:start,open:positive(get(row,'OpenPrice'),'цена начала UTC-дня'),receivedAt:Date.now(),transport:'http-fallback'};
      })};
    }
    if (operation === 'depth') {
      return {ok:true,value:await depthFor(symbol,positive(instrument.priceTick,'шаг цены'),multiplier)};
    }
    if (operation === 'order') return {ok:true,value:await findOrder(symbol,exactId(args.orderId))};
    if (operation === 'protection') {
      const list=await protectionsRaw();
      let matches;
      if(args.orderId) {
        const id=exactId(args.orderId);
        matches=list.filter(row=>String(getAny(row,'OrderSysID','TriggerOrderID'))===id && String(getAny(row,'InstrumentID'))===symbol);
      } else {
        const quantity=positive(args.quantity,'объём защиты'), expectedDirection=args.side==='BUY'?'1':args.side==='SELL'?'0':null;
        if(expectedDirection===null) fail('LBank: неизвестна сторона защищаемой позиции');
        const tick=positive(instrument.priceTick,'шаг цены'), expectedContracts=quantity/multiplier;
        matches=list.filter(row=>{
          const volume=number(getAny(row,'VolumeRemain','Volume'));
          const tp=number(getAny(row,'TPTriggerPrice','TpTriggerPrice','tptriggerPrice'));
          const sl=number(getAny(row,'SLTriggerPrice','SlTriggerPrice','sltriggerPrice'));
          return String(getAny(row,'InstrumentID'))===symbol && String(getAny(row,'Direction'))===expectedDirection
            && volume!==null && Math.abs(volume-expectedContracts)<=Math.max(1e-10,expectedContracts*1e-8)
            && tp!==null && Math.abs(tp-Number(args.takeProfitPrice))<=tick*1e-6
            && sl!==null && Math.abs(sl-Number(args.stopLossPrice))<=tick*1e-6;
        });
      }
      if(matches.length!==1) {
        if(!matches.length) throw Object.assign(new Error('LBank: серверный TP/SL ещё не найден'),{code:'PROTECTION_NOT_FOUND'});
        fail('LBank: найдено несколько одинаковых серверных TP/SL; автоматическая сверка остановлена');
      }
      return {ok:true,value:await protectionView(matches[0])};
    }
    if (operation === 'cancel') {
      const id=exactId(args.orderId), order=await findOrder(symbol,id);
      if(['FILLED','CANCELED','REJECTED','EXPIRED'].includes(order.status)) return {ok:true,value:order};
      await bindAccount(); beforeWrite();
      try {
        await method('/cfd/action/v1.0/SendOrderAction',text=>text.includes('...'))({OrderSysID:id});
      } catch(error) {
        if(Number(error?.code)!==24) throw error;
        // Code 24 means only that the order vanished from the cancellable list.
        // It may have filled in the cancel race, so prove the exact terminal
        // result from the private event stream, history and trades without
        // ever sending the cancel (or an entry) a second time.
        let pending;
        for(let attempt=0;attempt<8;attempt++) {
          try {
            const recovered=await findOrder(symbol,id);
            if(['FILLED','CANCELED','REJECTED','EXPIRED'].includes(recovered.status)) return {ok:true,value:recovered};
          } catch(readError) {
            if(readError?.code!=='ORDER_PENDING_HISTORY') throw readError;
            pending=readError;
          }
          await new Promise(resolve=>typeof setTimeout==='function'?setTimeout(resolve,500):resolve());
        }
        throw Object.assign(new Error(`LBank: ордер ${id} исчез во время отмены; продолжаем сверку по исходному ID без повторной отправки`),
          {code:'ORDER_PENDING_HISTORY',orderId:id,retryAfterMs:500,httpStatus:pending?.httpStatus,endpoint:pending?.endpoint});
      }
      return {ok:true,value:{orderId:id,cancelRequested:true}}; // Caller must read status to confirm cancellation.
    }
    if (operation === 'cancelProtection') {
      const id=exactId(args.orderId);
      await bindAccount(); beforeWrite();
      await method('/cfd/action/v1.0/SendTriggerOrderAction')({OrderSysID:id,ActionFlag:'1'});
      return {ok:true,value:{orderId:id,cancelRequested:true}};
    }
    const requestedMarginMode = args.marginMode ?? 'isolated';
    if(!['isolated','cross'].includes(requestedMarginMode)) fail('LBank: неизвестный режим маржи');
    const marginMatches = info => info?.isCrossMargin != null && String(info.isCrossMargin)===(requestedMarginMode==='isolated'?'0':'1');
    if (operation === 'leverage') {
      const binding=await bindAccount();
      const leverage=Number(args.leverage); let info=await leverageInfo();
      if(!Number.isInteger(leverage)||leverage<1||leverage>125) fail('LBank: плечо от 1x до 125x');
      if(leverage>Math.min(positive(info?.longMaxLeverage,'максимальное плечо'),positive(info?.shortMaxLeverage,'максимальное плечо'))) fail('LBank: плечо превышает максимум контракта');
      if(!marginMatches(info)) {
        if((await positionsRaw()).some(row=>get(row,'InstrumentID')===symbol)) fail('LBank: нельзя менять маржу открытой позиции');
        await bindAccount(); beforeWrite();
        // Same ActionType and Amount used by the Futures margin-mode dialog.
        await method('/cfd/action/v1.0/SendPositionAction',text=>/ActionType:["']4["']/.test(text))({ExchangeID:'Exchange',InstrumentID:symbol,Amount:requestedMarginMode==='isolated'?'0':'1'});
        info=await leverageInfo();
        if(!marginMatches(info)) fail('LBank: выбранный режим маржи не подтверждён; вход запрещён');
      }
      if(Number(info.longLeverage)!==leverage||Number(info.shortLeverage)!==leverage) {
        if((await positionsRaw()).some(row=>get(row,'InstrumentID')===symbol)) fail('LBank: нельзя менять плечо чужой открытой позиции');
        await bindAccount(); beforeWrite();
        await method('/cfd/position/v1/setMultiLeverage')({instrumentID:symbol,longLeverage:leverage,shortLeverage:leverage});
      }
      const verified=await leverageInfo();
      if(Number(verified?.longLeverage)!==leverage||Number(verified?.shortLeverage)!==leverage) fail('LBank: выбранное плечо ещё не подтверждено');
      if(!marginMatches(verified)) fail('LBank: режим маржи изменился; вход запрещён');
      if(!verified?.tradeUnitID) fail('LBank: торговый счёт не определён');
      // A one-shot prepared entry avoids three serialized private reads after
      // a sub-second market signal. It is bound to this account, symbol,
      // leverage and margin mode, and is consumed by the first actual write.
      shared.preparedEntries.set(symbol,{identity:binding.identity,symbol,leverage,marginMode:requestedMarginMode,
        tradeUnitID:verified.tradeUnitID,isCrossMargin:verified.isCrossMargin,longLeverage:verified.longLeverage,
        shortLeverage:verified.shortLeverage,expiresAt:Date.now()+300000});
      return {ok:true,value:{symbol,leverage,marginMode:requestedMarginMode,preparedUntil:Date.now()+300000}};
    }
    if (operation === 'protect') {
      const quantity=positive(args.quantity,'объём защиты'), side=args.side;
      if(!['BUY','SELL'].includes(side)) fail('LBank: неизвестна сторона защищаемой позиции');
      const contracts=quantity/multiplier, step=positive(instrument.volumeTick,'шаг количества');
      if(Math.abs(contracts/step-Math.round(contracts/step))>1e-7) fail('LBank: объём защиты не соответствует шагу контракта');
      const tp=positive(args.takeProfitPrice,'цена take-profit'), sl=positive(args.stopLossPrice,'цена stop-loss');
      const tick=positive(instrument.priceTick,'шаг цены');
      if(Math.abs(tp/tick-Math.round(tp/tick))>1e-6 || Math.abs(sl/tick-Math.round(sl/tick))>1e-6) fail('LBank: цена TP/SL не соответствует шагу');
      if(side==='BUY' ? !(tp>sl) : !(sl>tp)) fail('LBank: TP/SL расположены неверно для стороны позиции');
      const direction=side==='BUY'?'0':'1';
      const all=(await positionsRaw()).filter(row=>String(get(row,'InstrumentID'))===symbol && String(get(row,'Direction'))===direction && number(get(row,'Position'))>0);
      const matches=all.filter(ownPosition).filter(row=>{
        const volume=number(get(row,'Position'));
        return volume!==null && volume+1e-10>=contracts;
      });
      if(matches.length!==1) fail(matches.length?'LBank: серверная защита позиции неоднозначна':'LBank: позиция для серверного TP/SL ещё не подтверждена');
      const position=matches[0], tradeUnit=get(position,'TradeUnitID'), posiDirection=get(position,'PosiDirection');
      if(!tradeUnit || posiDirection==null || all.filter(row=>closeRoute(row)===closeRoute(position)).length!==1) fail('LBank: маршрут защищаемой позиции не определён однозначно');
      const payload={InstrumentID:symbol,ExchangeID:'Exchange',Direction:side==='BUY'?'1':'0',PosiDirection:posiDirection,
        OffsetFlag:'8',OrderType:'0',TradeUnitID:tradeUnit,TriggerOrderType:'1',IsGuaranteedPriceOrder:0,
        Volume:Number(contracts.toPrecision(15)),TPTriggerPrice:tp,TPPrice:'',TPTriggerPriceType:'1',SLTriggerPrice:sl,SLPrice:'',SLTriggerPriceType:'1'};
      await bindAccount(); beforeWrite();
      const response=await method('/cfd/cff/v1/SendTriggerOrderInsert')(payload);
      const ids=[];
      if(response?.orderSysID!=null) ids.push(response.orderSysID);
      if(Array.isArray(response)) for(const item of response) if(item?.data?.TriggerOrderType && item.data.OrderSysID!=null) ids.push(item.data.OrderSysID);
      let unique=[...new Set(ids.map(exactId))];
      if(unique.length!==1) {
        const recovered=(await protectionsRaw()).filter(row=>String(getAny(row,'InstrumentID'))===symbol && String(getAny(row,'Direction'))===payload.Direction
          && Math.abs(Number(getAny(row,'VolumeRemain','Volume'))-contracts)<=Math.max(1e-10,contracts*1e-8)
          && Math.abs(Number(getAny(row,'TPTriggerPrice','TpTriggerPrice'))-tp)<=tick*1e-6
          && Math.abs(Number(getAny(row,'SLTriggerPrice','SlTriggerPrice'))-sl)<=tick*1e-6);
        unique=[...new Set(recovered.map(row=>exactId(getAny(row,'OrderSysID','TriggerOrderID'))))];
      }
      if(unique.length!==1) fail('LBank: TP/SL отправлен, но точный ID не подтверждён. Повторная отправка запрещена.');
      return {ok:true,value:{exchange:'lbank',orderId:unique[0],clientOrderId:args.clientOrderId,symbol,quantity,side,takeProfitPrice:tp,stopLossPrice:sl,status:'PENDING'}};
    }
    if (operation === 'place') {
      if(args.expiresAt!=null && (!Number.isFinite(args.expiresAt) || args.expiresAt<=startedAt)) fail('LBank: цена/время лимитной заявки устарели до отправки');
      const quantity=positive(args.quantity,'количество'), side=args.side, type=args.type;
      if(!args.reduceOnly && requestContext.requireOrderEvents===true) {
        const eventRegistry=self[Symbol.for('hedge.lbank.order-events.v1')];
        const probe=typeof eventRegistry?.read==='function'?eventRegistry.read(scope,expectedIdentity,{orderId:'readiness-check',symbol}):null;
        if(!probe || ['unavailable','conflict'].includes(probe.state)) throw Object.assign(new Error('LBank: поток подтверждений ордеров не подключён. Переподключите профиль перед запуском.'),{code:'ORDER_EVENTS_UNAVAILABLE'});
      }
      if(!['BUY','SELL'].includes(side)||!['LIMIT','MARKET'].includes(type)) fail('LBank: неизвестный тип/сторона заявки');
      if(args.postOnly && type!=='LIMIT') fail('LBank: Post-Only допускается только для LIMIT');
      if(meta.futuresInstrumentExtend?.tradeIsOpen===false || (!args.reduceOnly && Number(meta.futuresInstrumentExtend?.isOnlyClose||0)!==0)) fail('LBank: открытие по контракту недоступно');
      const contracts=quantity/multiplier,step=positive(instrument.volumeTick,'шаг количества');
      if(Math.abs(contracts/step-Math.round(contracts/step))>1e-7) fail('LBank: объём не соответствует шагу контракта');
      if(contracts<positive(instrument.minOrderVolume,'минимальный объём')-1e-10 || (number(instrument.maxOrderVolume)>0 && contracts>Number(instrument.maxOrderVolume))) fail('LBank: объём вне допустимого диапазона');
      const prepared=args.reduceOnly||args.fastPrepared!==true?null:shared.preparedEntries.get(symbol);
      if(args.fastPrepared===true&&!args.reduceOnly&&(!prepared||prepared.expiresAt<=Date.now()||prepared.identity!==expectedIdentity
        ||prepared.symbol!==symbol||prepared.leverage!==Number(args.leverage)||prepared.marginMode!==requestedMarginMode)) {
        throw Object.assign(new Error('LBank: быстрый preflight входа истёк; монета будет подготовлена заново'),{code:'ENTRY_PREFLIGHT_EXPIRED'});
      }
      const info=args.reduceOnly?null:(prepared||await leverageInfo());
      if(!args.reduceOnly && !marginMatches(info)) fail('LBank: режим маржи не соответствует настройке хеджа; вход запрещён');
      let tradeUnit=info?.tradeUnitID, closePosition;
      if(!args.reduceOnly && !tradeUnit) fail('LBank: торговый счёт не определён');
      if(!args.reduceOnly && Number(side==='BUY'?info.longLeverage:info.shortLeverage)!==Number(args.leverage)) fail('LBank: плечо изменилось перед ордером');
      if(args.reduceOnly) {
        const all=(await positionsRaw()).filter(row=>get(row,'InstrumentID')===symbol && String(get(row,'Direction'))===(side==='SELL'?'0':'1') && number(get(row,'Position'))>0);
        let matches=all.filter(ownPosition);
        if(args.positionId) matches=(await Promise.all(matches.map(async row=>({row,id:await positionId(row)})))).filter(item=>item.id===args.positionId).map(item=>item.row);
        if(!matches.length) fail('LBank: собственная позиция нужной стороны ещё не подтверждена');
        if(matches.length!==1) fail('LBank: закрытие нескольких позиций требует распределения объёма по позициям');
        closePosition=matches[0];
        if(all.filter(row=>closeRoute(row)===closeRoute(closePosition)).length!==1) fail('LBank: счёт закрытия неоднозначен; требуется новый снимок позиций');
        const closeVolume=number(get(closePosition,'ClosePosition'));
        if(closeVolume===null || closeVolume+1e-10<contracts || number(get(closePosition,'Position'))+1e-10<contracts) fail('LBank: недостаточно доступного объёма позиции для закрытия');
        tradeUnit=get(closePosition,'TradeUnitID');
        if(!tradeUnit) fail('LBank: счёт закрываемой позиции не определён');
      }
      // Public Futures client: InstructType.ONLY_MAKER = "3", not FAK/FOK.
      const payload={InstrumentID:symbol,ExchangeID:'Exchange',Direction:side==='BUY'?'0':'1',OffsetFlag:args.reduceOnly?'1':'0',OrderPriceType:type==='LIMIT'?'0':'4',OrderType:type==='LIMIT'?(args.postOnly?'3':'0'):'1',TradeUnitID:tradeUnit,Volume:Number(contracts.toPrecision(15))};
      let attachedProtection=false;
      if(args.protection && !args.reduceOnly) {
        const tp=positive(args.protection.takeProfitPrice,'цена take-profit'), sl=positive(args.protection.stopLossPrice,'цена stop-loss');
        const tick=positive(instrument.priceTick,'шаг цены');
        if(Math.abs(tp/tick-Math.round(tp/tick))>1e-6 || Math.abs(sl/tick-Math.round(sl/tick))>1e-6) fail('LBank: цена TP/SL не соответствует шагу');
        if(side==='BUY' ? !(tp>sl) : !(sl>tp)) fail('LBank: TP/SL расположены неверно для стороны заявки');
        Object.assign(payload,{CloseTPTriggerPrice:tp,CloseTPPrice:'',CloseTPTriggerPriceType:'1',CloseSLTriggerPrice:sl,CloseSLPrice:'',CloseSLTriggerPriceType:'1',TriggerOrderType:'2'});
        attachedProtection=true;
      }
      if(closePosition && get(closePosition,'PosiDirection')!=null) payload.PosiDirection=get(closePosition,'PosiDirection');
      if(type==='LIMIT') {
        payload.Price=positive(args.price,'лимитная цена');
        const tick=positive(instrument.priceTick,'шаг цены');
        if(Math.abs(payload.Price/tick-Math.round(payload.Price/tick))>1e-6) fail('LBank: цена не соответствует шагу');
        if(!args.reduceOnly && payload.Price*quantity<positive(instrument.minOrderCost,'минимальная стоимость')) fail('LBank: стоимость заявки ниже минимума');
      }
      if(!prepared) await bindAccount();
      if(args.postOnly) {
        const book=await depthFor(symbol,positive(instrument.priceTick,'шаг цены'),multiplier);
        const oppositePrice=side==='BUY'?book.asks[0].price:book.bids[0].price;
        if(side==='BUY'?payload.Price>=oppositePrice:payload.Price<=oppositePrice) throw Object.assign(new Error('LBank: рынок сдвинулся; пересчитываем цену maker-заявки'),{code:'POST_ONLY_WOULD_TAKE'});
      }
      if(type==='MARKET' && !args.reduceOnly && (args.maxEntrySlippageBps!=null||args.depthSafetyMultiplier!=null)) {
        const slippageBps=number(args.maxEntrySlippageBps), depthSafety=number(args.depthSafetyMultiplier);
        if(slippageBps===null||slippageBps<0||slippageBps>100||depthSafety===null||depthSafety<1||depthSafety>100) fail('LBank: MARKET-вход не содержит допустимые ограничения глубины');
        const book=await depthFor(symbol,positive(instrument.priceTick,'шаг цены'),multiplier);
        if(!Number.isFinite(book.receivedAt)||Date.now()-book.receivedAt>1000) throw Object.assign(new Error('LBank: стакан устарел перед MARKET-входом'),{code:'MARKET_STREAM_PENDING'});
        const levels=side==='BUY'?book.asks:book.bids,best=positive(levels[0]?.price,'лучшая цена стакана');
        const limit=best*(side==='BUY'?1+slippageBps/10000:1-slippageBps/10000);
        let remaining=quantity,quote=0,availableWithinLimit=0;
        for(const level of levels) {
          const price=positive(level.price,'цена стакана'),volume=positive(level.quantity,'объём стакана');
          if(side==='BUY'?price<=limit+best*1e-12:price>=limit-best*1e-12)availableWithinLimit+=volume;
          const take=Math.min(remaining,volume);quote+=take*price;remaining-=take;
          if(remaining<=quantity*1e-10)break;
        }
        const average=remaining<=quantity*1e-10?quote/quantity:null;
        const impact=average===null?Infinity:(side==='BUY'?(average-best)/best:(best-average)/best)*10000;
        if(remaining>quantity*1e-10||impact>slippageBps+1e-8||availableWithinLimit+quantity*1e-10<quantity*depthSafety) {
          throw Object.assign(new Error('LBank: MARKET-вход заблокирован — полный объём больше не укладывается в лимит глубины/impact'),{code:'ENTRY_DEPTH_CHANGED'});
        }
      }
      if(args.expiresAt!=null && (!Number.isFinite(args.expiresAt) || Date.now()>=args.expiresAt)) fail('LBank: цена/время лимитной заявки устарели до отправки');
      if(prepared) shared.preparedEntries.delete(symbol);
      beforeWrite();
      const response=await method(attachedProtection?'/cfd/cff/v1/SendTriggerOrderInsert':'/cfd/cff/v1/SendOrderInsert')(payload);
      // Same acknowledgement shapes consumed by the Futures client, not inferred fills.
      const ids=typeof response?.orderSysID==='string'?[response.orderSysID]:Array.isArray(response)?response.filter(r=>r?.data&&!r.data.TriggerOrderType&&typeof r.data.OrderSysID==='string').map(r=>r.data.OrderSysID):[];
      const unique=[...new Set(ids)];
      if(unique.length!==1) fail('LBank: ордер отправлен, но точный ID не получен. Требуется сверка без повторной отправки.');
      return {ok:true,value:{exchange:'lbank',orderId:exactId(unique[0]),clientOrderId:args.clientOrderId}};
    }
    fail('Неизвестная операция LBank');
  } catch(error) {
    const code=Number(error?.code);
    const makerRejection=operation==='place'&&args.postOnly===true&&(error?.code==='POST_ONLY_WOULD_TAKE'||[187,188].includes(code));
    // Captured from the live Futures page: code 31 is returned when a close
    // races with an already empty/changed position. It is not success; the
    // engine must prove the resulting position with a fresh snapshot.
    const noPosition=operation==='place'&&args.reduceOnly===true&&code===31;
    const missingProtection=operation==='cancelProtection'&&code===24;
    const knownCode=makerRejection?'POST_ONLY_WOULD_TAKE':noPosition?'NO_POSITION':missingProtection?'PROTECTION_NOT_FOUND':['ORDER_PENDING_HISTORY','ORDER_EVENTS_UNAVAILABLE','SNAPSHOT_REFRESH_PENDING','MARKET_STREAM_PENDING','LOCAL_REQUEST_CANCELED','PROTECTION_NOT_FOUND','ENTRY_DEPTH_CHANGED','ENTRY_PREFLIGHT_EXPIRED'].includes(error?.code)?error.code:undefined;
    // Once a write starts, an unobserved LBank code is not assumed definitive.
    // The original intent stays journaled and no second write is authorized.
    const definitive=makerRejection || noPosition || missingProtection || !writeStarted;
    return {ok:false,definitive,code:knownCode,exchangeCode:!missingProtection&&Number.isSafeInteger(code)&&code!==0&&code!==200?String(code):undefined,orderId:error?.orderId,httpStatus:error?.httpStatus,retryAfterMs:error?.retryAfterMs,endpoint:error?.endpoint,error:makerRejection?'LBank: рынок сдвинулся; пересчитываем цену maker-заявки':`${String(error?.message || 'LBank Futures: запрос не выполнен').slice(0,300)}${Number.isSafeInteger(code)?` [${code}]`:''}`};
  }
}
module.exports={executeFuturesCommand};
