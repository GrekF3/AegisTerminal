const crypto = require("crypto");
const { requestJson } = require("./transport.cjs");
const { exchangeApiError, exchangeRequest } = require("./exchange-errors.cjs");
const { floorToStep, roundToStep } = require("./order-sizing.cjs");

const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

function validateCredentials(credentials) {
  if (!credentials?.apiKey || !credentials?.secret) throw new Error("Bybit API Key и Secret Key обязательны");
}

function signPayload(timestamp, apiKey, recvWindow, payload, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}${apiKey}${recvWindow}${payload}`).digest("hex");
}

function validateResponse(payload) {
  if (Number(payload?.retCode) !== 0) throw exchangeApiError("bybit", payload?.retCode, payload?.retMsg || "запрос отклонён");
}

async function publicRequest(path, parameters = {}, credentials = {}) {
  const query = new URLSearchParams(parameters).toString();
  return exchangeRequest("bybit", requestJson(`${BASE_URL}${path}${query ? `?${query}` : ""}`, { credentials, exchangeName: "Bybit", validate: validateResponse }));
}

async function privateRequest(method, path, credentials, parameters = {}) {
  validateCredentials(credentials);
  const upperMethod = String(method).toUpperCase();
  const timestamp = String(Date.now());
  const query = upperMethod === "GET" ? new URLSearchParams(parameters).toString() : "";
  const body = upperMethod === "GET" ? "" : JSON.stringify(parameters);
  const payloadToSign = upperMethod === "GET" ? query : body;
  return exchangeRequest("bybit", requestJson(`${BASE_URL}${path}${query ? `?${query}` : ""}`, {
    method: upperMethod,
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signPayload(timestamp, credentials.apiKey, RECV_WINDOW, payloadToSign, credentials.secret),
      "content-type": "application/json",
    },
    ...(body ? { body } : {}),
    credentials,
    exchangeName: "Bybit",
    validate: validateResponse,
  }));
}

async function getAccount(credentials) {
  const payload = await privateRequest("GET", "/v5/account/wallet-balance", credentials, { accountType: "UNIFIED", coin: "USDT" });
  const account = payload.result?.list?.[0] || {};
  const coin = account.coin?.find((item) => item.coin === "USDT") || {};
  return {
    exchange: "bybit", asset: "USDT",
    available: Number(coin.availableToWithdraw || account.totalAvailableBalance || 0),
    total: Number(coin.equity || coin.walletBalance || 0), rawUpdatedAt: Date.now(),
  };
}

async function getMarkets(credentials = {}) {
  const payload = await publicRequest("/v5/market/tickers", { category: "linear" }, credentials);
  return (payload.result?.list || []).filter((item) => String(item.symbol).endsWith("USDT")).map((item) => ({
    symbol: item.symbol, lastPrice: Number(item.lastPrice), markPrice: Number(item.markPrice),
    high24h: Number(item.highPrice24h), low24h: Number(item.lowPrice24h), open24h: Number(item.prevPrice24h),
    volume24h: Number(item.volume24h), turnover24h: Number(item.turnover24h), fundingRate: Number(item.fundingRate || 0),
  })).filter((item) => item.symbol && item.lastPrice > 0);
}

async function getFeeRates(credentials) {
  const payload = await privateRequest("GET", "/v5/account/fee-rate", credentials, { category: "linear" });
  return Object.fromEntries((payload.result?.list || []).map((item) => [String(item.symbol).toUpperCase(), {
    makerFee: Number(item.makerFeeRate), takerFee: Number(item.takerFeeRate), source: "account",
  }]));
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  const normalized = String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const payload = await publicRequest("/v5/market/orderbook", { category: "linear", symbol: normalized, limit: String(depth) }, credentials);
  return { symbol: normalized, bids: (payload.result?.b || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), asks: (payload.result?.a || []).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) })), receivedAt: Date.now() };
}

const symbolSpecCache = new Map();
const positionModeCache = new Map();

async function getSymbolSpec(symbol, credentials = {}) {
  const normalized = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cached = symbolSpecCache.get(normalized);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await publicRequest("/v5/market/instruments-info", { category: "linear", symbol: normalized }, credentials);
  const item = payload.result?.list?.[0];
  if (!item) throw new Error(`Bybit не вернул параметры ${normalized}`);
  const value = { qtyStep: Number(item.lotSizeFilter?.qtyStep), minQty: Number(item.lotSizeFilter?.minOrderQty), minNotional: Number(item.lotSizeFilter?.minNotionalValue || 0), tickSize: Number(item.priceFilter?.tickSize) };
  symbolSpecCache.set(normalized, { value, expiresAt: Date.now() + 300_000 });
  return value;
}

async function getPositionMode(credentials, symbol) {
  const normalized = String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cacheKey = `${credentials?.apiKey || ""}:${normalized}`;
  const cached = positionModeCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await privateRequest("GET", "/v5/position/list", credentials, { category: "linear", symbol: normalized });
  const value = (payload.result?.list || []).some((position) => Number(position.positionIdx) === 1 || Number(position.positionIdx) === 2) ? "hedge" : "one-way";
  positionModeCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

function positionFields(order) {
  if (order?.positionMode !== "hedge") return {};
  const side = String(order?.side || "").toUpperCase();
  return { positionIdx: Number(order?.positionIdx || (order?.reduceOnly === true ? (side === "BUY" ? 2 : 1) : (side === "BUY" ? 1 : 2))) };
}

async function prepareOrder(order, credentials = {}) {
  const type = String(order?.type || "LIMIT").toUpperCase();
  const spec = await getSymbolSpec(order?.symbol, credentials);
  const quantity = floorToStep(order?.quantity ?? order?.volume, spec.qtyStep);
  const price = type === "LIMIT" ? roundToStep(order?.price, spec.tickSize) : undefined;
  if (!(quantity >= spec.minQty)) throw new Error(`Bybit: объём меньше минимума ${spec.minQty}`);
  if (type === "LIMIT" && spec.minNotional > 0 && quantity * price < spec.minNotional) throw new Error(`Bybit: сумма ордера меньше ${spec.minNotional} USDT`);
  return { ...order, quantity, ...(price ? { price } : {}), positionMode: order?.positionMode || await getPositionMode(credentials, order?.symbol) };
}

function normalizeOrder(order) {
  if (order.postOnly && String(order.type).toUpperCase() !== 'LIMIT') throw new Error('Bybit Post-Only допускается только для LIMIT');
  const type = String(order?.type || "LIMIT").toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const quantity = Number(order?.quantity ?? order?.volume);
  const price = Number(order?.price || 0);
  if (!['LIMIT', 'MARKET'].includes(type)) throw new Error("Bybit поддерживает LIMIT и MARKET");
  if (!['BUY', 'SELL'].includes(side)) throw new Error("Bybit side должен быть BUY или SELL");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Bybit quantity должен быть больше нуля");
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw new Error("Для Bybit LIMIT необходима цена");
  return { category: "linear", symbol: String(order.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), side: side === "BUY" ? "Buy" : "Sell", orderType: type === "LIMIT" ? "Limit" : "Market", qty: String(quantity), ...(type === "LIMIT" ? { price: String(price), timeInForce: order.postOnly ? 'PostOnly' : String(order.timeInForce || "GTC") } : {}), orderLinkId: String(order.clientOrderId || `hedge_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`), ...(order.reduceOnly === true ? { reduceOnly: true } : {}), ...positionFields(order) };
}

async function placeOrder(credentials, order, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  const request = normalizeOrder(await prepareOrder(order, credentials));
  require('./order-deadline.cjs').assertOrderDeadline(order);
  const payload = await privateRequest("POST", "/v5/order/create", credentials, request);
  return { exchange: "bybit", orderId: payload.result?.orderId, clientOrderId: payload.result?.orderLinkId || request.orderLinkId, response: payload };
}

function normalizeStatus(value) {
  const status = String(value || "").toUpperCase();
  return ({ NEW: "NEW", PARTIALLYFILLED: "PARTIALLY_FILLED", FILLED: "FILLED", CANCELLED: "CANCELED", REJECTED: "REJECTED", DEACTIVATED: "CANCELED" })[status.replace(/_/g, "")] || status;
}

function protectionError(message, code = "PROTECTION_INVALID") {
  return Object.assign(new Error(`Bybit: ${message}`), { code, definitive: true });
}

function protectionPosition(protection, rows) {
  const symbol = String(protection?.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const side = String(protection?.side || "").toUpperCase();
  if (!symbol || !["BUY", "SELL"].includes(side)) throw protectionError("неизвестна защищаемая позиция");
  const expectedSide = side === "BUY" ? "Buy" : "Sell";
  const requestedIdx = Number(protection?.positionIdx);
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => String(row?.symbol || "").toUpperCase() === symbol
    && row?.side === expectedSide && Number(row?.size) > 0
    && (!Number.isInteger(requestedIdx) || Number(row?.positionIdx) === requestedIdx));
  if (!matches.length) throw protectionError(`${symbol}: открытая ${expectedSide} позиция не найдена`, "PROTECTION_NOT_FOUND");
  if (matches.length !== 1) throw protectionError(`${symbol}: позиция для TP/SL определена неоднозначно`, "PROTECTION_CONFLICT");
  const position = matches[0];
  const expectedQuantity = Number(protection?.quantity);
  const actualQuantity = Number(position.size);
  if (!(expectedQuantity > 0) || Math.abs(actualQuantity - expectedQuantity) > Math.max(1e-12, expectedQuantity * 1e-8)) {
    throw protectionError(`${symbol}: объём позиции ${actualQuantity} не совпадает с защитой ${expectedQuantity}`, "PROTECTION_POSITION_MISMATCH");
  }
  return position;
}

function protectionBody(protection, position) {
  const side = String(protection?.side || "").toUpperCase();
  const takeProfitPrice = Number(protection?.takeProfitPrice);
  const stopLossPrice = Number(protection?.stopLossPrice);
  if (!(takeProfitPrice > 0) || !(stopLossPrice > 0)) throw protectionError("для серверного TP/SL нужны обе положительные цены");
  if (side === "BUY" ? !(takeProfitPrice > stopLossPrice) : !(stopLossPrice > takeProfitPrice)) {
    throw protectionError("TP/SL расположены неверно для стороны позиции");
  }
  const positionIdx = Number(position?.positionIdx);
  if (![0, 1, 2].includes(positionIdx)) throw protectionError("биржа не вернула корректный positionIdx");
  return {
    category: "linear",
    symbol: String(protection.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    tpslMode: "Full",
    positionIdx,
    takeProfit: String(takeProfitPrice),
    stopLoss: String(stopLossPrice),
    tpTriggerBy: "MarkPrice",
    slTriggerBy: "MarkPrice",
    tpOrderType: "Market",
    slOrderType: "Market",
  };
}

function protectionFromRows(protection, positionRows, orderRows) {
  const position = protectionPosition(protection, positionRows);
  const takeProfitPrice = Number(position.takeProfit || 0);
  const stopLossPrice = Number(position.stopLoss || 0);
  if (!(takeProfitPrice > 0) && !(stopLossPrice > 0)) {
    throw protectionError(`${position.symbol}: серверный TP/SL не найден`, "PROTECTION_NOT_FOUND");
  }
  const expectedTakeProfit = Number(protection.takeProfitPrice);
  const expectedStopLoss = Number(protection.stopLossPrice);
  const priceTolerance = Math.max(1e-10, Math.max(expectedTakeProfit, expectedStopLoss) * 1e-10);
  if (!(takeProfitPrice > 0) || !(stopLossPrice > 0)
    || Math.abs(takeProfitPrice - expectedTakeProfit) > priceTolerance
    || Math.abs(stopLossPrice - expectedStopLoss) > priceTolerance
    || String(position.tpslMode || "").toUpperCase() !== "FULL") {
    throw protectionError(`${position.symbol}: найден другой или неполный TP/SL; автоматическая замена запрещена`, "PROTECTION_CONFLICT");
  }

  const positionIdx = Number(position.positionIdx);
  const closingSide = String(protection.side).toUpperCase() === "BUY" ? "Sell" : "Buy";
  const quantity = Number(position.size);
  const active = (Array.isArray(orderRows) ? orderRows : []).filter((row) => {
    const status = String(row?.orderStatus || "").replace(/[_-]/g, "").toUpperCase();
    return ["UNTRIGGERED", "NEW", "PARTIALLYFILLED", "ACTIVE", "CREATED"].includes(status)
      && String(row?.symbol || "").toUpperCase() === String(position.symbol).toUpperCase()
      && Number(row?.positionIdx) === positionIdx
      && row?.side === closingSide
      && Math.abs(Number(row?.qty) - quantity) <= Math.max(1e-12, quantity * 1e-8)
      && (!row?.tpslMode || String(row.tpslMode).toUpperCase() === "FULL");
  });
  const branch = (types, price, triggerField) => active.find((row) => types.includes(String(row.stopOrderType || ""))
    && Math.abs(Number(row.triggerPrice || row[triggerField]) - price) <= priceTolerance
    && String(row[triggerField === "takeProfit" ? "tpTriggerBy" : "slTriggerBy"] || row.triggerBy || "").toUpperCase() === "MARKPRICE");
  const takeProfitOrder = branch(["TakeProfit"], expectedTakeProfit, "takeProfit");
  const stopLossOrder = branch(["StopLoss"], expectedStopLoss, "stopLoss");
  const fullyVerified = Boolean(takeProfitOrder?.orderId && stopLossOrder?.orderId);
  return {
    exchange: "bybit",
    orderId: `position:${position.symbol}:${positionIdx}`,
    clientOrderId: protection.clientOrderId,
    symbol: String(position.symbol).toUpperCase(),
    positionIdx,
    quantity,
    side: String(protection.side).toUpperCase(),
    takeProfitPrice,
    stopLossPrice,
    triggerPriceType: fullyVerified ? "mark" : null,
    status: fullyVerified ? "ACTIVE" : "PENDING",
    tpOrderId: takeProfitOrder?.orderId,
    slOrderId: stopLossOrder?.orderId,
  };
}

async function protectionRows(credentials, protection) {
  const symbol = String(protection?.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const [positions, orders] = await Promise.all([
    privateRequest("GET", "/v5/position/list", credentials, { category: "linear", symbol }),
    privateRequest("GET", "/v5/order/realtime", credentials, { category: "linear", symbol, openOnly: "0", limit: "50" }),
  ]);
  const orderRows = orders.result?.list || [];
  if (orderRows.length >= 50) throw protectionError(`${symbol}: список ордеров обрезан; подтверждение TP/SL приостановлено`, "PROTECTION_SNAPSHOT_TRUNCATED");
  return { positionRows: positions.result?.list || [], orderRows };
}

async function placeProtection(credentials, protection, options = {}) {
  if (options.allowLiveTrading !== true) throw protectionError("серверный TP/SL заблокирован без live-подтверждения");
  const symbol = String(protection?.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const positions = await privateRequest("GET", "/v5/position/list", credentials, { category: "linear", symbol });
  const position = protectionPosition(protection, positions.result?.list || []);
  const currentTakeProfit = Number(position.takeProfit || 0);
  const currentStopLoss = Number(position.stopLoss || 0);
  if (currentTakeProfit > 0 || currentStopLoss > 0) {
    const existing = await getProtection(credentials, { ...protection, positionIdx: Number(position.positionIdx) });
    if (existing.status === "ACTIVE" || existing.status === "PENDING") return existing;
  }
  const body = protectionBody(protection, position);
  await privateRequest("POST", "/v5/position/trading-stop", credentials, body);
  return {
    exchange: "bybit",
    orderId: `position:${body.symbol}:${body.positionIdx}`,
    clientOrderId: protection.clientOrderId,
    symbol: body.symbol,
    positionIdx: body.positionIdx,
    quantity: Number(position.size),
    side: String(protection.side).toUpperCase(),
    takeProfitPrice: Number(body.takeProfit),
    stopLossPrice: Number(body.stopLoss),
    triggerPriceType: "mark",
    status: "PENDING",
  };
}

async function getProtection(credentials, protection) {
  const { positionRows, orderRows } = await protectionRows(credentials, protection);
  return protectionFromRows(protection, positionRows, orderRows);
}

async function cancelProtection(credentials, protection, options = {}) {
  if (options.allowLiveTrading !== true) throw protectionError("отмена серверного TP/SL заблокирована без live-подтверждения");
  const symbol = String(protection?.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const positions = await privateRequest("GET", "/v5/position/list", credentials, { category: "linear", symbol });
  const position = protectionPosition(protection, positions.result?.list || []);
  const currentTakeProfit = Number(position.takeProfit || 0);
  const currentStopLoss = Number(position.stopLoss || 0);
  const tolerance = Math.max(1e-10, Math.max(Number(protection.takeProfitPrice), Number(protection.stopLossPrice)) * 1e-10);
  if (Math.abs(currentTakeProfit - Number(protection.takeProfitPrice)) > tolerance
    || Math.abs(currentStopLoss - Number(protection.stopLossPrice)) > tolerance) {
    throw protectionError(`${symbol}: TP/SL изменён вне приложения; автоматическая отмена запрещена`, "PROTECTION_CONFLICT");
  }
  await privateRequest("POST", "/v5/position/trading-stop", credentials, {
    category: "linear", symbol, tpslMode: "Full", positionIdx: Number(position.positionIdx), takeProfit: "0", stopLoss: "0",
  });
  return { exchange: "bybit", orderId: `position:${symbol}:${Number(position.positionIdx)}`, cancelRequested: true };
}

async function getOrder(credentials, { symbol, orderId, clientOrderId }) {
  const payload = await privateRequest("GET", "/v5/order/realtime", credentials, { category: "linear", symbol: String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), ...(orderId ? { orderId: String(orderId) } : { orderLinkId: String(clientOrderId || "") }) });
  let order = payload.result?.list?.[0];
  if (!order) {
    const history = await privateRequest("GET", "/v5/order/history", credentials, { category: "linear", symbol: String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), ...(orderId ? { orderId: String(orderId) } : { orderLinkId: String(clientOrderId || "") }) });
    order = history.result?.list?.[0];
  }
  if (!order) throw new Error("Bybit не вернул ордер");
  return { ...order, status: normalizeStatus(order.orderStatus), executedQty: order.cumExecQty };
}

async function cancelOrder(credentials, { symbol, orderId, clientOrderId }, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Отмена ордера заблокирована: требуется явный allowLiveTrading=true");
  return privateRequest("POST", "/v5/order/cancel", credentials, { category: "linear", symbol: String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), ...(orderId ? { orderId: String(orderId) } : { orderLinkId: String(clientOrderId || "") }) });
}

async function closeAllPositions(credentials, { symbol } = {}, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Закрытие позиций заблокировано без live-подтверждения");
  const payload = await privateRequest("GET", "/v5/position/list", credentials, { category: "linear", ...(symbol ? { symbol: String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase() } : { settleCoin: "USDT" }) });
  const active = (payload.result?.list || []).filter((position) => Number(position.size) > 0);
  return Promise.all(active.map((position) => placeOrder(credentials, { symbol: position.symbol, side: position.side === "Buy" ? "SELL" : "BUY", type: "MARKET", quantity: Number(position.size), positionIdx: Number(position.positionIdx || 0), positionMode: Number(position.positionIdx) > 0 ? "hedge" : "one-way", reduceOnly: true }, options)));
}

module.exports = { privateRequest, getAccount, getMarkets, getFeeRates, getDepth, getSymbolSpec, getPositionMode, prepareOrder, placeOrder, getOrder, cancelOrder, placeProtection, getProtection, cancelProtection, closeAllPositions, normalizeOrder, positionFields, protectionBody, protectionFromRows, signPayload, validateResponse };
module.exports.supportsPostOnly = true;
module.exports.supportsNativeProtection = true;
// Position TP/SL is created asynchronously as two internal conditional orders.
// Allow their exact IDs a little more time to appear before unwinding the pair.
module.exports.protectionVerificationAttempts = 20;
