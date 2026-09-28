const crypto = require("crypto");
const { requestJson } = require("./transport.cjs");
const { exchangeApiError, exchangeRequest } = require("./exchange-errors.cjs");
const { floorToStep, roundToStep } = require("./order-sizing.cjs");

const BASE_URL = "https://api.bitget.com";
const PRODUCT_TYPE = "USDT-FUTURES";

function validateCredentials(credentials) {
  if (!credentials?.apiKey || !credentials?.secret || !credentials?.passphrase) throw new Error("Bitget API Key, Secret Key и Passphrase обязательны");
}

function sign(timestamp, method, path, query, body, secret) {
  const suffix = query ? `${path}?${query}` : path;
  return crypto.createHmac("sha256", secret).update(`${timestamp}${method}${suffix}${body}`).digest("base64");
}

function validateResponse(payload) {
  if (String(payload?.code) !== "00000") throw exchangeApiError("bitget", payload?.code, payload?.msg || "запрос отклонён");
}

async function request(method, path, credentials = {}, parameters = {}, authenticated = false) {
  const upperMethod = String(method).toUpperCase();
  const query = upperMethod === "GET" ? new URLSearchParams(parameters).toString() : "";
  const body = upperMethod === "GET" ? "" : JSON.stringify(parameters);
  const headers = { "content-type": "application/json", locale: "en-US" };
  if (authenticated) {
    validateCredentials(credentials);
    const timestamp = String(Date.now());
    Object.assign(headers, { "ACCESS-KEY": credentials.apiKey, "ACCESS-SIGN": sign(timestamp, upperMethod, path, query, body, credentials.secret), "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": credentials.passphrase });
  }
  return exchangeRequest("bitget", requestJson(`${BASE_URL}${path}${query ? `?${query}` : ""}`, { method: upperMethod, headers, ...(body ? { body } : {}), credentials, exchangeName: "Bitget", validate: validateResponse }));
}

async function getAccount(credentials) {
  const payload = await request("GET", "/api/v2/mix/account/accounts", credentials, { productType: PRODUCT_TYPE }, true);
  const account = (payload.data || []).find((item) => item.marginCoin === "USDT") || {};
  return { exchange: "bitget", asset: "USDT", available: Number(account.available || account.crossedMaxAvailable || 0), total: Number(account.accountEquity || account.usdtEquity || 0), rawUpdatedAt: Date.now() };
}

async function getMarkets(credentials = {}) {
  const payload = await request("GET", "/api/v2/mix/market/tickers", credentials, { productType: PRODUCT_TYPE });
  return (payload.data || []).filter((item) => String(item.symbol).endsWith("USDT")).map((item) => ({ symbol: String(item.symbol).toUpperCase(), lastPrice: Number(item.lastPr || item.last), markPrice: Number(item.markPrice || item.lastPr), high24h: Number(item.high24h), low24h: Number(item.low24h), open24h: Number(item.openUtc || item.open24h), volume24h: Number(item.baseVolume || item.volume24h), turnover24h: Number(item.usdtVolume || item.quoteVolume), fundingRate: Number(item.fundingRate || 0) })).filter((item) => item.lastPrice > 0);
}

async function getFeeRates(credentials) {
  const payload = await request("GET", "/api/v2/common/all-trade-rate", credentials, { businessType: "mix" }, true);
  return Object.fromEntries((payload.data || []).map((item) => {
    const symbol = String(item.symbol || item.baseCoin || "").replace(/[_-]/g, "").toUpperCase();
    const commonSymbol = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
    return [commonSymbol, { makerFee: Number(item.makerFeeRate), takerFee: Number(item.takerFeeRate), source: "account" }];
  }));
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  const normalized = String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const payload = await request("GET", "/api/v2/mix/market/merge-depth", credentials, { symbol: normalized, productType: PRODUCT_TYPE, precision: "scale0", limit: String(Math.min(depth, 150)) });
  return { symbol: normalized, bids: (payload.data?.bids || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), asks: (payload.data?.asks || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), receivedAt: Date.now() };
}

const symbolSpecCache = new Map();
const positionModeCache = new Map();

async function getSymbolSpec(symbol, credentials = {}) {
  const normalized = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cached = symbolSpecCache.get(normalized);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await request("GET", "/api/v2/mix/market/contracts", credentials, { productType: PRODUCT_TYPE, symbol: normalized });
  const item = payload.data?.find((entry) => String(entry.symbol).toUpperCase() === normalized) || payload.data?.[0];
  if (!item) throw new Error(`Bitget не вернул параметры ${normalized}`);
  const pricePlaces = Number(item.pricePlace || 0);
  const priceStep = Number((Number(item.priceEndStep || 1) * (10 ** -pricePlaces)).toFixed(pricePlaces));
  const value = { qtyStep: Number(item.sizeMultiplier || 10 ** -Number(item.volumePlace || 0)), minQty: Number(item.minTradeNum), tickSize: priceStep };
  symbolSpecCache.set(normalized, { value, expiresAt: Date.now() + 300_000 });
  return value;
}

async function getPositionMode(credentials, symbol) {
  const normalized = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cacheKey = `${credentials?.apiKey || ""}:${normalized}`;
  const cached = positionModeCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await request("GET", "/api/v2/mix/account/account", credentials, { symbol: normalized, productType: PRODUCT_TYPE, marginCoin: "USDT" }, true);
  const mode = payload.data?.posMode;
  const value = mode === "hedge_mode" ? "hedge" : "one-way";
  positionModeCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

function positionFields(order) {
  if (order?.positionMode !== "hedge") return order?.reduceOnly === true ? { reduceOnly: "YES" } : {};
  const engineSide = String(order?.side || "").toUpperCase();
  return {
    tradeSide: order?.reduceOnly === true ? "close" : "open",
    side: order?.reduceOnly === true ? (engineSide === "BUY" ? "sell" : "buy") : engineSide.toLowerCase(),
  };
}

async function prepareOrder(order, credentials = {}) {
  const type = String(order?.type || "LIMIT").toUpperCase();
  const spec = await getSymbolSpec(order?.symbol, credentials);
  const quantity = floorToStep(order?.quantity ?? order?.volume, spec.qtyStep);
  const price = type === "LIMIT" ? roundToStep(order?.price, spec.tickSize) : undefined;
  if (!(quantity >= spec.minQty)) throw new Error(`Bitget: объём меньше минимума ${spec.minQty}`);
  return { ...order, quantity, ...(price ? { price } : {}), positionMode: order?.positionMode || await getPositionMode(credentials, order?.symbol) };
}

function normalizeOrder(order) {
  if (order.postOnly && String(order.type).toUpperCase() !== 'LIMIT') throw new Error('Bitget Post-Only допускается только для LIMIT');
  const type = String(order?.type || "LIMIT").toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const quantity = Number(order?.quantity ?? order?.volume);
  const price = Number(order?.price || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Bitget size должен быть больше нуля");
  if (!['BUY', 'SELL'].includes(side)) throw new Error("Bitget side должен быть BUY или SELL");
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw new Error("Для Bitget LIMIT необходима цена");
  return { symbol: String(order.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), productType: PRODUCT_TYPE, marginMode: order.marginMode==='crossed'?'crossed':require('../trading/margin-mode.cjs').marginMode(order.marginMode)==='cross'?'crossed':'isolated', marginCoin: "USDT", size: String(quantity), side: side.toLowerCase(), orderType: type.toLowerCase(), ...(type === "LIMIT" ? { price: String(price), force: order.postOnly ? 'post_only' : String(order.timeInForce || "gtc").toLowerCase() } : {}), clientOid: String(order.clientOrderId || `hedge_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`), ...positionFields(order) };
}

async function placeOrder(credentials, order, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  const requestBody = normalizeOrder(await prepareOrder(order, credentials));
  require('./order-deadline.cjs').assertOrderDeadline(order);
  const payload = await request("POST", "/api/v2/mix/order/place-order", credentials, requestBody, true);
  return { exchange: "bitget", orderId: payload.data?.orderId, clientOrderId: payload.data?.clientOid || requestBody.clientOid, response: payload };
}

function normalizeStatus(status) { return ({ live: "NEW", new: "NEW", partially_filled: "PARTIALLY_FILLED", partial_fill: "PARTIALLY_FILLED", filled: "FILLED", full_fill: "FILLED", canceled: "CANCELED", cancelled: "CANCELED", rejected: "REJECTED" })[String(status).toLowerCase()] || String(status).toUpperCase(); }

async function getOrder(credentials, { symbol, orderId, clientOrderId }) {
  const payload = await request("GET", "/api/v2/mix/order/detail", credentials, { symbol: String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), productType: PRODUCT_TYPE, ...(orderId ? { orderId: String(orderId) } : { clientOid: String(clientOrderId || "") }) }, true);
  const order = payload.data;
  if (!order) throw new Error("Bitget не вернул ордер");
  return { ...order, status: normalizeStatus(order.state || order.status), executedQty: order.baseVolume || order.filledQty || 0 };
}

async function cancelOrder(credentials, { symbol, orderId, clientOrderId }, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Отмена ордера заблокирована: требуется явный allowLiveTrading=true");
  return request("POST", "/api/v2/mix/order/cancel-order", credentials, { symbol: String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), productType: PRODUCT_TYPE, ...(orderId ? { orderId: String(orderId) } : { clientOid: String(clientOrderId || "") }) }, true);
}

async function closeAllPositions(credentials, { symbol } = {}, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Закрытие позиций заблокировано без live-подтверждения");
  const payload = await request("GET", "/api/v2/mix/position/all-position", credentials, { productType: PRODUCT_TYPE, marginCoin: "USDT" }, true);
  const active = (payload.data || []).filter((position) => Number(position.total) > 0 && (!symbol || String(position.symbol).toUpperCase() === String(symbol).toUpperCase()));
  return Promise.all(active.map((position) => placeOrder(credentials, { symbol: position.symbol, side: String(position.holdSide).toLowerCase() === "long" ? "SELL" : "BUY", type: "MARKET", quantity: Number(position.total), marginMode: position.marginMode || "crossed", positionMode: position.posMode === "hedge_mode" ? "hedge" : "one-way", reduceOnly: true }, options)));
}

module.exports = { request, getAccount, getMarkets, getFeeRates, getDepth, getSymbolSpec, getPositionMode, prepareOrder, placeOrder, getOrder, cancelOrder, closeAllPositions, normalizeOrder, positionFields, sign, validateResponse };
module.exports.supportsPostOnly = true;
