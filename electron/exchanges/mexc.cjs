const crypto = require("crypto");
const { requestJson } = require("./transport.cjs");
const { exchangeApiError, exchangeRequest } = require("./exchange-errors.cjs");

const OFFICIAL_BASE = "https://api.mexc.com";
const WEB_PRIVATE_BASE = "https://futures.mexc.com/api/v1/private";
const PUBLIC_BASE = "https://contract.mexc.com/api/v1/contract";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
let timeOffsetMs = 0;
let lastTimeSyncAt = 0;

function toContract(symbol) { return String(symbol || "").toUpperCase().replace(/[_-]/g, "").replace(/USDT$/, "_USDT"); }
function toCommonSymbol(symbol) { return String(symbol || "").toUpperCase().replace("_USDT", "USDT"); }
function modeOf(credentials = {}) { return String(credentials.connectionMode || credentials.mexcMode || "official").toLowerCase() === "sdk" ? "sdk" : "official"; }
function validateCredentials(credentials) {
  if (modeOf(credentials) === "sdk") {
    if (!credentials?.authorization) throw new Error("MEXC WEB Authorization token обязателен для Custom SDK");
  } else if (!credentials?.apiKey || !credentials?.secret) throw new Error("MEXC Access Key и Secret Key обязательны");
}

function sign(apiKey, timestamp, parameters, secret) { return crypto.createHmac("sha256", secret).update(`${apiKey}${timestamp}${parameters}`).digest("hex"); }
function md5(value) { return crypto.createHash("md5").update(String(value)).digest("hex"); }
function generateChash(payload) {
  const sorted = Object.fromEntries(Object.entries(payload).filter(([key]) => !["chash", "ts"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  return md5(JSON.stringify(sorted));
}
function signWeb(token, timestamp, body) { return md5(`${timestamp}${body}${md5(`${token}${timestamp}`).slice(7)}`); }
function validateResponse(payload) {
  const operation = Array.isArray(payload?.data) ? payload.data.find((item) => Number(item?.errorCode || 0) !== 0) : null;
  if (payload?.success === false || (payload?.code != null && Number(payload.code) !== 0) || operation) {
    throw exchangeApiError("mexc", operation?.errorCode ?? payload?.code, operation?.errorMsg || payload?.message || "запрос отклонён");
  }
}

async function publicRequest(path, credentials = {}, query = {}, base = PUBLIC_BASE) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null)).toString();
  return exchangeRequest("mexc", requestJson(`${base}${path}${qs ? `?${qs}` : ""}`, { credentials, exchangeName: "MEXC", validate: validateResponse }));
}

async function syncTime(credentials, force = false) {
  if (!force && Date.now() - lastTimeSyncAt < 30_000) return;
  const before = Date.now();
  const payload = await publicRequest("/api/v1/contract/ping", credentials, {}, OFFICIAL_BASE);
  timeOffsetMs = Number(payload.data) - Math.floor((before + Date.now()) / 2);
  lastTimeSyncAt = Date.now();
}

async function officialPrivateRequest(method, path, credentials, parameters = {}, retried = false) {
  validateCredentials(credentials);
  await syncTime(credentials);
  const upper = String(method).toUpperCase();
  const entries = Object.entries(parameters).filter(([, value]) => value != null).sort(([a], [b]) => a.localeCompare(b));
  const query = ["GET", "DELETE"].includes(upper) ? new URLSearchParams(entries).toString() : "";
  const body = upper === "POST" ? JSON.stringify(parameters) : "";
  const timestamp = String(Date.now() + timeOffsetMs);
  try {
    return await exchangeRequest("mexc", requestJson(`${OFFICIAL_BASE}${path}${query ? `?${query}` : ""}`, {
      method: upper,
      headers: { ApiKey: credentials.apiKey, "Request-Time": timestamp, Signature: sign(credentials.apiKey, timestamp, body || query, credentials.secret), "Recv-Window": "30", "content-type": "application/json", Language: "English" },
      ...(body ? { body } : {}), credentials, exchangeName: "MEXC", validate: validateResponse,
    }));
  } catch (error) {
    if (!retried && ["513", "602", "10073"].includes(String(error?.exchangeCode || ""))) {
      await syncTime(credentials, true);
      return officialPrivateRequest(method, path, credentials, parameters, true);
    }
    throw error;
  }
}

async function webPrivateRequest(method, path, credentials, parameters = {}) {
  validateCredentials(credentials);
  const upper = String(method).toUpperCase();
  const query = upper === "GET" ? new URLSearchParams(Object.entries(parameters).filter(([, value]) => value != null)).toString() : "";
  const body = upper === "POST" ? JSON.stringify(parameters) : "";
  const ts = String(Date.now());
  const headers = { authorization: credentials.authorization, accept: "*/*", origin: "https://futures.mexc.com", referer: "https://futures.mexc.com/", language: "English", "user-agent": credentials.userAgent || USER_AGENT };
  if (body) Object.assign(headers, { "x-mxc-nonce": ts, "x-mxc-sign": signWeb(credentials.authorization, ts, body), "trochilus-trace-id": crypto.randomUUID(), "content-type": "application/json; charset=utf-8" });
  return exchangeRequest("mexc", requestJson(`${WEB_PRIVATE_BASE}${path}${query ? `?${query}` : ""}`, { method: upper, headers, ...(body ? { body } : {}), credentials, exchangeName: "MEXC Custom SDK", validate: validateResponse }));
}

function privateRequest(method, path, credentials, parameters = {}) {
  return modeOf(credentials) === "sdk" ? webPrivateRequest(method, path.replace(/^\/api\/v1\/private/, ""), credentials, parameters) : officialPrivateRequest(method, path, credentials, parameters);
}

async function getAccount(credentials) {
  const payload = await privateRequest("GET", "/api/v1/private/account/assets", credentials);
  const account = (payload.data || []).find((item) => String(item.currency).toUpperCase() === "USDT") || {};
  return { exchange: "mexc", asset: "USDT", available: Number(account.availableBalance ?? account.availableMargin ?? 0), total: Number(account.equity ?? account.cashBalance ?? account.balance ?? 0), rawUpdatedAt: Date.now(), connectionMode: modeOf(credentials) };
}

async function getMarkets(credentials = {}) {
  const payload = await publicRequest("/ticker", credentials);
  const items = Array.isArray(payload.data) ? payload.data : [payload.data].filter(Boolean);
  return items.filter((item) => String(item.symbol).endsWith("_USDT")).map((item) => ({
    symbol: toCommonSymbol(item.symbol), exchangeSymbol: item.symbol, lastPrice: Number(item.lastPrice), markPrice: Number(item.fairPrice || item.lastPrice),
    high24h: Number(item.high24Price || item.high24h), low24h: Number(item.lower24Price || item.low24h), open24h: Number(item.lastPrice) / Math.max(1 + Number(item.riseFallRate || 0), 0.000001),
    volume24h: Number(item.volume24), turnover24h: Number(item.amount24 || 0), fundingRate: Number(item.fundingRate || 0), makerFee: Number(item.makerFeeRate || 0), takerFee: Number(item.takerFeeRate || 0),
  })).filter((item) => item.lastPrice > 0);
}

async function getFeeRates(_credentials, _symbols = [], markets = []) {
  return Object.fromEntries(markets.map((market) => [market.symbol, {
    makerFee: Number(market.makerFee), takerFee: Number(market.takerFee), source: "market",
  }]));
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  const contract = toContract(symbol);
  const payload = await publicRequest(`/depth/${contract}`, credentials, { limit: String(depth) });
  const data = payload.data || payload;
  return { symbol: toCommonSymbol(contract), bids: (data.bids || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), asks: (data.asks || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), receivedAt: Date.now() };
}

async function getContractSpec(symbol, credentials = {}) {
  const contract = toContract(symbol);
  const payload = await publicRequest("/detail", credentials);
  const items = Array.isArray(payload.data) ? payload.data : [payload.data].filter(Boolean);
  const item = items.find((value) => value.symbol === contract);
  if (!item) throw new Error(`MEXC не вернул спецификацию ${contract}`);
  return { contractSize: Number(item.contractSize), volumeStep: Number(item.volUnit || 1), minVolume: Number(item.minVol || 1), maxLeverage: Number(item.maxLeverage), tickSize: Number(item.priceUnit) };
}

async function prepareOrder(order, credentials = {}) {
  if (order?.contracts != null) return order;
  const quantity = Number(order?.quantity ?? order?.volume);
  const spec = await getContractSpec(order?.symbol, credentials);
  if (!Number.isFinite(quantity) || quantity <= 0 || !(spec.contractSize > 0)) throw new Error("MEXC не может рассчитать объём контрактов");
  const raw = quantity / spec.contractSize;
  const contracts = Math.floor((raw + Number.EPSILON) / spec.volumeStep) * spec.volumeStep;
  if (contracts < spec.minVolume) throw new Error(`MEXC: объём меньше минимума ${spec.minVolume} контрактов`);
  return { ...order, contracts, baseQuantity: contracts * spec.contractSize };
}

function normalizeOrder(order, credentials = {}) {
  const type = String(order?.type || "LIMIT").toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const volume = Number(order?.contracts ?? order?.volume ?? order?.quantity);
  const price = Number(order?.price || 0);
  if (!["LIMIT", "MARKET"].includes(type)) throw new Error("MEXC поддерживает LIMIT и MARKET");
  if (!["BUY", "SELL"].includes(side)) throw new Error("MEXC side должен быть BUY или SELL");
  if (!Number.isFinite(volume) || volume <= 0) throw new Error("MEXC volume должен быть больше нуля");
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw new Error("Для MEXC LIMIT необходима цена");
  const request = { symbol: toContract(order.symbol), vol: volume, leverage: Number(order.leverage || credentials.leverage || 1), side: order.reduceOnly ? (side === "BUY" ? 2 : 4) : (side === "BUY" ? 1 : 3), type: type === "MARKET" ? 5 : 1, openType: order.marginMode != null ? (require('../trading/margin-mode.cjs').marginMode(order.marginMode)==='isolated'?1:2) : Number(order.openType || credentials.openType || 1), positionMode: Number(order.positionMode || credentials.positionMode || 2), externalOid: String(order.clientOrderId || crypto.randomUUID().replace(/-/g, "")), price: type === "LIMIT" ? price : 0 };
  if (order.reduceOnly != null) request.reduceOnly = Boolean(order.reduceOnly);
  if (modeOf(credentials) === "sdk") {
    if (type === "MARKET") delete request.price;
    request.chash = generateChash(request);
    request.ts = String(Date.now());
  }
  return request;
}

async function placeOrder(credentials, order, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  const prepared = await prepareOrder(order, credentials);
  const request = normalizeOrder(prepared, credentials);
  require('./order-deadline.cjs').assertOrderDeadline(order);
  const payload = await privateRequest("POST", "/api/v1/private/order/create", credentials, request);
  return { exchange: "mexc", orderId: payload.data?.orderId ?? payload.data, clientOrderId: request.externalOid, request, response: payload };
}

function normalizeStatus(value) {
  return ({ 1: "NEW", 2: "NEW", 3: "FILLED", 4: "CANCELED", 5: "REJECTED" })[Number(value)] || String(value || "UNKNOWN").toUpperCase();
}
async function getOrder(credentials, { orderId, symbol, clientOrderId }) {
  if (!orderId && !clientOrderId) throw new Error("MEXC orderId или clientOrderId обязателен");
  const payload = await privateRequest("GET", clientOrderId ? `/api/v1/private/order/external/${toContract(symbol)}/${encodeURIComponent(clientOrderId)}` : `/api/v1/private/order/get/${orderId}`, credentials);
  const order = payload.data || {};
  if (!order.orderId) throw new Error("MEXC не вернул ордер");
  const spec = await getContractSpec(symbol || order.symbol, credentials);
  return { ...order, status: normalizeStatus(order.state ?? order.status), executedQty: Number(order.dealVol ?? order.filledVolume ?? 0) * spec.contractSize };
}
async function cancelOrder(credentials, { orderId, clientOrderId, symbol }, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Отмена ордера заблокирована: требуется явный allowLiveTrading=true");
  if (clientOrderId) return privateRequest("POST", "/api/v1/private/order/cancel_with_external", credentials, [{ symbol: toContract(symbol), externalOid: clientOrderId }]);
  if (!orderId) throw new Error("MEXC orderId обязателен для отмены");
  return privateRequest("POST", "/api/v1/private/order/cancel", credentials, [String(orderId)]);
}

async function closeAllPositions(credentials, _filters = {}, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Закрытие позиций заблокировано без live-подтверждения");
  return privateRequest("POST", "/api/v1/private/position/close_all", credentials, {});
}

module.exports = { getAccount, getMarkets, getFeeRates, getDepth, getContractSpec, prepareOrder, placeOrder, getOrder, cancelOrder, closeAllPositions, sign, signWeb, generateChash, normalizeOrder, toContract, privateRequest, modeOf, validateResponse };
