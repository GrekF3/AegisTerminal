const { commonStep } = require("./order-sizing.cjs");

const finite = (value) => value !== "" && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const commonSymbol = (value) => String(value || "").toUpperCase().replace(/-SWAP$/, "").replace(/[_-]/g, "");
function rows(value, exchange) {
  if (!Array.isArray(value)) throw new Error(`${exchange}: неожиданный формат позиций`);
  return value;
}
function position(exchange, raw, value) {
  if (!Number.isFinite(value.quantity)) throw new Error(`${exchange}: некорректный объём позиции`);
  return {
    id: `${exchange}:${value.symbol}:${value.side}:${value.marginMode || ""}:${raw.posId || raw.positionId || raw.pid || ""}`,
    exchange, ...value, quantity: Math.abs(value.quantity),
    entryPrice: finite(value.entryPrice), markPrice: finite(value.markPrice),
    unrealizedPnl: finite(value.unrealizedPnl), realizedPnl: finite(value.realizedPnl),
    leverage: finite(value.leverage), liquidationPrice: finite(value.liquidationPrice), margin: finite(value.margin),
  };
}

// Only normalized account data crosses IPC; raw API responses and credentials stay in the main process.
function installAccountCapabilities(id, adapter) {
  if (id === "lbank") return; // No invented private endpoints: fail closed until the private contract spec is available.
  const specCache = new Map();
  async function specFor(symbol, credentials) {
    const cached = specCache.get(symbol);
    if (cached?.expiresAt > Date.now()) return cached.value;
    const value = await (adapter.getContractSpec || adapter.getSymbolSpec)(symbol, credentials);
    specCache.set(symbol, { value, expiresAt: Date.now() + 300_000 });
    return value;
  }
  adapter.getTradingRules = async (symbol, credentials) => {
    const spec = await specFor(symbol, credentials);
    const multiplier = spec.contractSize || 1;
    const step = id === "binance" ? commonStep(spec.lotStep, spec.marketStep) : (spec.qtyStep || spec.lotSize || spec.volumeStep || 1) * multiplier;
    return { quantityStep: step, minQuantity: Math.max(spec.minQty || 0, spec.marketMinQty || 0, (spec.minContracts || spec.minVolume || 0) * multiplier), minNotional: spec.minNotional || 0, tickSize: spec.tickSize || null, maxLeverage: spec.maxLeverage || null };
  };
  adapter.getPositions = async (credentials) => {
    let raw;
    if (id === "binance") raw = await adapter.signedRequest("GET", "/fapi/v3/positionRisk", credentials);
    if (id === "okx") raw = (await adapter.request("GET", "/api/v5/account/positions", credentials, { instType: "SWAP" }, true)).data;
    // Gate returns all positions when limit is omitted; an explicit limit cannot exceed 100.
    if (id === "gateio") raw = await adapter.request("GET", "/futures/usdt/positions", credentials, { holding: "true" }, true);
    if (id === "bitget") raw = (await adapter.request("GET", "/api/v2/mix/position/all-position", credentials, { productType: "USDT-FUTURES", marginCoin: "USDT" }, true)).data;
    if (id === "mexc") raw = (await adapter.privateRequest("GET", "/api/v1/private/position/open_positions", credentials)).data;
    if (id === "bybit") {
      raw = []; let cursor = ""; const seen = new Set();
      do {
        const result = (await adapter.privateRequest("GET", "/v5/position/list", credentials, { category: "linear", settleCoin: "USDT", limit: "200", ...(cursor ? { cursor } : {}) })).result;
        raw.push(...rows(result?.list, id));
        cursor = result.nextPageCursor || "";
        if (cursor && seen.has(cursor)) throw new Error("Bybit: повтор страницы позиций");
        seen.add(cursor);
      } while (cursor);
    }
    const active = rows(raw, id).filter((p) => {
      const symbol = commonSymbol(p.symbol || p.instId || p.contract);
      return symbol.endsWith("USDT") && Number(p.positionAmt ?? p.pos ?? p.size ?? p.total ?? p.holdVol) !== 0;
    });
    return Promise.all(active.map(async (p) => {
      const symbol = commonSymbol(p.symbol || p.instId || p.contract);
      let value;
      if (id === "binance") value = { symbol, quantity: Number(p.positionAmt), side: Number(p.positionAmt) > 0 ? "long" : "short", entryPrice: p.entryPrice, markPrice: p.markPrice, unrealizedPnl: p.unRealizedProfit, margin: p.positionInitialMargin, leverage: p.leverage, liquidationPrice: p.liquidationPrice, marginMode: Number(p.isolatedMargin) > 0 ? "isolated" : "cross" };
      if (id === "bybit") value = { symbol, quantity: Number(p.size), side: p.side === "Buy" ? "long" : "short", entryPrice: p.avgPrice, markPrice: p.markPrice, unrealizedPnl: p.unrealisedPnl, realizedPnl: p.curRealisedPnl, margin: p.positionIM, leverage: p.leverage, liquidationPrice: p.liqPrice };
      if (id === "bitget") value = { symbol, quantity: Number(p.total), side: p.holdSide, entryPrice: p.openPriceAvg, markPrice: p.markPrice, unrealizedPnl: p.unrealizedPL, realizedPnl: p.achievedProfits, margin: p.marginSize, leverage: p.leverage, liquidationPrice: p.liquidationPrice, marginMode: p.marginMode };
      if (["okx", "gateio", "mexc"].includes(id)) {
        const { contractSize } = await specFor(symbol, credentials);
        if (id === "okx") value = { symbol, quantity: Number(p.pos) * contractSize, side: p.posSide === "net" ? Number(p.pos) > 0 ? "long" : "short" : p.posSide, entryPrice: p.avgPx, markPrice: p.markPx, unrealizedPnl: p.upl, realizedPnl: p.realizedPnl, margin: p.mgnMode === "isolated" ? p.margin : p.imr, leverage: p.lever, liquidationPrice: p.liqPx, marginMode: p.mgnMode };
        if (id === "gateio") value = { symbol, quantity: Number(p.size) * contractSize, side: Number(p.size) > 0 ? "long" : "short", entryPrice: p.entry_price, markPrice: p.mark_price, unrealizedPnl: p.unrealised_pnl, realizedPnl: p.realised_pnl, margin: p.initial_margin ?? p.margin, leverage: Number(p.leverage) || p.cross_leverage_limit, liquidationPrice: p.liq_price, marginMode: Number(p.leverage) === 0 ? "cross" : "isolated" };
        if (id === "mexc") value = { symbol, quantity: Number(p.holdVol) * contractSize, side: Number(p.positionType) === 1 ? "long" : "short", entryPrice: p.holdAvgPrice, markPrice: p.fairPrice, unrealizedPnl: p.unRealizedPnl, realizedPnl: p.realised, margin: p.im, leverage: p.leverage, liquidationPrice: p.liquidatePrice, marginMode: Number(p.openType) === 1 ? "isolated" : "cross" };
      }
      return position(id, p, value);
    }));
  };
  adapter.getOpenOrders = async (credentials) => {
    let raw;
    if (id === "binance") raw = await adapter.signedRequest("GET", "/fapi/v1/openOrders", credentials);
    if (id === "okx") {
      const [ordinary,protectedOrders]=await Promise.all([
        adapter.request("GET", "/api/v5/trade/orders-pending", credentials, { instType: "SWAP", limit: "100" }, true),
        adapter.request("GET", "/api/v5/trade/orders-algo-pending", credentials, { ordType: "oco", instType: "SWAP", limit: "100" }, true),
      ]);
      const regular=rows(ordinary.data,id), algos=rows(protectedOrders.data,id);
      if(regular.length>=100 || algos.length>=100) throw new Error("Слишком много OKX ордеров для полного снимка: запуск приостановлен");
      raw=[...regular,...algos.map(order=>({...order,orderType:'TRIGGER'}))];
    }
    if (id === "gateio") raw = await adapter.request("GET", "/futures/usdt/orders", credentials, { status: "open", limit: "100" }, true);
    if (id === "bitget") raw = (await adapter.request("GET", "/api/v2/mix/order/orders-pending", credentials, { productType: "USDT-FUTURES", limit: "100" }, true)).data?.entrustedList;
    if (id === "mexc") raw = (await adapter.privateRequest("GET", "/api/v1/private/order/list/open_orders", credentials, { page_num: "1", page_size: "100" })).data;
    if (id === "bybit") raw = (await adapter.privateRequest("GET", "/v5/order/realtime", credentials, { category: "linear", settleCoin: "USDT", openOnly: "0", limit: "50" })).result?.list;
    const list = rows(raw, id);
    // Do not claim a full account snapshot if a venue's response may be truncated.
    if (id !== "binance" && list.length >= (id === "bybit" ? 50 : 100)) throw new Error("Слишком много ордеров для одного снимка: проверка запуска приостановлена");
    return Promise.all(list.filter((p) => commonSymbol(p.symbol || p.instId || p.contract).endsWith("USDT")).map(async (p) => {
      const symbol = commonSymbol(p.symbol || p.instId || p.contract);
      const multiplier = ["okx", "gateio", "mexc"].includes(id) ? (await specFor(symbol, credentials)).contractSize : 1;
      const quantity = Number(p.origQty ?? p.qty ?? p.sz ?? p.size ?? p.vol);
      const buy = id === "gateio" ? quantity > 0 : id === "mexc" ? [1, 2].includes(Number(p.side)) : String(p.side).toLowerCase() === "buy";
      return { id: `${id}:${p.clientOrderId || p.orderLinkId || p.clOrdId || p.clientOid || p.text || p.externalOid || p.orderId || p.ordId || p.id}`, exchange: id, symbol, side: buy ? "buy" : "sell", quantity: Math.abs(quantity) * multiplier, price: finite(p.price ?? p.px), type: String(p.orderType || p.ordType || p.type || "LIMIT").toUpperCase(), status: String(p.orderStatus || p.status || p.state || "OPEN") };
    }));
  };
  adapter.configureLeverage = async (credentials, { symbol, leverage, side, marginMode: requestedMode }, options = {}) => {
    if (options.allowLiveTrading !== true) throw new Error("Изменение плеча требует live-подтверждения");
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error("Плечо должно быть целым числом от 1 до 125");
    const marginMode = require('../trading/margin-mode.cjs').marginMode(requestedMode);
    if (!['okx','gateio','mexc'].includes(id)) await adapter.verifyMarginMode(credentials, {symbol,marginMode});
    if (id === "binance") return adapter.signedRequest("POST", "/fapi/v1/leverage", credentials, { symbol, leverage: String(leverage) });
    if (id === "bybit") {
      try { return await adapter.privateRequest("POST", "/v5/position/set-leverage", credentials, { category: "linear", symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) }); }
      catch (error) { if (!/leverage not modified/i.test(error.message)) throw error; }
    }
    if (id === "okx") return adapter.ensureLeverage(credentials, { symbol, leverage, side, marginMode, positionMode: await adapter.getPositionMode(credentials) });
    if (id === "bitget") return adapter.request("POST", "/api/v2/mix/account/set-leverage", credentials, { symbol, productType: "USDT-FUTURES", marginCoin: "USDT", leverage: String(leverage), ...(marginMode==='isolated'?{holdSide:side==='BUY'?'long':'short'}:{}) }, true);
    if (id === "gateio") {
      const account = await adapter.request("GET", "/futures/usdt/accounts", credentials, {}, true);
      const route = account.in_dual_mode ? "dual_comp/positions" : "positions";
      // Gate's leverage endpoint takes query parameters even though it is POST.
      const result = await adapter.request("POST", `/futures/usdt/${route}/${adapter.toContract(symbol)}/leverage`, credentials, marginMode==='isolated'?{leverage:String(leverage)}:{leverage:'0',cross_leverage_limit:String(leverage)}, true, true);
      await adapter.verifyMarginMode(credentials,{symbol,marginMode});
      return result;
    }
    if (id === "mexc") {
      // The existing adapter submits leverage with every new isolated-position order.
      return {symbol,leverage,marginMode};
    }
  };
  adapter.verifyMarginMode = async (credentials, {symbol, marginMode: requestedMode}) => {
    const mode=require('../trading/margin-mode.cjs').marginMode(requestedMode);
    let actual;
    if(id==='binance') {
      const response=await adapter.signedRequest('GET','/fapi/v1/symbolConfig',credentials,{symbol});
      const row=Array.isArray(response)?response.find(r=>r.symbol===symbol):null;
      actual=String(row?.marginType||'').toLowerCase();if(actual==='crossed')actual='cross';
      if(mode==='isolated'&&row?.isAutoAddMargin===true)throw Object.assign(new Error('Binance: отключите автоматическое добавление маржи перед изолированным хеджем'),{definitive:true});
    }
    if(id==='bybit') {const r=(await adapter.privateRequest('GET','/v5/account/info',credentials,{})).result;actual=({ISOLATED_MARGIN:'isolated',REGULAR_MARGIN:'cross'})[r?.marginMode];}
    if(id==='bitget') {const r=(await adapter.request('GET','/api/v2/mix/account/account',credentials,{symbol,productType:'USDT-FUTURES',marginCoin:'USDT'},true)).data;actual=r?.marginMode==='crossed'?'cross':r?.marginMode;}
    if(id==='gateio') {
      const account=await adapter.request('GET','/futures/usdt/accounts',credentials,{},true);
      const route=account.in_dual_mode?'dual_comp/positions':'positions';
      const response=await adapter.request('GET',`/futures/usdt/${route}/${adapter.toContract(symbol)}`,credentials,{},true);
      const list=Array.isArray(response)?response:[response];
      if(list.length && list.every(r=>r?.leverage!=null&&(Number(r.leverage)===0?'cross':'isolated')===mode))actual=mode;
    }
    // These venues select the requested mode explicitly in every order body.
    if(id==='okx'||id==='mexc')return;
    if(actual!==mode)throw Object.assign(new Error(`${id}: режим маржи ${mode} не подтверждён. Выберите его на бирже перед запуском хеджа.`),{definitive:true,code:'MARGIN_MODE_MISMATCH'});
  };
  const originalPlace=adapter.placeOrder;
  if(originalPlace)adapter.placeOrder=async(credentials,order,options={})=>{
    if(options.allowLiveTrading!==true)throw new Error('Live trading заблокирован: нет подтверждения реальной торговли');
    if(!order.reduceOnly)try{await adapter.verifyMarginMode(credentials,order);}catch(error){error.definitive=true;throw error;}
    return originalPlace(credentials,order,options);
  };
  if (["okx", "gateio", "mexc"].includes(id)) {
    const originalDepth = adapter.getDepth;
    adapter.getDepth = async (symbol, depth, credentials) => {
      const [book, spec] = await Promise.all([originalDepth(symbol, depth, credentials), specFor(symbol, credentials)]);
      return { ...book, bids: book.bids.map((p) => ({ ...p, quantity: p.quantity * spec.contractSize })), asks: book.asks.map((p) => ({ ...p, quantity: p.quantity * spec.contractSize })) };
    };
  }
}

module.exports = { installAccountCapabilities, position, finite, commonSymbol };
