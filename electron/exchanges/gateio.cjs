const crypto = require("crypto");
const { requestJson } = require("./transport.cjs");
const { exchangeRequest } = require("./exchange-errors.cjs");
const { floorToStep } = require("./order-sizing.cjs");

const BASE_URL = "https://api.gateio.ws";
const PREFIX = "/api/v4";

function toContract(symbol) { return String(symbol || "").toUpperCase().replace(/[_-]/g, "").replace(/USDT$/, "_USDT"); }
function toCommonSymbol(symbol) { return String(symbol || "").replace("_USDT", "USDT"); }

function validateCredentials(credentials) { if (!credentials?.apiKey || !credentials?.secret) throw new Error("Gate.io API Key и API Secret обязательны"); }

function sign(method, path, query, body, timestamp, secret) {
  const bodyHash = crypto.createHash("sha512").update(body || "").digest("hex");
  return crypto.createHmac("sha512", secret).update(`${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`).digest("hex");
}

async function request(method, path, credentials = {}, parameters = {}, authenticated = false, queryOnly = false) {
  const upperMethod = String(method).toUpperCase();
  const query = queryOnly || upperMethod === "GET" || upperMethod === "DELETE" ? new URLSearchParams(parameters).toString() : "";
  const body = upperMethod === "POST" && !queryOnly ? JSON.stringify(parameters) : "";
  const headers = { accept: "application/json", "content-type": "application/json" };
  const fullPath = `${PREFIX}${path}`;
  if (authenticated) {
    validateCredentials(credentials);
    const timestamp = String(Math.floor(Date.now() / 1000));
    Object.assign(headers, { KEY: credentials.apiKey, Timestamp: timestamp, SIGN: sign(upperMethod, fullPath, query, body, timestamp, credentials.secret) });
  }
  return exchangeRequest("gateio", requestJson(`${BASE_URL}${fullPath}${query ? `?${query}` : ""}`, { method: upperMethod, headers, ...(body ? { body } : {}), credentials, exchangeName: "Gate.io" }));
}

async function getAccount(credentials) {
  const account = await request("GET", "/futures/usdt/accounts", credentials, {}, true);
  return { exchange: "gateio", asset: "USDT", available: Number(account.available || 0), total: Number(account.total ?? account.available ?? 0) + Number(account.unrealised_pnl ?? account.unrealized_pnl ?? 0), rawUpdatedAt: Date.now() };
}

async function getMarkets(credentials = {}) {
  const items = await request("GET", "/futures/usdt/tickers", credentials);
  return (items || []).filter((item) => String(item.contract).endsWith("_USDT")).map((item) => ({ symbol: toCommonSymbol(item.contract), exchangeSymbol: item.contract, lastPrice: Number(item.last), markPrice: Number(item.mark_price || item.last), high24h: Number(item.high_24h), low24h: Number(item.low_24h), open24h: Number(item.last) / Math.max(1 + Number(item.change_percentage || 0) / 100, 0.000001), volume24h: Number(item.volume_24h || item.total_size || 0), turnover24h: Number(item.volume_24h_usd || 0), fundingRate: Number(item.funding_rate || 0) })).filter((item) => item.lastPrice > 0);
}

async function getFeeRates(credentials) {
  const payload = await request("GET", "/futures/usdt/fee", credentials, {}, true);
  const entries = Array.isArray(payload) ? payload.map((item) => [item.contract, item]) : Object.entries(payload || {});
  return Object.fromEntries(entries.map(([contract, value]) => [toCommonSymbol(contract), {
    makerFee: Number(value.maker_fee), takerFee: Number(value.taker_fee), source: "account",
  }]));
}

async function getDepth(symbol, depth = 25, credentials = {}) {
  const contract = toContract(symbol);
  const data = await request("GET", "/futures/usdt/order_book", credentials, { contract, limit: String(Math.min(depth, 100)) });
  const mapLevel = (level) => ({ price: Number(level.p ?? level[0]), quantity: Math.abs(Number(level.s ?? level[1])) });
  return { symbol: toCommonSymbol(contract), bids: (data.bids || []).map(mapLevel), asks: (data.asks || []).map(mapLevel), receivedAt: Date.now() };
}

async function getContractSpec(symbol, credentials = {}) {
  const contract = toContract(symbol);
  const item = await request("GET", `/futures/usdt/contracts/${contract}`, credentials);
  const contractSize = Number(item.quanto_multiplier);
  const minContracts = Math.max(1, Number(item.order_size_min || 1));
  if (!(contractSize > 0)) throw new Error(`Gate.io не вернул множитель ${contract}`);
  return { contractSize, minContracts, tickSize: Number(item.order_price_round), maxLeverage: Number(item.leverage_max) };
}

async function prepareOrder(order, credentials = {}) {
  if (order?.contracts != null) return order;
  const quantity = Number(order?.quantity ?? order?.volume);
  const spec = await getContractSpec(order?.symbol, credentials);
  const contracts = floorToStep(quantity / spec.contractSize, 1);
  if (contracts < spec.minContracts) throw new Error(`Gate.io: объём меньше минимума ${spec.minContracts} контрактов`);
  return { ...order, contracts, baseQuantity: contracts * spec.contractSize };
}

function normalizeOrder(order) {
  if (order.postOnly && String(order.type).toUpperCase() !== 'LIMIT') throw new Error('Gate.io Post-Only допускается только для LIMIT');
  const type = String(order?.type || "LIMIT").toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const contracts = Number(order?.contracts ?? order?.quantity ?? order?.volume);
  const price = Number(order?.price || 0);
  if (!Number.isInteger(contracts) || contracts <= 0) throw new Error("Gate.io требует целое количество контрактов");
  if (!['BUY', 'SELL'].includes(side)) throw new Error("Gate.io side должен быть BUY или SELL");
  if (type === "LIMIT" && (!Number.isFinite(price) || price <= 0)) throw new Error("Для Gate.io LIMIT необходима цена");
  return { contract: toContract(order.symbol), size: side === "BUY" ? contracts : -contracts, price: type === "MARKET" ? "0" : String(price), tif: type === "MARKET" ? "ioc" : order.postOnly ? 'poc' : String(order.timeInForce || "gtc").toLowerCase(), text: String(order.clientOrderId || `t-hedge-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`).slice(0, 28), ...(order.reduceOnly === true ? { reduce_only: true } : {}) };
}

async function placeOrder(credentials, order, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Live trading заблокирован: требуется явный allowLiveTrading=true");
  const requestBody = normalizeOrder(await prepareOrder(order, credentials));
  require('./order-deadline.cjs').assertOrderDeadline(order);
  const response = await request("POST", "/futures/usdt/orders", credentials, requestBody, true);
  return { exchange: "gateio", orderId: response.id_string || response.id, clientOrderId: response.text || requestBody.text, response };
}

function orderLookupId({ orderId, clientOrderId } = {}) {
  // Gate returns numeric order IDs larger than Number.MAX_SAFE_INTEGER. JSON.parse can round them,
  // while the client `text` identifier is exact and is accepted by the same status/cancel routes.
  const clientId = String(clientOrderId || "");
  if (clientId.startsWith("t-") && clientId.length > 2) return clientId;
  const exchangeId = String(orderId || "");
  if (!exchangeId) throw new Error("Gate.io orderId или clientOrderId обязателен");
  return exchangeId;
}

async function getOrder(credentials, { orderId, clientOrderId, symbol }) {
  const lookupId = orderLookupId({ orderId, clientOrderId });
  const order = await request("GET", `/futures/usdt/orders/${encodeURIComponent(lookupId)}`, credentials, {}, true);
  const executedQty = Math.max(0, Math.abs(Number(order.size || 0)) - Math.abs(Number(order.left || 0)));
  const status = order.status === "open" ? (executedQty > 0 ? "PARTIALLY_FILLED" : "NEW") : order.finish_as === "filled" ? "FILLED" : "CANCELED";
  const spec = await getContractSpec(symbol || order.contract, credentials);
  return { ...order, status, executedQty: executedQty * spec.contractSize };
}

async function cancelOrder(credentials, { orderId, clientOrderId }, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Отмена ордера заблокирована: требуется явный allowLiveTrading=true");
  return request("DELETE", `/futures/usdt/orders/${encodeURIComponent(orderLookupId({ orderId, clientOrderId }))}`, credentials, {}, true);
}

async function closeAllPositions(credentials, { symbol } = {}, options = {}) {
  if (options.allowLiveTrading !== true) throw new Error("Закрытие позиций заблокировано без live-подтверждения");
  const positions = await request("GET", "/futures/usdt/positions", credentials, {}, true);
  const active = (positions || []).filter((position) => Number(position.size) !== 0 && (!symbol || toCommonSymbol(position.contract) === String(symbol).toUpperCase()));
  return Promise.all(active.map((position) => request("POST", "/futures/usdt/orders", credentials, { contract: position.contract, size: 0, price: "0", tif: "ioc", close: true, reduce_only: true, auto_size: Number(position.size) > 0 ? "close_long" : "close_short", text: `t-hedge-stop-${Date.now()}`.slice(0, 28) }, true)));
}

module.exports = { request, getAccount, getMarkets, getFeeRates, getDepth, getContractSpec, prepareOrder, placeOrder, getOrder, cancelOrder, closeAllPositions, normalizeOrder, orderLookupId, sign, toContract };
module.exports.supportsPostOnly = true;
