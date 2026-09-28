const crypto = require("crypto");

const PRIORITY_SYMBOLS = Object.freeze([
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "TRXUSDT", "HYPEUSDT",
  "ZECUSDT", "DOGEUSDT", "LINKUSDT", "LEOUSDT", "XMRUSDT", "ADAUSDT", "XLMUSDT",
  "BCHUSDT", "TONUSDT", "LTCUSDT", "HBARUSDT", "SUIUSDT", "AVAXUSDT", "SHIBUSDT",
]);

function finiteRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function credentialFingerprint(credentials = {}) {
  const identity = [credentials.apiKey, credentials.authorization, credentials.connectionMode, credentials.proxyEnabled, credentials.proxyUrl]
    .map((value) => String(value ?? ""))
    .join("\u0000");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

class FeeRateCache {
  constructor({ ttlMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.values = new Map();
    this.pending = new Map();
  }

  async get(exchangeId, adapter, credentials, symbols, markets) {
    if (typeof adapter?.getFeeRates !== "function") return {};
    const key = `${exchangeId}:${credentialFingerprint(credentials)}`;
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const request = Promise.resolve(adapter.getFeeRates(credentials, symbols, markets))
      .then((value) => {
        const normalized = value && typeof value === "object" ? value : {};
        this.values.set(key, { expiresAt: this.now() + this.ttlMs, value: normalized });
        return normalized;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  clear() { this.values.clear(); }
}

function prioritizedSymbols(commonMarkets, limit = 25) {
  const available = new Set(commonMarkets.map((item) => String(item.symbol).toUpperCase()));
  const priority = PRIORITY_SYMBOLS.filter((symbol) => available.has(symbol));
  const rest = commonMarkets
    .filter((item) => !priority.includes(String(item.symbol).toUpperCase()))
    .sort((a, b) => Number(b.combinedTurnover || 0) - Number(a.combinedTurnover || 0))
    .map((item) => String(item.symbol).toUpperCase());
  return [...priority, ...rest].slice(0, limit);
}

function feeFor(rates, symbol, side) {
  return finiteRate(rates?.[symbol]?.[side] ?? rates?.default?.[side]);
}

function applyStrategyFees(commonMarkets, sourceRates = {}, targetRates = {}) {
  return commonMarkets.map((market) => ({
    ...market,
    makerFee: feeFor(sourceRates, market.symbol, "makerFee"),
    takerFee: feeFor(targetRates, market.symbol, "takerFee"),
    makerFeeSource: sourceRates?.[market.symbol]?.source ?? sourceRates?.default?.source ?? null,
    takerFeeSource: targetRates?.[market.symbol]?.source ?? targetRates?.default?.source ?? null,
  }));
}

module.exports = { PRIORITY_SYMBOLS, FeeRateCache, finiteRate, prioritizedSymbols, applyStrategyFees };
