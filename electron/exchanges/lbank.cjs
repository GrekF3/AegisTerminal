const crypto = require("crypto");
const { requestJson: transportRequestJson } = require("./transport.cjs");

const BASE_URL = "https://lbkperp.lbank.com/";
const PRODUCT_GROUP = "SwapU";
require('./lbank-request-queue.cjs').installLBankRequestQueue(globalThis);
const apiQueue=globalThis[Symbol.for('hedge.lbank.http-queue.v1')];

function canonicalize(parameters) {
  return Object.entries(parameters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function sign(parameters, secret, signatureMethod = "HmacSHA256") {
  const canonical = canonicalize(parameters);
  const md5 = crypto.createHash("md5").update(canonical, "utf8").digest("hex").toUpperCase();
  if (String(signatureMethod).toUpperCase() === "RSA") {
    return crypto.sign("RSA-SHA256", Buffer.from(md5, "utf8"), secret).toString("base64");
  }
  return crypto.createHmac("sha256", secret).update(md5, "utf8").digest("hex");
}

async function requestJson(url, init = {}, credentials = {}) {
    let payload;
    try {
      payload = await apiQueue.run(()=>transportRequestJson(url, {
        ...init, headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
        credentials, exchangeName: "LBank",
      }),{scope:'lbank-api',epoch:apiQueue.epoch('lbank-api'),priority:init.method==='POST'?10:0});
    } catch (error) {
      if (error.httpStatus === 403 && new URL(url).pathname.startsWith('/cfd/openApi/v1/prv/')) {
        error.message = 'LBank: отказ в доступе к приватному Futures API (HTTP 403). Для фьючерсов выберите «Undetectable · CDP» и запущенный профиль. Для API-доступа проверьте разрешения Futures и список IP у LBank.';
        error.code = 'LBANK_PRIVATE_API_ACCESS_DENIED';
      }
      throw error;
    }
    if (!payload || typeof payload !== 'object') throw new Error('LBank: API вернул некорректные данные');
    if (String(payload.success).toLowerCase() === 'false' || String(payload.result).toLowerCase() === 'false' || (payload.error_code != null && Number(payload.error_code) !== 0)) {
      throw Object.assign(new Error(`LBank: ${payload.msg || 'API отклонил запрос'}${payload.error_code != null ? ` [${payload.error_code}]` : ''}`), { code: payload.error_code });
    }
    return payload;
}

async function getMarkets(credentials = {}) {
  if (require('./lbank-browser.cjs').manualMode(credentials)) return require('./lbank-browser.cjs').browser.getMarkets(credentials);
  const payload = await requestJson(`${BASE_URL}cfd/openApi/v1/pub/marketData?productGroup=${PRODUCT_GROUP}`, {}, credentials);
  return (payload.data || []).map((item) => ({
    symbol: String(item.symbol || "").toUpperCase(),
    lastPrice: Number(item.lastPrice || 0),
    markPrice: Number(item.markedPrice || 0),
    high24h: Number(item.highestPrice || 0),
    low24h: Number(item.lowestPrice || 0),
    open24h: Number(item.openPrice || 0),
    volume24h: Number(item.volume || 0),
    turnover24h: Number(item.turnover || 0),
    fundingRate: Number(item.prePositionFeeRate || 0),
  })).filter((item) => item.symbol && item.lastPrice > 0);
}

async function getFeeRates(credentials = {}) {
  if (require('./lbank-browser.cjs').manualMode(credentials)) return require('./lbank-browser.cjs').browser.getFeeRates(credentials);
  return { default: { makerFee: 0.0002, takerFee: 0.0006, source: "published" } };
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  if (require('./lbank-browser.cjs').manualMode(credentials)) return require('./lbank-browser.cjs').browser.getDepth(symbol,depth,credentials);
  const params = new URLSearchParams({ symbol: symbol.toUpperCase(), depth: String(depth) });
  const payload = await requestJson(`${BASE_URL}cfd/openApi/v1/pub/marketOrder?${params}`, {}, credentials);
  const data = payload.data || payload;
  return {
    symbol: String(data.symbol || symbol).toUpperCase(),
    bids: (data.bids || []).map((level) => ({ price: Number(level.price), quantity: Number(level.volume) })),
    asks: (data.asks || []).map((level) => ({ price: Number(level.price), quantity: Number(level.volume) })),
    receivedAt: Date.now(),
  };
}

function validateCredentials(credentials) {
  if (!credentials?.apiKey || !credentials?.secret) {
    throw new Error("LBank API Key и Secret Key обязательны");
  }
}

async function privateRequest(method, path, credentials, parameters = {}) {
  validateCredentials(credentials);
  const timestamp = String(Date.now());
  const echo = crypto.randomBytes(18).toString("hex");
  const signatureMethod = credentials.signatureMethod || "HmacSHA256";
  const signed = {
    ...parameters,
    api_key: credentials.apiKey,
    timestamp,
    signature_method: signatureMethod,
    echostr: echo,
  };
  const requestParameters = { ...parameters, api_key: credentials.apiKey, sign: sign(signed, credentials.secret, signatureMethod) };
  const headers = { timestamp, signature_method: signatureMethod, echostr: echo };
  if (method === "GET") {
    const query = new URLSearchParams(requestParameters);
    return requestJson(`${BASE_URL}${path}?${query}`, { headers }, credentials);
  }
  return requestJson(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(requestParameters),
  }, credentials);
}

async function getAccount(credentials) {
  if (require('./lbank-browser.cjs').manualMode(credentials)) return require('./lbank-browser.cjs').browser.getAccount(credentials);
  const payload = await privateRequest("GET", "cfd/openApi/v1/prv/account", credentials, { asset: "USDT", productGroup: PRODUCT_GROUP });
  return normalizeAccount(payload);
}

function normalizeAccount(payload) {
  const data = payload?.data ?? payload;
  const candidate = Array.isArray(data) ? data.find((item) => String(item?.asset || item?.currency || "").toUpperCase() === "USDT") : data;
  const currency = String(candidate?.asset || candidate?.currency || "USDT").toUpperCase();
  const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
  const available = number(candidate?.availableBalance ?? candidate?.available);
  const total = number(candidate?.equity ?? candidate?.accountEquity ?? candidate?.balance);
  if (currency !== 'USDT' || available === null || total === null) {
    throw Object.assign(new Error('LBank: API не подтвердил USDT-баланс фьючерсного счёта; проверьте разрешения Futures или подключите Undetectable · CDP'), {code:'LBANK_ACCOUNT_INVALID_RESPONSE'});
  }
  return {
    exchange: "lbank",
    asset: "USDT",
    available,
    total,
    rawUpdatedAt: Date.now(),
  };
}

function normalizeOrder(order) {
  const symbol = String(order?.symbol || "").toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const volume = Number(order?.volume);
  const orderPriceType = Number(order?.orderPriceType ?? 0);
  const price = Number(order?.price ?? 0);
  if (!/^[A-Z0-9]{4,24}$/.test(symbol)) throw new Error("Некорректный LBank symbol");
  if (!['BUY', 'SELL'].includes(side)) throw new Error("LBank side должен быть BUY или SELL");
  if (!Number.isFinite(volume) || volume <= 0) throw new Error("LBank volume должен быть больше нуля");
  if (orderPriceType === 0 && (!Number.isFinite(price) || price <= 0)) throw new Error("Для LBank LIMIT необходима цена");
  return {
    clientOrderId: String(order?.clientOrderId || `hedge_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`),
    offsetFlag: String(order?.offsetFlag ?? 0),
    orderPriceType: String(orderPriceType),
    origType: String(order?.origType ?? 0),
    price: String(price),
    side,
    symbol,
    volume: String(volume),
  };
}

async function placeOrder(credentials, order, options = {}) {
  if (require('./lbank-browser.cjs').manualMode(credentials)) return require('./lbank-browser.cjs').browser.placeOrder(credentials,order,options);
  if (options.allowLiveTrading !== true) {
    throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  }
  const request = normalizeOrder(order);
  const payload = await privateRequest("POST", "cfd/openApi/v1/prv/placeOrder", credentials, request);
  return { exchange: "lbank", clientOrderId: request.clientOrderId, request, response: payload };
}

async function getPositions(credentials) {
  const { manualMode, browser } = require('./lbank-browser.cjs');
  if (manualMode(credentials)) return browser.getPositions(credentials);
  throw new Error('LBank API: чтение позиций пока не поддерживается');
}
async function getOpenOrders(credentials) {
  const { manualMode, browser } = require('./lbank-browser.cjs');
  if (manualMode(credentials)) return browser.getOpenOrders(credentials);
  throw new Error('LBank API: чтение открытых ордеров пока не поддерживается');
}
function webOnly(credentials) {
  const { manualMode, browser } = require('./lbank-browser.cjs');
  if (!manualMode(credentials)) throw new Error('LBank: полный цикл хеджа доступен через подключённый профиль Undetectable');
  return browser;
}
const getTradingRules=(symbol,c)=>webOnly(c).getTradingRules(symbol,c);
const getDayOpen=(symbol,c)=>webOnly(c).getDayOpen(symbol,c);
const getOrder=(c,order)=>webOnly(c).getOrder(c,order);
const getClosePlan=(c,request)=>webOnly(c).getClosePlan(c,request);
const configureLeverage=(c,request,options)=>webOnly(c).configureLeverage(c,request,options);
const cancelOrder=(c,order,options)=>webOnly(c).cancelOrder(c,order,options);
const placeProtection=(c,request,options)=>webOnly(c).placeProtection(c,request,options);
const getProtection=(c,request)=>webOnly(c).getProtection(c,request);
const cancelProtection=(c,request,options)=>webOnly(c).cancelProtection(c,request,options);
async function prepareOrder(order,credentials) {
  if (!require('./lbank-browser.cjs').manualMode(credentials)) return order;
  const rules=await getTradingRules(order.symbol,credentials),quantity=Number(order.quantity ?? order.volume);
  if(!(quantity>0)||!Number.isFinite(quantity)||Math.abs(quantity/rules.quantityStep-Math.round(quantity/rules.quantityStep))>1e-7) throw new Error('LBank: объём не соответствует шагу контракта');
  return {...order,quantity,baseQuantity:quantity};
}
module.exports = { getMarkets, getFeeRates, getDepth, getAccount, getPositions, getOpenOrders, getTradingRules, getDayOpen, getOrder, getClosePlan, configureLeverage, cancelOrder, prepareOrder, placeOrder, placeProtection, getProtection, cancelProtection, normalizeOrder, normalizeAccount, sign };
module.exports.supportsPostOnly = credentials => require('./lbank-browser.cjs').manualMode(credentials);
module.exports.supportsNativeProtection = true;
// Once the source fill is confirmed, minimizing naked-exposure time is more
// important than attempting a second maker fill. LBank MARKET is FAK on the
// verified web wire, so a confirmed terminal partial can be topped up safely.
module.exports.preferImmediateHedge = credentials => require('./lbank-browser.cjs').manualMode(credentials);
