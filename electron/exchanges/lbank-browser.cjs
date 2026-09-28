const { localUrl, listProfiles, isFuturesPage, CdpConnection } = require('./undetectable.cjs');
const MODE = 'undetectable';
const { executeFuturesCommand } = require('./lbank-web-sdk.cjs');
const { retainFuturesCommand, peekFuturesReceipt } = require('./lbank-command-receipts.cjs');
const { installLBankOrderEvents } = require('./lbank-order-events.cjs');
const { installLBankRequestQueue, cancelLBankQueuedRequests } = require('./lbank-request-queue.cjs');
const { installLBankPublicStream } = require('./lbank-public-stream.cjs');
const { randomUUID } = require('node:crypto');
const { LBankWireRecorder } = require('./lbank-wire-recorder.cjs');
const { exchangeApiError } = require('./exchange-errors.cjs');
const manualMode = (credentials) => credentials?.connectionMode === MODE;

// Executed only inside the user-selected futures tab. No tokens/cookies leave the page.
async function readFuturesAccount() {
  try {
    if (location.origin !== 'https://www.lbank.com' || !/\/futures\//.test(location.pathname)) return { ok: false, error: 'Откройте вкладку фьючерсов LBank' };
    let require;
    if (!Array.isArray(self.webpackChunk_N_E)) return { ok: false, error: 'Дождитесь загрузки LBank Futures' };
    self.webpackChunk_N_E.push([[`hedge_read_${Date.now()}`], {}, r => { require = r; }]);
    const id = Object.keys(require?.m || {}).find(id => {
      const text = String(require.m[id]);
      return text.includes('/cfd/query/v1.0/Account') && text.includes('/cfd/cff/v1/SendOrderInsert');
    });
    if (!id) return { ok: false, error: 'Версия LBank Futures SDK не поддерживается' };
    const api = require(id);
    const accountMethod = Object.values(api).find(fn => typeof fn === 'function' && String(fn).includes('"/cfd/query/v1.0/Account"'));
    if (!accountMethod) return { ok: false, error: 'LBank Futures: метод баланса не найден' };
    const result = await accountMethod({ SettlementGroup: 'SwapU', Currency: 'USDT', isSubAccount: 0, pageIndex: 1, pageSize: 20 });
    const rows = Array.isArray(result) ? result : result?.data;
    if (!Array.isArray(rows)) return { ok: false, error: 'Войдите в LBank: futures-баланс не получен' };
    const row = rows.find(r => String(r.Currency ?? r.currency).toUpperCase() === 'USDT');
    const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
    const available = number(row?.Available ?? row?.available);
    const balance = number(row?.Balance ?? row?.balance);
    // Account.Balance is wallet balance, not equity; do not silently call it total equity.
    if (available === null || balance === null) return { ok: false, error: 'LBank не вернул USDT Available/Balance' };
    return { ok: true, account: { exchange: 'lbank', asset: 'USDT', available, total: balance, balanceKind: 'wallet', rawUpdatedAt: Date.now() } };
  } catch { return { ok: false, error: 'LBank Futures: чтение счёта не удалось. Проверьте вход в профиле.' }; }
}
async function readFuturesRecords(kind) {
  try {
    if (!['positions', 'orders'].includes(kind) || location.origin !== 'https://www.lbank.com' || !/\/futures\//.test(location.pathname)) throw new Error('Invalid read');
    let require;
    self.webpackChunk_N_E.push([[`hedge_records_${Date.now()}`], {}, r => { require = r; }]);
    const id = Object.keys(require?.m || {}).find(id => {
      const text = String(require.m[id]);
      return text.includes('/cfd/query/v1.0/Account') && text.includes('/cfd/cff/v1/SendOrderInsert');
    });
    if (!id) throw new Error('Unknown SDK');
    const api = require(id);
    const method = endpoint => {
      const fn = Object.values(api).find(fn => typeof fn === 'function' && String(fn).includes(JSON.stringify(endpoint)));
      if (!fn) throw new Error('Unknown read method');
      return fn;
    };
    const rows = value => {
      const result = Array.isArray(value) ? value : value?.data;
      // Never pretend a truncated/error response is a complete empty account.
      if (!Array.isArray(result) || result.length >= 1000) throw new Error('Incomplete response');
      return result;
    };
    const params = { ProductGroup: 'SwapU', ExchangeID: 'Exchange', pageIndex: 1, pageSize: 1000 };
    const groups = kind === 'positions'
      ? [rows(await method('/cfd/query/v1.0/Position')({ ...params, Valid: '1' }))]
      : await Promise.all([
        method('/cfd/query/v1.0/Order')(params),
        method('/cfd/query/v1.0/TriggerOrder')({ ...params, TriggerOrderType: '3' }),
        method('/cfd/query/v1.0/TriggerOrder')({ ...params, TriggerOrderType: '12' }),
      ]).then(values => values.map(rows));
    if (!groups.some(group => group.length)) return { ok: true, records: [] };
    const catalogApi = Object.values(api).find(value => value && typeof value.cfdAggV1Instrument === 'function');
    if (!catalogApi) throw new Error('Missing contract metadata');
    const catalog = await catalogApi.cfdAggV1Instrument({ ProductGroup: 'SwapU' });
    if (!Array.isArray(catalog)) throw new Error('Invalid contract metadata');
    const number = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
    const get = (row, key) => row[key] ?? row[key[0].toLowerCase() + key.slice(1)];
    const records = groups.flatMap((group, groupIndex) => group.map(row => {
      const symbol = String(get(row, 'InstrumentID') || '').toUpperCase();
      if (!/^[A-Z0-9]+USDT$/.test(symbol)) throw new Error('Unsupported settlement currency');
      const meta = catalog.find(item => item.instrument?.instrumentID === symbol);
      const multiplier = number(meta?.instrument?.volumeMultiple);
      if (!(multiplier > 0) || Number(meta.instrument.isInverse) !== 0) throw new Error('Unsupported contract units');
      const direction = String(get(row, 'Direction'));
      if (!['0', '1'].includes(direction)) throw new Error('Unknown direction');
      if (kind === 'positions') {
        const contracts = number(get(row, 'Position'));
        if (contracts === null || contracts < 0) throw new Error('Invalid position quantity');
        if (contracts === 0) return null;
        return { id: `lbank:${symbol}:${direction}:${group.indexOf(row)}`, exchange: 'lbank', symbol, side: direction === '0' ? 'long' : 'short', quantity: contracts * multiplier,
          entryPrice: number(get(row, 'OpenPrice')), markPrice: number(meta.marketData?.markedPrice),
          unrealizedPnl: number(get(row, 'PositionProfit')), realizedPnl: null,
          margin: number(get(row, 'UseMargin')), leverage: number(get(row, 'Leverage')), liquidationPrice: number(get(row, 'LiquidationPrice')),
          marginMode: String(get(row, 'IsCrossMargin')) === '1' ? 'cross' : String(get(row, 'IsCrossMargin')) === '0' ? 'isolated' : undefined };
      }
      const orderId = get(row, 'OrderSysID') ?? get(row, 'TriggerOrderID');
      if (!(typeof orderId === 'string' && orderId) && !(typeof orderId === 'number' && Number.isSafeInteger(orderId))) throw new Error('Invalid order ID precision');
      const quantity = number(get(row, 'VolumeRemain') ?? get(row, 'Volume'));
      if (quantity === null || quantity < 0) throw new Error('Invalid order quantity');
      return { id: `lbank:${groupIndex}:${orderId}`, exchange: 'lbank', symbol, side: direction === '0' ? 'buy' : 'sell', quantity: quantity * multiplier,
        price: number(get(row, 'Price')), type: groupIndex ? 'TRIGGER' : String(get(row, 'OrderPriceType')) === '4' ? 'MARKET' : 'LIMIT',
        status: groupIndex ? 'CONDITIONAL' : ({ '1': 'FILLED', '2': 'PARTIALLY_FILLED', '3': 'CANCELED', '4': 'NEW', '6': 'CANCELED' }[String(get(row, 'OrderStatus'))] || 'UNKNOWN') };
    })).filter(Boolean);
    return { ok: true, records };
  } catch { return { ok: false, error: `LBank Futures: не удалось прочитать ${kind === 'positions' ? 'позиции' : 'ордера'}. Проверьте профиль; неизвестные данные не заменены нулями.` }; }
}
class LBankBrowser {
  constructor({ profiles = listProfiles, connect = CdpConnection.connect } = {}) { this.profiles = profiles; this.connectCdp = connect; this.connection = null; this.sessionId = null; this.key = null; this.connecting = null; this.generation = 0; this.identity = null; this.submissions = new Map(); this.requestScope = randomUUID(); this.recorder = null; this.lastRecorderStatus = null; }
  configKey(c) { return JSON.stringify(['http://127.0.0.1:25325', c.undetectableProfileId]); }
  isConnected(c) { return Boolean(this.connection && !this.connection.closed && this.key === this.configKey(c)); }
  async connect(c) {
    if (this.connecting) throw new Error('Подключение Undetectable уже выполняется');
    this.connecting = this.attach(c);
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async attach(c) {
    this.disconnect();
    const generation = this.generation;
    const ensureCurrent = () => { if (this.generation !== generation) throw new Error('Подключение Undetectable отменено'); };
    const key = this.configKey(c);
    const profiles = await this.profiles();
    ensureCurrent();
    const profile = profiles.find(p => p.id === c.undetectableProfileId);
    if (!profile) throw new Error('Выберите профиль Undetectable');
    if (profile.status !== 'Started') throw new Error('Сначала запустите выбранный профиль в Undetectable');
    let connection;
    try {
      connection = await this.connectCdp(localUrl(profile.endpoint, true));
      ensureCurrent();
      const { targetInfos } = await connection.send('Target.getTargets');
      ensureCurrent();
      const pages = targetInfos.filter(t => t.type === 'page' && isFuturesPage(t.url));
      if (pages.length > 1) throw new Error('Оставьте одну вкладку LBank Futures в выбранном профиле');
      const targetId = pages[0]?.targetId || (await connection.send('Target.createTarget', { url: 'https://www.lbank.com/futures/btcusdt' })).targetId;
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
      ensureCurrent();
      this.connection = connection; this.sessionId = sessionId; this.key = key;
      // A new tab may not yet have its client loaded. Only this manual attach waits.
      for (let attempt = 0; attempt < 30; attempt++) {
        const ready = await connection.send('Runtime.evaluate', { expression: "location.origin === 'https://www.lbank.com' && /\\/futures\\//.test(location.pathname) && Array.isArray(self.webpackChunk_N_E)", returnByValue: true }, sessionId);
        if (ready.result?.value === true) break;
        ensureCurrent();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const account = await this.getAccount(c);
      ensureCurrent();
      return account;
    } catch (error) { connection?.close(); this.connection = null; this.sessionId = null; this.key = null; throw error; }
  }
  async getAccount(c) {
    return this.command(c, 'account');
  }
  async getRecords(c, kind) {
    return this.command(c, kind);

  }
  async command(c, operation, args = {}) {
    if (!this.isConnected(c)) throw Object.assign(new Error('LBank · Undetectable: подключите запущенный профиль вручную'), {definitive:true});
    const generation=this.generation, connection=this.connection, scope=this.requestScope, identity=this.identity;
    const requestId=operation==='place' ? `place:${args.clientOrderId}` : operation==='protect' ? `protect:${args.clientOrderId}` : randomUUID();
    let result;
    try {
      result=await connection.send('Runtime.evaluate',{expression:`((${installLBankRequestQueue.toString()})(),(${installLBankPublicStream.toString()})(),(${installLBankOrderEvents.toString()})(${JSON.stringify(scope)},${JSON.stringify(identity)}),(${retainFuturesCommand.toString()})((${executeFuturesCommand.toString()}),${JSON.stringify(operation)},${JSON.stringify(args)},${JSON.stringify(identity)},${JSON.stringify({scope,requireOrderEvents:true})},${JSON.stringify(requestId)}))`,awaitPromise:true,returnByValue:true},this.sessionId);
    } catch (error) {
      // Recover the original result, NEVER evaluate the trading command twice.
      // Navigation or transport loss leaves no reliable receipt => stay unknown.
      for(let attempt=0;attempt<8;attempt++) {
        if(generation!==this.generation || connection!==this.connection || !this.isConnected(c)) throw error;
        let receipt;
        try { receipt=await this.readReceipt(c,requestId,{scope,identity}); } catch { throw error; }
        if(receipt.state==='done') { result={result:{value:receipt.response}}; break; }
        if(receipt.state!=='pending' || attempt===7) throw error;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
    }
    if(generation!==this.generation || !this.isConnected(c)) throw new Error('Подключение Undetectable прервано; результат запроса требует сверки');
    const response=result.result?.value;
    if(result.exceptionDetails || !response?.ok) {
      const properties={orderId:response?.orderId,httpStatus:response?.httpStatus,retryAfterMs:response?.retryAfterMs,endpoint:response?.endpoint};
      if(response?.exchangeCode!=null) throw exchangeApiError('lbank',response.exchangeCode,response?.error || 'запрос отклонён',properties);
      throw Object.assign(new Error(response?.error || 'LBank Futures: ответ браузера не получен'),{definitive:response?.definitive===true,code:response?.code,...properties});
    }
    if(operation==='account') {
      if(!/^[a-f0-9]{64}$/.test(response.identity || '')) throw new Error('LBank: не удалось подтвердить владельца счёта');
      if(this.identity && this.identity!==response.identity) throw new Error('В профиле изменился аккаунт LBank');
      this.identity=response.identity;
      // Capture terminal events as soon as manual connection completes, before
      // the user or the next bot command can submit an order on this page.
      const installed=await connection.send('Runtime.evaluate',{expression:`(${installLBankOrderEvents.toString()})(${JSON.stringify(scope)},${JSON.stringify(this.identity)})`,returnByValue:true},this.sessionId);
      if(generation!==this.generation || !this.isConnected(c)) throw new Error('Подключение Undetectable прервано');
      this.orderEventsState=installed.result?.value?.state || 'unavailable';
    }
    return response.value;
  }
  async readReceipt(c,requestId,{scope=this.requestScope,identity=this.identity}={}) {
    if(!this.isConnected(c)) throw new Error('LBank: для сверки нужна исходная вкладка Undetectable');
    const generation=this.generation;
    const result=await this.connection.send('Runtime.evaluate',{expression:`(${peekFuturesReceipt.toString()})(${JSON.stringify(scope)},${JSON.stringify(requestId)},${JSON.stringify(identity)})`,returnByValue:true},this.sessionId);
    if(generation!==this.generation || !this.isConnected(c) || result.exceptionDetails) throw new Error('LBank: подтверждение запроса недоступно');
    return result.result?.value || {state:'missing'};
  }
  getPositions(c) { return this.command(c,'positions'); }
  getClosePlan(c,request) { return this.command(c,'closePlan',{symbol:request.symbol,side:request.side,quantity:request.quantity}); }
  getOpenOrders(c) { return this.command(c,'orders'); }
  getProtection(c,request) { return this.command(c,'protection',{...request}); }
  getMarkets(c) { return this.command(c,'markets'); }
  getFeeRates(c) { return this.command(c,'fees'); }
  getTradingRules(symbol,c) { return this.command(c,'rules',{symbol}); }
  getDepth(symbol,depth,c) { return this.command(c,'depth',{symbol,depth}); }
  getDayOpen(symbol,c) { return this.command(c,'dayOpen',{symbol}); }
  async getOrder(c,order) {
    let orderId=order.orderId;
    if(!orderId) {
      const entry=this.submissions.get(order.clientOrderId);
      if(!entry || entry.scope!==this.requestScope || entry.identity!==this.identity || entry.args.symbol!==order.symbol
        || (order.side!=null && entry.args.side!==order.side) || (order.quantity!=null && entry.args.quantity!==order.quantity)) {
        throw new Error('LBank: неизвестный или неточный ID ордера; подтверждение исходного запроса недоступно');
      }
      const receipt=await this.readReceipt(c,`place:${order.clientOrderId}`);
      if(receipt.state!=='done') throw new Error('LBank: исходный запрос ещё не подтверждён; повторная отправка заблокирована');
      const response=receipt.response;
      if(!response?.ok) {
        if(response?.definitive===true) return {status:'REJECTED',executedQty:0,quantity:entry.args.quantity,symbol:order.symbol,clientOrderId:order.clientOrderId};
        throw new Error(response?.error || 'LBank: результат исходного запроса неизвестен');
      }
      if(response.value?.clientOrderId!==order.clientOrderId) throw new Error('LBank: подтверждение относится к другому запросу');
      orderId=response.value.orderId;
    }
    return this.command(c,'order',{symbol:order.symbol,orderId,quantity:order.quantity,side:order.side});
  }
  configureLeverage(c,request,options={}) { return this.command(c,'leverage',{symbol:request.symbol,leverage:request.leverage,marginMode:request.marginMode,allowLiveTrading:options.allowLiveTrading===true}); }
  async cancelOrder(c,order,options={}) {
    let orderId=order.orderId;
    if(!orderId) {
      const known=await this.getOrder(c,order);
      if(['FILLED','CANCELED','REJECTED','EXPIRED'].includes(known.status)) return known;
      orderId=known.orderId;
    }
    return this.command(c,'cancel',{symbol:order.symbol,orderId,allowLiveTrading:options.allowLiveTrading===true});
  }
  placeProtection(c,request,options={}) {
    if(options.allowLiveTrading!==true) return Promise.reject(Object.assign(new Error('Серверный TP/SL требует live-подтверждения'),{definitive:true}));
    return this.command(c,'protect',{...request,allowLiveTrading:true});
  }
  cancelProtection(c,request,options={}) {
    if(options.allowLiveTrading!==true) return Promise.reject(Object.assign(new Error('Отмена серверного TP/SL требует live-подтверждения'),{definitive:true}));
    return this.command(c,'cancelProtection',{...request,allowLiveTrading:true});
  }
  placeOrder(c,order,options={}) {
    if(options.allowLiveTrading!==true) return Promise.reject(Object.assign(new Error('Live trading требует подтверждения'),{definitive:true}));
    const args={symbol:order.symbol,quantity:order.quantity ?? order.volume,side:order.side,type:order.type,postOnly:order.postOnly===true,expiresAt:order.expiresAt,reduceOnly:order.reduceOnly===true,positionId:order.positionId,price:order.price,leverage:order.leverage,marginMode:order.marginMode,clientOrderId:order.clientOrderId,protection:order.protection,fastPrepared:order.fastPrepared===true,
      maxEntrySlippageBps:order.maxEntrySlippageBps,depthSafetyMultiplier:order.depthSafetyMultiplier,allowLiveTrading:true};
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(args.clientOrderId || '')) return Promise.reject(Object.assign(new Error('LBank: нужен уникальный ID намерения'),{definitive:true}));
    const signature=JSON.stringify(args), previous=this.submissions.get(args.clientOrderId);
    if(previous) return previous.signature===signature ? previous.promise : Promise.reject(Object.assign(new Error('LBank: ID уже использован с другими параметрами'),{definitive:true}));
    const entry={signature,args,scope:this.requestScope,identity:this.identity,settled:false,promise:null};
    entry.promise=this.command(c,'place',args).then(value=>{entry.settled=true;return value;});
    this.submissions.set(args.clientOrderId,entry);
    // Unknown outcomes stay remembered. Only acknowledged old intentions may be evicted.
    if(this.submissions.size>2000) for(const [id,value] of this.submissions) {if(value.settled){this.submissions.delete(id);break;}}
    return entry.promise;
  }
  cancelQueuedRequests() {
    if(!this.connection || !this.sessionId) return Promise.resolve();
    return this.connection.send('Runtime.evaluate',{expression:`(${cancelLBankQueuedRequests.toString()})(${JSON.stringify(this.requestScope)})`,returnByValue:true},this.sessionId);
  }
  async startRecorder(directory) {
    if (!this.connection || this.connection.closed || !this.sessionId) throw new Error('Сначала подключите профиль LBank · Undetectable');
    if (this.recorder?.status().active) return this.recorder.status();
    this.recorder = new LBankWireRecorder({ connection: this.connection, sessionId: this.sessionId, directory });
    this.lastRecorderStatus = await this.recorder.start();
    return this.lastRecorderStatus;
  }
  recorderStatus() { return this.recorder?.status() || this.lastRecorderStatus || { active: false, eventCount: 0, filePath: null, fileName: null, directory: null, startedAt: null, captureId: null, error: null }; }
  async markRecorder(marker) { if (!this.recorder?.status().active) throw new Error('Сначала запустите LBank recorder'); this.lastRecorderStatus = await this.recorder.mark(marker); return this.lastRecorderStatus; }
  async stopRecorder(reason = 'user') { if (!this.recorder) return this.recorderStatus(); const recorder=this.recorder; this.lastRecorderStatus = await recorder.stop(reason); if(this.recorder===recorder)this.recorder = null; return this.lastRecorderStatus; }
  disconnect() { void this.cancelQueuedRequests().catch(()=>{}); void this.stopRecorder('disconnect').catch(()=>{}); this.generation++; this.requestScope = randomUUID(); this.connection?.close(); this.connection = null; this.sessionId = null; this.key = null; this.identity = null; this.submissions.clear(); }
}
const browser = new LBankBrowser();
module.exports = { manualMode, LBankBrowser, browser, readFuturesAccount, readFuturesRecords };
