const crypto = require("crypto");
const { requestJson } = require("./transport.cjs");
const { exchangeRequest } = require("./exchange-errors.cjs");
const { floorToStep, roundToStep } = require("./order-sizing.cjs");

const BASE_URL = "https://fapi.binance.com";

function validateCredentials(credentials) {
  if (!credentials?.apiKey || !credentials?.secret) throw new Error("Binance API Key и Secret Key обязательны");
}

function signParameters(parameters, secret) {
  const query = new URLSearchParams(parameters).toString();
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function signedRequest(method, path, credentials, parameters = {}) {
  validateCredentials(credentials);
  const params = new URLSearchParams({ ...parameters, recvWindow: "5000", timestamp: String(Date.now()) });
  params.set("signature", signParameters(params, credentials.secret));
  const isBodyRequest = method === "POST" || method === "PUT" || method === "DELETE";
  return exchangeRequest("binance", requestJson(isBodyRequest ? `${BASE_URL}${path}` : `${BASE_URL}${path}?${params}`, {
    method,
    headers: {
      "X-MBX-APIKEY": credentials.apiKey,
      ...(isBodyRequest ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(isBodyRequest ? { body: params.toString() } : {}),
    credentials,
    exchangeName: "Binance",
  }));
}

async function getAccount(credentials) {
  return normalizeAccount(await signedRequest("GET", "/fapi/v3/account", credentials));
}

function normalizeAccount(payload) {
  if (!Array.isArray(payload?.assets)) throw new Error("Binance вернул неожиданный формат баланса");
  const usdt = payload.assets.find((item) => item.asset === "USDT");
  if (!usdt || [usdt.availableBalance, usdt.marginBalance].some((v) => v == null || v === "" || !Number.isFinite(Number(v)))) throw new Error("Binance не вернул полный USDT-баланс");
  return {
    exchange: "binance",
    asset: "USDT",
    available: Number(usdt.availableBalance),
    total: Number(usdt.marginBalance),
    rawUpdatedAt: Date.now(),
  };
}

async function getMarkets(credentials = {}) {
  const payload = await exchangeRequest("binance", requestJson(`${BASE_URL}/fapi/v1/ticker/24hr`, { credentials, exchangeName: "Binance" }));
  if (!Array.isArray(payload)) throw new Error("Binance вернул неожиданный формат рынков");
  return payload.filter((item) => String(item.symbol).endsWith("USDT")).map((item) => ({
    symbol: item.symbol, lastPrice: Number(item.lastPrice), markPrice: Number(item.lastPrice),
    high24h: Number(item.highPrice), low24h: Number(item.lowPrice), open24h: Number(item.openPrice),
    volume24h: Number(item.volume), turnover24h: Number(item.quoteVolume), fundingRate: 0,
  })).filter((item) => item.lastPrice > 0);
}

async function getFeeRates(credentials, symbols = []) {
  const entries = await Promise.all(symbols.slice(0, 25).map(async (symbol) => {
    const normalized = String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const payload = await signedRequest("GET", "/fapi/v1/commissionRate", credentials, { symbol: normalized });
    return [normalized, { makerFee: Number(payload.makerCommissionRate), takerFee: Number(payload.takerCommissionRate), source: "account" }];
  }));
  return Object.fromEntries(entries);
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  const normalized = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const limit = [5, 10, 20, 50, 100, 500, 1000].find((value) => value >= depth) || 100;
  const query = new URLSearchParams({ symbol: normalized, limit: String(limit) });
  const payload = await exchangeRequest("binance", requestJson(`${BASE_URL}/fapi/v1/depth?${query}`, { credentials, exchangeName: "Binance" }));
  return { symbol: normalized, bids: (payload.bids || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), asks: (payload.asks || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), receivedAt: Date.now() };
}

const symbolSpecCache = new Map();
const positionModeCache = new Map();

async function getSymbolSpec(symbol, credentials = {}) {
  const normalized = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cached = symbolSpecCache.get(normalized);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const query = new URLSearchParams({ symbol: normalized });
  const payload = await exchangeRequest("binance", requestJson(`${BASE_URL}/fapi/v1/exchangeInfo?${query}`, { credentials, exchangeName: "Binance" }));
  const item = payload.symbols?.find((entry) => String(entry.symbol).toUpperCase() === normalized);
  if (!item) throw new Error(`Binance не вернул параметры ${normalized}`);
  const filters = Object.fromEntries((item.filters || []).map((filter) => [filter.filterType, filter]));
  const value = {
    lotStep: Number(filters.LOT_SIZE?.stepSize), marketStep: Number(filters.MARKET_LOT_SIZE?.stepSize || filters.LOT_SIZE?.stepSize),
    minQty: Number(filters.LOT_SIZE?.minQty), marketMinQty: Number(filters.MARKET_LOT_SIZE?.minQty || filters.LOT_SIZE?.minQty),
    tickSize: Number(filters.PRICE_FILTER?.tickSize), minNotional: Number(filters.MIN_NOTIONAL?.notional || 0),
  };
  symbolSpecCache.set(normalized, { value, expiresAt: Date.now() + 300_000 });
  return value;
}

async function getPositionMode(credentials) {
  const cacheKey = String(credentials?.apiKey || "");
  const cached = positionModeCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await signedRequest("GET", "/fapi/v1/positionSide/dual", credentials);
  const value = payload?.dualSidePosition === true || payload?.dualSidePosition === "true" ? "hedge" : "one-way";
  positionModeCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

function positionFields(order) {
  if (order?.positionMode !== "hedge") return order?.reduceOnly === true ? { reduceOnly: true } : {};
  const side = String(order?.side || "").toUpperCase();
  return { positionSide: order?.positionSide || (order?.reduceOnly === true ? (side === "BUY" ? "SHORT" : "LONG") : (side === "BUY" ? "LONG" : "SHORT")) };
}

async function prepareOrder(order, credentials = {}) {
  const type = String(order?.type || "LIMIT").toUpperCase();
  const spec = await getSymbolSpec(order?.symbol, credentials);
  const step = type === "MARKET" ? spec.marketStep : spec.lotStep;
  const minimum = type === "MARKET" ? spec.marketMinQty : spec.minQty;
  const quantity = floorToStep(order?.quantity ?? order?.volume, step);
  const price = type === "LIMIT" ? roundToStep(order?.price, spec.tickSize) : undefined;
  if (!(quantity >= minimum)) throw new Error(`Binance: объём меньше минимума ${minimum}`);
  if (type === "LIMIT" && spec.minNotional > 0 && quantity * price < spec.minNotional) throw new Error(`Binance: сумма ордера меньше ${spec.minNotional} USDT`);
  return { ...order, quantity, ...(price ? { price } : {}), positionMode: order?.positionMode || await getPositionMode(credentials) };
}

function normalizeOrder(order) {
  if (order.postOnly && String(order.type).toUpperCase() !== 'LIMIT') throw new Error('Binance Post-Only допускается только для LIMIT');
  const symbol = String(order?.symbol || "").toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const type = String(order?.type || "LIMIT").toUpperCase();
  const quantity = Number(order?.quantity);
  const price = Number(order?.price ?? 0);
  if (!/^[A-Z0-9]{4,24}$/.test(symbol)) throw new Error("Некорректный Binance symbol");
  if (!['BUY', 'SELL'].includes(side)) throw new Error("Binance side должен быть BUY или SELL");
  if (!['LIMIT', 'MARKET'].includes(type)) throw new Error("Поддерживаются Binance LIMIT и MARKET");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Binance quantity должен быть больше нуля");
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw new Error("Для Binance LIMIT необходима цена");
  return {
    symbol,
    side,
    type,
    quantity: String(quantity),
    ...(type === "LIMIT" ? { price: String(price), timeInForce: order.postOnly ? 'GTX' : String(order?.timeInForce || "GTC") } : {}),
    ...Object.fromEntries(Object.entries(positionFields(order)).map(([key, value]) => [key, key === "reduceOnly" ? "true" : String(value).toUpperCase()])),
    newClientOrderId: String(order?.clientOrderId || `hedge_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`),
    newOrderRespType: "RESULT",
  };
}

async function placeOrder(credentials, order, options = {}) {
  if (options.allowLiveTrading !== true) {
    throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  }
  const request = normalizeOrder(await prepareOrder(order, credentials));
  require('./order-deadline.cjs').assertOrderDeadline(order);
  const payload = await signedRequest("POST", "/fapi/v1/order", credentials, request);
  return { exchange: "binance", orderId: payload.orderId, clientOrderId: payload.clientOrderId || request.newClientOrderId, response: payload };
}

async function getOrder(credentials, { symbol, orderId, clientOrderId }) {
  const order = await signedRequest("GET", "/fapi/v1/order", credentials, {
    symbol: String(symbol || "").toUpperCase(),
    ...(orderId ? { orderId: String(orderId) } : { origClientOrderId: String(clientOrderId || "") }),
  });
  return { ...order, status: String(order.status || "").toUpperCase(), executedQty: Number(order.executedQty || 0) };
}

async function cancelOrder(credentials, { symbol, orderId, clientOrderId }, options = {}) {
  if (options.allowLiveTrading !== true) {
    throw new Error("Отмена ордера заблокирована: требуется явный allowLiveTrading=true");
  }
  return signedRequest("DELETE", "/fapi/v1/order", credentials, {
    symbol: String(symbol || "").toUpperCase(),
    ...(orderId ? { orderId: String(orderId) } : { origClientOrderId: String(clientOrderId || "") }),
  });
}

async function closeAllPositions(credentials, { symbol } = {}, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Закрытие позиций заблокировано без live-подтверждения");
  const positions = await signedRequest("GET", "/fapi/v3/positionRisk", credentials, symbol ? { symbol: String(symbol).toUpperCase() } : {});
  const active = (positions || []).filter((position) => Number(position.positionAmt) !== 0);
  return Promise.all(active.map((position) => placeOrder(credentials, {
    symbol: position.symbol,
    side: Number(position.positionAmt) > 0 ? "SELL" : "BUY",
    type: "MARKET",
    quantity: Math.abs(Number(position.positionAmt)),
    ...(position.positionSide && position.positionSide !== "BOTH" ? { positionSide: position.positionSide } : { reduceOnly: true }),
  }, options)));
}

module.exports = { signedRequest, getAccount, normalizeAccount, getMarkets, getFeeRates, getDepth, getSymbolSpec, getPositionMode, prepareOrder, placeOrder, getOrder, cancelOrder, closeAllPositions, normalizeOrder, positionFields, signParameters };
module.exports.supportsPostOnly = true;
