const { requestJson } = require('./transport.cjs');
const DAY = 86_400_000;
const dayStart = (now) => Math.floor(now / DAY) * DAY;

function candleRequest(exchange, symbol, now) {
  if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol)) throw new Error('Некорректный символ дневного тренда');
  const contract = symbol.replace(/USDT$/, '_USDT');
  const start = dayStart(now);
  switch (exchange) {
    case 'binance': return [`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=2`, (p) => p.map((r) => ({ time: Number(r[0]), open: Number(r[1]) }))];
    case 'bybit': return [`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=2`, (p) => { if (Number(p.retCode) !== 0) throw new Error(p.retMsg); return p.result.list.map((r) => ({ time: Number(r[0]), open: Number(r[1]) })); }];
    case 'okx': return [`https://www.okx.com/api/v5/market/candles?instId=${symbol.replace(/USDT$/, '-USDT-SWAP')}&bar=1Dutc&limit=2`, (p) => { if (String(p.code) !== '0') throw new Error(p.msg); return p.data.map((r) => ({ time: Number(r[0]), open: Number(r[1]) })); }];
    case 'gateio': return [`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=1d&limit=2`, (p) => p.map((r) => ({ time: Number(r.t) * 1000, open: Number(r.o) }))];
    case 'bitget': return [`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1Dutc&limit=2`, (p) => { if (String(p.code) !== '00000') throw new Error(p.msg); return p.data.map((r) => ({ time: Number(r[0]), open: Number(r[1]) })); }];
    // The first UTC hourly candle avoids relying on the venue's default daily timezone.
    case 'mexc': return [`https://contract.mexc.com/api/v1/contract/kline/${contract}?interval=Min60&start=${start / 1000}&end=${Math.floor(Math.min(now, start + 3_599_000) / 1000)}`, (p) => { if (p.success === false || Number(p.code) !== 0) throw new Error(p.message); return p.data.time.map((t, i) => ({ time: Number(t) * 1000, open: Number(p.data.open[i]) })); }];
    default: throw new Error(`${exchange}: нет данных внутридневного тренда`);
  }
}

async function fetchDayOpen(exchange, symbol, credentials = {}, { request = requestJson, now = Date.now() } = {}) {
  const [url, parse] = candleRequest(exchange, symbol, now);
  const rows = parse(await request(url, { credentials, exchangeName: exchange }));
  const candle = rows.find((row) => row.time === dayStart(now));
  if (!candle || !Number.isFinite(candle.open) || candle.open <= 0) throw new Error(`${exchange}: ${symbol} — нет цены открытия сегодняшнего дня UTC. Вход не выполнен.`);
  return { ...candle, receivedAt: now };
}

function calculateTrend(candle, current, now = Date.now()) {
  if (candle?.time !== dayStart(now) || !(candle.open > 0) || !Number.isFinite(candle.open) || !(current > 0) || !Number.isFinite(current)) throw new Error('Нет актуальных данных для внутридневного тренда');
  const changePercent = (current / candle.open - 1) * 100;
  if (Math.abs(changePercent) < 1e-10) throw new Error('Цена равна открытию дня: направления пока нет. Пересчитайте вход позже.');
  return { dayStartedAt: candle.time, dayOpen: candle.open, currentPrice: current, changePercent, targetSide: changePercent > 0 ? 'BUY' : 'SELL', calculatedAt: now };
}

function installIntradayTrend(exchange, adapter) {
  if (typeof adapter.getDayOpen === 'function') return;
  if (!['binance', 'bybit', 'okx', 'gateio', 'bitget', 'mexc'].includes(exchange)) return;
  const cache = new Map();
  adapter.getDayOpen = async (symbol, credentials) => {
    const key = `${dayStart(Date.now())}:${symbol}`;
    if (!cache.has(key)) {
      const value = await fetchDayOpen(exchange, symbol, credentials);
      if (cache.size > 200) cache.clear();
      cache.set(key, value);
    }
    return cache.get(key);
  };
}
module.exports = { dayStart, candleRequest, fetchDayOpen, calculateTrend, installIntradayTrend };
