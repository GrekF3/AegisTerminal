const lbank = require("./lbank.cjs");
const binance = require("./binance.cjs");
const bybit = require("./bybit.cjs");
const okx = require("./okx.cjs");
const bitget = require("./bitget.cjs");
const mexc = require("./mexc.cjs");
const gateio = require("./gateio.cjs");

const adapters = Object.freeze({ lbank, binance, bybit, okx, bitget, mexc, gateio });
const { installAccountCapabilities } = require("./account-capabilities.cjs");
const { installIntradayTrend } = require("./intraday-trend.cjs");
const { installPublicMarketStream } = require('./public-market-streams.cjs');
Object.entries(adapters).forEach(([id, adapter]) => installPublicMarketStream(id, adapter));
Object.entries(adapters).forEach(([id, adapter]) => installAccountCapabilities(id, adapter));
Object.entries(adapters).forEach(([id, adapter]) => installIntradayTrend(id, adapter));

function getAdapter(exchangeId) { return adapters[String(exchangeId || "").toLowerCase()] || null; }

module.exports = { adapters, getAdapter };
