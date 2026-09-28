const crypto = require("crypto");
const { requestJson } = require("./transport.cjs");
const { exchangeApiError, exchangeRequest } = require("./exchange-errors.cjs");
const { floorToStep, stepPrecision } = require("./order-sizing.cjs");

const BASE_URL = "https://www.okx.com";
const {publicStream}=require('./okx-public-stream.cjs');
const {marketWithFallback}=require('./market-fallback.cjs');
let publicInstruments;

function toInstrument(symbol) {
  const clean = String(symbol || "").toUpperCase();
  if (clean.endsWith("-SWAP")) return clean;
  return clean.replace(/[_-]/g, "").replace(/USDT$/, "-USDT-SWAP");
}

function toCommonSymbol(instrument) { return String(instrument || "").replace("-USDT-SWAP", "USDT").replace(/-/g, ""); }

function sign(timestamp, method, requestPath, body, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}${method}${requestPath}${body}`).digest("base64");
}

function validateCredentials(credentials) {
  if (!credentials?.apiKey || !credentials?.secret || !credentials?.passphrase) throw new Error("OKX API Key, Secret Key и Passphrase обязательны");
}

function validateResponse(payload) {
  const operation = payload?.data?.find?.((item) => String(item?.sCode || "0") !== "0");
  if (String(payload?.code) !== "0" || operation) {
    const message = operation?.sMsg || payload?.msg || `OKX error ${operation?.sCode || payload?.code}`;
    throw exchangeApiError("okx", operation?.sCode || payload?.code, message);
  }
}

async function request(method, path, credentials = {}, parameters = {}, authenticated = false) {
  const upperMethod = String(method).toUpperCase();
  const query = upperMethod === "GET" ? new URLSearchParams(parameters).toString() : "";
  const requestPath = `${path}${query ? `?${query}` : ""}`;
  const body = upperMethod === "GET" ? "" : JSON.stringify(parameters);
  const headers = { "content-type": "application/json" };
  if (authenticated) {
    validateCredentials(credentials);
    const timestamp = new Date().toISOString();
    Object.assign(headers, { "OK-ACCESS-KEY": credentials.apiKey, "OK-ACCESS-SIGN": sign(timestamp, upperMethod, requestPath, body, credentials.secret), "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": credentials.passphrase });
  }
  return exchangeRequest("okx", requestJson(`${BASE_URL}${requestPath}`, { method: upperMethod, headers, ...(body ? { body } : {}), credentials, exchangeName: "OKX", validate: validateResponse }));
}

async function getAccount(credentials) {
  const payload = await request("GET", "/api/v5/account/balance", credentials, { ccy: "USDT" }, true);
  const account = payload.data?.[0] || {};
  const detail = account.details?.find((item) => item.ccy === "USDT") || {};
  return { exchange: "okx", asset: "USDT", available: Number(detail.availEq !== "" && detail.availEq != null ? detail.availEq : detail.availBal || 0), total: Number(detail.eq || detail.cashBal || 0), rawUpdatedAt: Date.now() };
}

async function getMarkets(credentials = {}) {
  if(!publicInstruments || publicInstruments.until<Date.now()) {
    const payload=await request('GET','/api/v5/public/instruments',credentials,{instType:'SWAP'});
    publicInstruments={until:Date.now()+600000,ids:(payload.data||[]).filter(item=>item.state==='live'&&String(item.instId).endsWith('-USDT-SWAP')).map(item=>item.instId)};
  }
  return marketWithFallback(`okx:markets:${credentials.proxyEnabled?credentials.proxyUrl:''}`,()=>publicStream(credentials).markets(publicInstruments.ids),async()=>{
    const payload=await request('GET','/api/v5/market/tickers',credentials,{instType:'SWAP'});
    return (payload.data||[]).filter(row=>String(row.instId).endsWith('-USDT-SWAP')&&Number(row.last)>0).map(row=>({symbol:toCommonSymbol(row.instId),exchangeSymbol:row.instId,lastPrice:Number(row.last),markPrice:null,high24h:Number(row.high24h),low24h:Number(row.low24h),open24h:Number(row.open24h),volume24h:Number(row.vol24h),turnover24h:Number(row.volCcy24h),fundingRate:null,transport:'http-fallback'}));
  });
}

function normalizeFeeCost(value) {
  const number = Number(value);
  return Number.isFinite(number) ? -number : null;
}

async function getFeeRates(credentials) {
  const payload = await request("GET", "/api/v5/account/trade-fee", credentials, { instType: "SWAP" }, true);
  const item = payload.data?.[0] || {};
  return { default: {
    makerFee: normalizeFeeCost(item.makerU ?? item.maker),
    takerFee: normalizeFeeCost(item.takerU ?? item.taker),
    source: "account",
  } };
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  return marketWithFallback(`okx:depth:${symbol}:${depth}:${credentials.proxyEnabled?credentials.proxyUrl:''}`,()=>publicStream(credentials).depth(toInstrument(symbol),depth),async()=>{
    const payload=await request('GET','/api/v5/market/books',credentials,{instId:toInstrument(symbol),sz:String(Math.min(depth,400))});
    const book=payload.data?.[0];if(!book||Date.now()-Number(book.ts)>3000)throw new Error('OKX: резервный стакан устарел');
    return {symbol:toCommonSymbol(symbol),bids:book.bids.map(([price,quantity])=>({price:Number(price),quantity:Number(quantity)})),asks:book.asks.map(([price,quantity])=>({price:Number(price),quantity:Number(quantity)})),receivedAt:Number(book.ts),transport:'http-fallback'};
  });
}
async function getDayOpen(symbol,credentials={}) {return marketWithFallback(`okx:day:${symbol}:${credentials.proxyEnabled?credentials.proxyUrl:''}`,()=>publicStream(credentials).dayOpen(toInstrument(symbol)),()=>require('./intraday-trend.cjs').fetchDayOpen('okx',symbol,credentials));}

async function getContractSpec(symbol, credentials = {}) {
  const instrument = toInstrument(symbol);
  const payload = await request("GET", "/api/v5/public/instruments", credentials, { instType: "SWAP", instId: instrument });
  const item = payload.data?.[0];
  const contractSize = Number(item?.ctVal) * Number(item?.ctMult || 1);
  const lotSize = Number(item?.lotSz || 1);
  const minContracts = Number(item?.minSz || lotSize);
  if (!(contractSize > 0)) throw new Error(`OKX не вернул множитель ${instrument}`);
  return { contractSize, lotSize, minContracts, tickSize: Number(item.tickSz), maxLeverage: Number(item.lever) };
}

const positionModeCache = new Map();
const leverageCache = new Map();

async function getPositionMode(credentials) {
  const cacheKey = String(credentials?.apiKey || "");
  const cached = positionModeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const payload = await request("GET", "/api/v5/account/config", credentials, {}, true);
  const value = payload.data?.[0]?.posMode === "long_short_mode" ? "long_short_mode" : "net_mode";
  positionModeCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

function positionFields(order) {
  const side = String(order?.side || "").toUpperCase();
  const positionMode = order?.positionMode || "net_mode";
  if (positionMode !== "long_short_mode") return order?.reduceOnly === true ? { reduceOnly: true } : {};
  const posSide = order?.posSide || (order?.reduceOnly === true
    ? (side === "BUY" ? "short" : "long")
    : (side === "BUY" ? "long" : "short"));
  return { posSide };
}

function normalizeLeverage(value) {
  const leverage = Math.floor(Number(value));
  return Number.isFinite(leverage) ? Math.min(Math.max(leverage, 1), 125) : null;
}

async function ensureLeverage(credentials, order) {
  if (order?.reduceOnly === true) return null;
  const leverage = normalizeLeverage(order?.leverage);
  if (!leverage) return null;
  const instrument = toInstrument(order?.symbol);
  const marginMode = require('../trading/margin-mode.cjs').marginMode(order?.marginMode);
  const parameters = { instId: instrument, lever: String(leverage), mgnMode: marginMode };
  if (marginMode === "isolated" && order?.positionMode === "long_short_mode") Object.assign(parameters, positionFields(order));
  await request("POST", "/api/v5/account/set-leverage", credentials, parameters, true);
  const verified=await request('GET','/api/v5/account/leverage-info',credentials,{instId:instrument,mgnMode:marginMode},true);
  const expectedSide=parameters.posSide;
  if(!verified.data?.some(r=>r.instId===instrument&&r.mgnMode===marginMode&&Number(r.lever)===leverage&&(!expectedSide||r.posSide===expectedSide)))throw Object.assign(new Error('OKX: плечо и режим маржи не подтверждены; вход запрещён'),{definitive:true});
  return leverage;
}

async function prepareOrder(order, credentials = {}) {
  const positionMode = order?.positionMode || await getPositionMode(credentials);
  if (order?.contracts != null) return { ...order, positionMode };
  const quantity = Number(order?.quantity ?? order?.volume);
  const spec = await getContractSpec(order?.symbol, credentials);
  const contracts = floorToStep(quantity / spec.contractSize, spec.lotSize);
  if (!(contracts >= spec.minContracts)) throw new Error(`OKX: объём меньше минимума ${spec.minContracts} контрактов`);
  return { ...order, contracts, baseQuantity: contracts * spec.contractSize, positionMode };
}

function normalizeOrder(order) {
  const type = String(order?.type || "LIMIT").toUpperCase();
  if (order.postOnly && type !== 'LIMIT') throw new Error('OKX Post-Only допускается только для LIMIT');
  const side = String(order?.side || "").toUpperCase();
  const quantity = Number(order?.contracts ?? order?.quantity ?? order?.volume);
  const price = Number(order?.price || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("OKX требует положительное количество контрактов");
  if (!['BUY', 'SELL'].includes(side)) throw new Error("OKX side должен быть BUY или SELL");
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw new Error("Для OKX LIMIT необходима цена");
  return { instId: toInstrument(order.symbol), tdMode: require('../trading/margin-mode.cjs').marginMode(order.marginMode), side: side.toLowerCase(), ordType: order.postOnly ? 'post_only' : type.toLowerCase(), sz: String(quantity), ...(type === "LIMIT" ? { px: String(price) } : {}), clOrdId: String(order.clientOrderId || `hedge${Date.now()}${crypto.randomBytes(3).toString("hex")}`).slice(0, 32), ...positionFields(order) };
}

function protectionStatus(state) {
  return ({ live: 'ACTIVE', pause: 'ACTIVE', partially_effective: 'ACTIVE', effective: 'TRIGGERED', canceled: 'CANCELED', order_failed: 'FAILED' })[String(state)] || String(state || 'UNKNOWN').toUpperCase();
}

function protectionBody(order) {
  const positionSide=String(order?.side || '').toUpperCase();
  if(!['BUY','SELL'].includes(positionSide)) throw new Error('OKX: неизвестна сторона защищаемой позиции');
  const contracts=Number(order?.contracts);
  const takeProfitPrice=Number(order?.takeProfitPrice), stopLossPrice=Number(order?.stopLossPrice);
  if(!(contracts>0) || !(takeProfitPrice>0) || !(stopLossPrice>0)) throw new Error('OKX: серверный TP/SL требует точный объём и цены');
  if(positionSide==='BUY' ? !(takeProfitPrice>stopLossPrice) : !(stopLossPrice>takeProfitPrice)) throw new Error('OKX: TP/SL расположены неверно для стороны позиции');
  const closingSide=positionSide==='BUY'?'SELL':'BUY';
  return {instId:toInstrument(order.symbol),tdMode:require('../trading/margin-mode.cjs').marginMode(order.marginMode),side:closingSide.toLowerCase(),ordType:'oco',sz:String(contracts),
    algoClOrdId:String(order.clientOrderId || `protect${Date.now()}${crypto.randomBytes(3).toString('hex')}`).slice(0,32),
    tpTriggerPx:String(takeProfitPrice),tpOrdPx:'-1',slTriggerPx:String(stopLossPrice),slOrdPx:'-1',tpTriggerPxType:'mark',slTriggerPxType:'mark',
    ...positionFields({side:closingSide,positionMode:order.positionMode,reduceOnly:true})};
}

async function placeOrder(credentials, order, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  const prepared = await prepareOrder(order, credentials);
  if(!prepared.reduceOnly)await ensureLeverage(credentials, prepared);
  const requestBody = normalizeOrder(prepared);
  require('./order-deadline.cjs').assertOrderDeadline(prepared);
  const payload = await request("POST", "/api/v5/trade/order", credentials, requestBody, true);
  const result = payload.data?.[0] || {};
  if (result.sCode && result.sCode !== "0") throw exchangeApiError("okx", result.sCode, result.sMsg || "ордер отклонён");
  return { exchange: "okx", orderId: result.ordId, clientOrderId: result.clOrdId || requestBody.clOrdId, response: payload };
}

function normalizeStatus(state) { return ({ live: "NEW", partially_filled: "PARTIALLY_FILLED", filled: "FILLED", canceled: "CANCELED", mmp_canceled: "CANCELED" })[String(state)] || String(state).toUpperCase(); }

async function getOrder(credentials, { symbol, orderId, clientOrderId }) {
  const payload = await request("GET", "/api/v5/trade/order", credentials, { instId: toInstrument(symbol), ...(orderId ? { ordId: String(orderId) } : { clOrdId: String(clientOrderId || "") }) }, true);
  const order = payload.data?.[0];
  if (!order) throw new Error("OKX не вернул ордер");
  const spec = await getContractSpec(symbol || order.instId, credentials);
  return { ...order, status: normalizeStatus(order.state), executedQty: Number(order.accFillSz || 0) * spec.contractSize };
}

async function cancelOrder(credentials, { symbol, orderId, clientOrderId }, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Отмена ордера заблокирована: требуется явный allowLiveTrading=true");
  return request("POST", "/api/v5/trade/cancel-order", credentials, { instId: toInstrument(symbol), ...(orderId ? { ordId: String(orderId) } : { clOrdId: String(clientOrderId || "") }) }, true);
}

async function placeProtection(credentials, protection, options = {}) {
  if(options.allowLiveTrading!==true) throw Object.assign(new Error('OKX: серверный TP/SL заблокирован без live-подтверждения'),{definitive:true});
  const prepared=await prepareOrder(protection,credentials);
  const body=protectionBody(prepared);
  const payload=await request('POST','/api/v5/trade/order-algo',credentials,body,true);
  const result=payload.data?.[0] || {};
  if(String(result.sCode||'0')!=='0') throw exchangeApiError('okx',result.sCode,result.sMsg || 'серверный TP/SL отклонён');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(String(result.algoId||''))) throw new Error('OKX: TP/SL отправлен, но точный algoId не получен; повторная отправка запрещена');
  return {exchange:'okx',orderId:String(result.algoId),clientOrderId:result.algoClOrdId||body.algoClOrdId,symbol:toCommonSymbol(body.instId),quantity:prepared.baseQuantity,
    side:String(protection.side).toUpperCase(),takeProfitPrice:Number(body.tpTriggerPx),stopLossPrice:Number(body.slTriggerPx),status:'PENDING'};
}

async function getProtection(credentials, protection) {
  const query={...(protection.orderId?{algoId:String(protection.orderId)}:{algoClOrdId:String(protection.clientOrderId||'')})};
  let payload;
  try { payload=await request('GET','/api/v5/trade/order-algo',credentials,query,true); }
  catch(error) {
    if(/(?:51603|does not exist|not exist|not found|cannot be found)/i.test(String(error?.message))) throw Object.assign(error,{code:'PROTECTION_NOT_FOUND',definitive:true});
    throw error;
  }
  const row=payload.data?.[0];
  if(!row) throw Object.assign(new Error('OKX: серверный TP/SL ещё не найден'),{code:'PROTECTION_NOT_FOUND',definitive:true});
  const spec=await getContractSpec(protection.symbol || row.instId,credentials);
  const contracts=Number(row.sz || row.actualSz || 0);
  return {orderId:String(row.algoId),clientOrderId:row.algoClOrdId||protection.clientOrderId,symbol:toCommonSymbol(row.instId),status:protectionStatus(row.state),
    quantity:contracts*spec.contractSize,takeProfitPrice:Number(row.tpTriggerPx),stopLossPrice:Number(row.slTriggerPx),
    actualPrice:Number(row.actualPx||row.triggerPx||0)||null,triggerPrice:Number(row.triggerPx||0)||null,
    side:String(protection.side||'').toUpperCase(),triggerPriceType:row.tpTriggerPxType||row.slTriggerPxType||null};
}

async function cancelProtection(credentials, protection, options = {}) {
  if(options.allowLiveTrading!==true) throw Object.assign(new Error('OKX: отмена серверного TP/SL заблокирована без live-подтверждения'),{definitive:true});
  if(!protection.orderId) throw Object.assign(new Error('OKX: для отмены TP/SL нужен точный algoId'),{definitive:true});
  const payload=await request('POST','/api/v5/trade/cancel-algos',credentials,[{instId:toInstrument(protection.symbol),algoId:String(protection.orderId)}],true);
  const result=payload.data?.[0] || {};
  if(String(result.sCode||'0')!=='0') throw exchangeApiError('okx',result.sCode,result.sMsg || 'отмена TP/SL отклонена');
  return {orderId:String(protection.orderId),cancelRequested:true};
}

async function closeAllPositions(credentials, { symbol } = {}, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Закрытие позиций заблокировано без live-подтверждения");
  const payload = await request("GET", "/api/v5/account/positions", credentials, { instType: "SWAP", ...(symbol ? { instId: toInstrument(symbol) } : {}) }, true);
  const active = (payload.data || []).filter((position) => Number(position.pos) !== 0);
  return Promise.all(active.map((position) => placeOrder(credentials, { symbol: position.instId, side: position.posSide === "short" ? "BUY" : position.posSide === "long" ? "SELL" : Number(position.pos) > 0 ? "SELL" : "BUY", type: "MARKET", contracts: Math.abs(Number(position.pos)), marginMode: position.mgnMode || "cross", posSide: position.posSide, reduceOnly: true }, options)));
}

module.exports = { request, getAccount, getMarkets, getFeeRates, getDepth, getContractSpec, getPositionMode, ensureLeverage, prepareOrder, placeOrder, getOrder, cancelOrder, placeProtection, getProtection, cancelProtection, closeAllPositions, normalizeOrder, protectionBody, protectionStatus, normalizeFeeCost, normalizeLeverage, positionFields, sign, stepPrecision, toInstrument, validateResponse };
module.exports.supportsPostOnly = true;
module.exports.supportsNativeProtection = true;
module.exports.getDayOpen = getDayOpen;
