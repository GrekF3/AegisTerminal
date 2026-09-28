const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const BPS_LEVELS = [5, 10, 25, 50];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const commonSymbol = value => String(value || '').toUpperCase().replace(/[_-]/g, '').replace(/USDTUSDT$/, 'USDT');
const iso = value => new Date(value).toISOString();
const safeStamp = value => iso(value).replace(/[:.]/g, '-');
function socketPayload(bytes) {
  const value = String(bytes).trim();
  if (!value || value === 'ping' || value === 'pong') return null;
  return JSON.parse(value);
}
function lbankTickerRows(message) {
  if (Array.isArray(message?.d)) return message.d;
  return message?.d && typeof message.d === 'object' ? [message.d] : [];
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

async function fetchJson(url, timeoutMs = 12_000) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Hedge-Liquidity-Scanner/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${response.status} ${new URL(url).hostname}${new URL(url).pathname}`);
  const payload = await response.json();
  if (payload?.success === false || String(payload?.result).toLowerCase() === 'false' || Number(payload?.error_code || 0) !== 0 || Number(payload?.code || 0) !== 0) {
    throw new Error(`${new URL(url).hostname}: ${payload?.msg || payload?.message || 'request rejected'}`);
  }
  return payload;
}

class SampleStat {
  constructor(limit = 512) { this.count = 0; this.sum = 0; this.min = Infinity; this.max = -Infinity; this.limit = limit; this.samples = []; }
  add(value) {
    value = Number(value); if (!Number.isFinite(value)) return;
    this.count++; this.sum += value; this.min = Math.min(this.min, value); this.max = Math.max(this.max, value);
    if (this.samples.length < this.limit) this.samples.push(value);
    else { const slot = Math.floor(Math.random() * this.count); if (slot < this.limit) this.samples[slot] = value; }
  }
  percentile(p) {
    if (!this.samples.length) return null;
    const values = [...this.samples].sort((a, b) => a - b);
    return values[Math.max(0, Math.min(values.length - 1, Math.round((values.length - 1) * p)))];
  }
  json() { return { count: this.count, min: this.count ? this.min : null, median: this.percentile(.5), p90: this.percentile(.9), max: this.count ? this.max : null, mean: this.count ? this.sum / this.count : null }; }
}

function normalizeDepth(bids, asks) {
  const clean = (rows, descending) => (rows || []).map(row => ({ price: finite(row.price ?? row[0]), quantity: finite(row.quantity ?? row.volume ?? row[1]) }))
    .filter(row => row.price > 0 && row.quantity > 0).sort((a, b) => descending ? b.price - a.price : a.price - b.price);
  bids = clean(bids, true); asks = clean(asks, false);
  if (!bids.length || !asks.length || bids[0].price >= asks[0].price) throw new Error('invalid crossed or empty depth');
  const bid = bids[0].price, ask = asks[0].price, mid = (bid + ask) / 2;
  const result = { bids, asks, bid, ask, mid, spreadBps: (ask - bid) / mid * 10_000, topBidUsd: bid * bids[0].quantity, topAskUsd: ask * asks[0].quantity };
  for (const bps of BPS_LEVELS) {
    const floor = mid * (1 - bps / 10_000), ceiling = mid * (1 + bps / 10_000);
    const bidUsd = bids.filter(row => row.price >= floor).reduce((sum, row) => sum + row.price * row.quantity, 0);
    const askUsd = asks.filter(row => row.price <= ceiling).reduce((sum, row) => sum + row.price * row.quantity, 0);
    result[`bidDepth${bps}Usd`] = bidUsd; result[`askDepth${bps}Usd`] = askUsd; result[`depth${bps}Usd`] = bidUsd + askUsd;
  }
  const total25 = result.depth25Usd;
  result.imbalance25 = total25 ? (result.bidDepth25Usd - result.askDepth25Usd) / total25 : 0;
  return result;
}

function depthSummary(value) {
  if (!value) return value;
  const { bids: _bids, asks: _asks, ...summary } = value;
  return summary;
}

class WorkQueue {
  constructor(scanner, venue, delayMs) { this.scanner = scanner; this.venue = venue; this.delayMs = delayMs; this.high = []; this.low = []; this.keys = new Set(); this.running = false; this.lastAt = 0; }
  enqueue(job, high = false) {
    const key = `${job.symbol}:${job.eventId || ''}:${job.phase || job.reason}`;
    if (this.keys.has(key) || Date.now() >= this.scanner.endAt) return;
    this.keys.add(key); (high ? this.high : this.low).push({ ...job, key }); this.kick();
  }
  async kick() {
    if (this.running) return; this.running = true;
    while (!this.scanner.stopping && Date.now() < this.scanner.endAt) {
      const job = this.high.shift() || this.low.shift(); if (!job) break;
      this.keys.delete(job.key);
      await sleep(Math.max(0, this.lastAt + this.delayMs - Date.now())); this.lastAt = Date.now();
      try { await this.scanner.captureDepth(this.venue, job); } catch (error) { this.scanner.noteError(`${this.venue}:depth`, error); }
      if (job.reason === 'baseline' && !this.scanner.stopping) this.enqueue(job, false);
    }
    this.running = false;
  }
}

class Scanner {
  constructor(options = {}) {
    this.startedAt = Date.now(); this.durationMs = options.durationMs || 60 * 60 * 1000; this.endAt = this.startedAt + this.durationMs;
    this.outputDir = path.resolve(options.outputDir || path.join(ROOT, 'output', `liquidity-scan-${safeStamp(this.startedAt)}`));
    this.movementBps = Number(options.movementBps || 3); this.catchWindowMs = Number(options.catchWindowMs || 15_000);
    this.quotes = new Map(); this.quoteStats = new Map(); this.depthStats = new Map(); this.latestDepth = new Map(); this.basis = new Map(); this.activeEvents = new Map(); this.lagStats = new Map();
    this.errors = new Map(); this.sockets = []; this.socketStatus = {}; this.eventSequence = 0; this.depthSequence = 0; this.eventDepthBudget = [];
    this.stopping = false; this.finalized = false;
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.files = { events: path.join(this.outputDir, 'lag-events.jsonl'), depth: path.join(this.outputDir, 'depth-snapshots.jsonl'), status: path.join(this.outputDir, 'status.json') };
  }

  noteError(scope, error) {
    const previous = this.errors.get(scope) || { count: 0 }; previous.count++; previous.lastAt = Date.now(); previous.message = String(error?.message || error).slice(0, 300); this.errors.set(scope, previous);
  }
  append(file, row) { fs.appendFileSync(file, `${JSON.stringify(row)}\n`); }
  atomic(file, value) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); }
  stat(map, key) { if (!map.has(key)) map.set(key, new SampleStat()); return map.get(key); }

  async discover() {
    const [lbank, mexc, mexcDetails, binanceInfo, binance24, binanceBooks] = await Promise.all([
      fetchJson('https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketData?productGroup=SwapU'),
      fetchJson('https://contract.mexc.com/api/v1/contract/ticker'),
      fetchJson('https://contract.mexc.com/api/v1/contract/detail'),
      fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
      fetchJson('https://fapi.binance.com/fapi/v1/ticker/24hr'),
      fetchJson('https://fapi.binance.com/fapi/v1/ticker/bookTicker'),
    ]);
    this.markets = { lbank: new Map(), mexc: new Map(), binance: new Map() }; this.mexcContractSize = new Map();
    for (const row of mexcDetails.data || []) this.mexcContractSize.set(commonSymbol(row.symbol), finite(row.contractSize) || 1);
    for (const row of lbank.data || []) { const symbol = commonSymbol(row.symbol); if (/^[A-Z0-9]{1,24}USDT$/.test(symbol) && finite(row.lastPrice) > 0) this.markets.lbank.set(symbol, { turnover: finite(row.turnover) || 0, volume: finite(row.volume) || 0, status: row.instrumentStatus }); }
    for (const row of mexc.data || []) { const symbol = commonSymbol(row.symbol); if (/^[A-Z0-9]{1,24}USDT$/.test(symbol) && finite(row.lastPrice) > 0) this.markets.mexc.set(symbol, { turnover: finite(row.amount24) || 0, volume: finite(row.volume24) || 0 }); }
    const trading = new Set((binanceInfo.symbols || []).filter(row => row.contractType === 'PERPETUAL' && row.quoteAsset === 'USDT' && row.status === 'TRADING').map(row => row.symbol));
    for (const row of binance24 || []) if (trading.has(row.symbol)) this.markets.binance.set(row.symbol, { turnover: finite(row.quoteVolume) || 0, volume: finite(row.volume) || 0 });
    this.lbankMexc = [...this.markets.lbank.keys()].filter(symbol => this.markets.mexc.has(symbol)).sort();
    this.lbankBinance = [...this.markets.lbank.keys()].filter(symbol => this.markets.binance.has(symbol)).sort();
    this.triple = new Set(this.lbankMexc.filter(symbol => this.markets.binance.has(symbol)));
    this.lbMxSet = new Set(this.lbankMexc); this.lbBnSet = new Set(this.lbankBinance);
    for (const row of lbank.data || []) { const symbol = commonSymbol(row.symbol); if (this.markets.lbank.has(symbol)) this.updateQuote('lbank', symbol, { price: row.lastPrice, venueAt: Number(row.lastTime) * 1000 }, true); }
    for (const row of mexc.data || []) { const symbol = commonSymbol(row.symbol); if (this.markets.mexc.has(symbol)) this.updateQuote('mexc', symbol, { price: row.lastPrice, bid: row.bid1, ask: row.ask1, venueAt: row.timestamp }, true); }
    for (const row of binanceBooks || []) if (this.markets.binance.has(row.symbol)) this.updateQuote('binance', row.symbol, { bid: row.bidPrice, ask: row.askPrice, bidQty: row.bidQty, askQty: row.askQty, venueAt: row.time }, true);
  }

  updateQuote(venue, symbol, input, bootstrap = false) {
    symbol = commonSymbol(symbol); if (!this.markets?.[venue]?.has(symbol)) return;
    const bid = finite(input.bid), ask = finite(input.ask), raw = finite(input.price), price = bid > 0 && ask > bid ? (bid + ask) / 2 : raw;
    if (!(price > 0)) return;
    const receivedAt = Date.now(), key = `${venue}:${symbol}`, previous = this.quotes.get(key);
    const row = { venue, symbol, price, bid: bid > 0 ? bid : null, ask: ask > bid ? ask : null, bidQty: finite(input.bidQty), askQty: finite(input.askQty), venueAt: finite(input.venueAt), receivedAt };
    this.quotes.set(key, row);
    let stats = this.quoteStats.get(key); if (!stats) { stats = { updates: 0, changes: 0, firstAt: receivedAt, lastAt: receivedAt, spread: new SampleStat(), intervals: new SampleStat() }; this.quoteStats.set(key, stats); }
    stats.updates++; stats.lastAt = receivedAt;
    if (row.ask) stats.spread.add((row.ask - row.bid) / row.price * 10_000);
    if (previous && previous.price !== price) { stats.changes++; stats.intervals.add(receivedAt - previous.receivedAt); }
    if (bootstrap || !previous) { this.updateBases(symbol); return; }
    this.catchEvents(venue, symbol, row);
    const movement = Math.abs((price - previous.price) / previous.price * 10_000);
    if (movement >= this.movementBps) {
      if (venue === 'binance') {
        if (this.lbBnSet.has(symbol)) this.startEvent('binance', 'lbank', symbol, previous, row, 'lbank_binance');
        if (this.triple.has(symbol)) this.startEvent('binance', 'mexc', symbol, previous, row, 'lbank_mexc');
      } else if (!this.markets.binance.has(symbol) && this.lbMxSet.has(symbol)) {
        this.startEvent(venue, venue === 'lbank' ? 'mexc' : 'lbank', symbol, previous, row, 'lbank_mexc');
      }
    }
    this.updateBases(symbol);
  }

  updateBases(symbol) {
    const pairs = this.markets.binance.has(symbol) ? [['binance', 'lbank'], ...(this.triple.has(symbol) ? [['binance', 'mexc']] : [])] : this.lbMxSet.has(symbol) ? [['lbank', 'mexc'], ['mexc', 'lbank']] : [];
    for (const [reference, follower] of pairs) {
      const a = this.quotes.get(`${reference}:${symbol}`), b = this.quotes.get(`${follower}:${symbol}`), key = `${reference}>${follower}:${symbol}`;
      if (!a || !b || Math.abs(a.receivedAt - b.receivedAt) > 5000 || this.activeEvents.has(key)) continue;
      const value = Math.log(b.price / a.price), old = this.basis.get(key); this.basis.set(key, old == null ? value : old * .98 + value * .02);
    }
  }

  startEvent(reference, follower, symbol, before, after, pair) {
    const key = `${reference}>${follower}:${symbol}`, followerQuote = this.quotes.get(`${follower}:${symbol}`);
    if (!followerQuote || this.activeEvents.has(key) || after.receivedAt - followerQuote.receivedAt > 5000) return;
    const last = this.lastEventAt?.get(key) || 0; if (after.receivedAt - last < 5000) return;
    this.lastEventAt ||= new Map(); this.lastEventAt.set(key, after.receivedAt);
    const basis = this.basis.get(key) ?? Math.log(followerQuote.price / before.price), target = after.price * Math.exp(basis), gapBps = (target - followerQuote.price) / target * 10_000;
    if (Math.abs(gapBps) < this.movementBps * .6) return;
    const id = `${this.startedAt}-${++this.eventSequence}`;
    const event = { id, pair, symbol, reference, follower, detectedAt: after.receivedAt, referenceVenueAt: after.venueAt, referenceBefore: before.price, referenceAfter: after.price, referenceMoveBps: (after.price - before.price) / before.price * 10_000, followerBefore: followerQuote.price, expectedFollower: target, initialGapBps: gapBps, basisBps: basis * 10_000, caught: false, lagMs: null, preDepth: {} };
    for (const venue of new Set([reference, follower, 'lbank'])) { const depth = this.latestDepth.get(`${venue}:${symbol}`); if (depth) event.preDepth[venue] = { ...depthSummary(depth.metrics), ageMs: after.receivedAt - depth.receivedAt, receivedAt: depth.receivedAt }; }
    this.activeEvents.set(key, event); this.captureAroundEvent(event);
  }

  catchEvents(venue, symbol, quote) {
    for (const [key, event] of this.activeEvents) {
      if (event.follower !== venue || event.symbol !== symbol) continue;
      const remainingBps = (event.expectedFollower - quote.price) / event.expectedFollower * 10_000;
      const movedSameWay = Math.sign(quote.price - event.followerBefore) === Math.sign(event.expectedFollower - event.followerBefore);
      if (movedSameWay && Math.abs(remainingBps) <= Math.max(1.5, Math.abs(event.initialGapBps) * .35)) {
        event.caught = true; event.caughtAt = quote.receivedAt; event.followerAfter = quote.price; event.remainingGapBps = remainingBps; event.lagMs = Math.max(0, quote.receivedAt - event.detectedAt); this.finishEvent(key, event);
      }
    }
  }

  captureAroundEvent(event) {
    const now = Date.now(); this.eventDepthBudget = this.eventDepthBudget.filter(value => now - value < 60_000);
    if (this.eventDepthBudget.length >= 30) { event.depthCapture = 'rate_limited'; return; }
    this.eventDepthBudget.push(now); event.depthCapture = 'scheduled';
    const venues = [...new Set([event.reference, event.follower, 'lbank'])].filter(venue => this.markets[venue].has(event.symbol));
    for (const venue of venues) this.queues[venue].enqueue({ symbol: event.symbol, reason: 'event', eventId: event.id, phase: 'immediate', eventAt: event.detectedAt }, true);
    const timer = setTimeout(() => { if (!this.stopping) for (const venue of venues) this.queues[venue].enqueue({ symbol: event.symbol, reason: 'event', eventId: event.id, phase: 'after_5s', eventAt: event.detectedAt }, true); }, 5000); timer.unref?.();
  }

  finishEvent(key, event, expired = false) {
    if (!this.activeEvents.delete(key)) return; event.finishedAt = Date.now(); event.expired = expired;
    const statKey = `${event.reference}>${event.follower}:${event.symbol}`; let stat = this.lagStats.get(statKey); if (!stat) { stat = { total: 0, caught: 0, lag: new SampleStat() }; this.lagStats.set(statKey, stat); }
    stat.total++; if (event.caught) { stat.caught++; stat.lag.add(event.lagMs); }
    this.append(this.files.events, event);
  }

  sweepEvents() { for (const [key, event] of this.activeEvents) if (Date.now() - event.detectedAt >= this.catchWindowMs) this.finishEvent(key, event, true); }

  async fetchDepth(venue, symbol) {
    if (venue === 'lbank') {
      const payload = await fetchJson(`https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketOrder?symbol=${encodeURIComponent(symbol)}&depth=25`), data = payload.data || payload;
      return normalizeDepth(data.bids, data.asks);
    }
    if (venue === 'mexc') {
      const wire = symbol.replace(/USDT$/, '_USDT'), payload = await fetchJson(`https://contract.mexc.com/api/v1/contract/depth/${wire}?limit=20`), data = payload.data || payload, multiplier = this.mexcContractSize.get(symbol) || 1;
      return normalizeDepth((data.bids || []).map(row => [row[0], Number(row[1]) * multiplier]), (data.asks || []).map(row => [row[0], Number(row[1]) * multiplier]));
    }
    const payload = await fetchJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=20`);
    return normalizeDepth(payload.bids, payload.asks);
  }

  async captureDepth(venue, job) {
    const requestedAt = Date.now(), metrics = await this.fetchDepth(venue, job.symbol), receivedAt = Date.now(), key = `${venue}:${job.symbol}`;
    this.latestDepth.set(key, { metrics, receivedAt });
    let stats = this.depthStats.get(key); if (!stats) { stats = { count: 0, spread: new SampleStat(), depth5: new SampleStat(), depth10: new SampleStat(), depth25: new SampleStat(), depth50: new SampleStat(), latency: new SampleStat() }; this.depthStats.set(key, stats); }
    stats.count++; stats.spread.add(metrics.spreadBps); stats.depth5.add(metrics.depth5Usd); stats.depth10.add(metrics.depth10Usd); stats.depth25.add(metrics.depth25Usd); stats.depth50.add(metrics.depth50Usd); stats.latency.add(receivedAt - requestedAt);
    this.depthSequence++; this.append(this.files.depth, { sequence: this.depthSequence, venue, symbol: job.symbol, reason: job.reason, eventId: job.eventId || null, phase: job.phase || null, eventOffsetMs: job.eventAt ? receivedAt - job.eventAt : null, requestedAt, receivedAt, ...depthSummary(metrics) });
  }

  openSocket(name, url, { onOpen, onMessage, heartbeat }) {
    const state = this.socketStatus[name] = { connected: false, messages: 0, reconnects: 0, lastMessageAt: null }; let socket, stopped = false, beat, retry;
    const open = () => {
      if (stopped || this.stopping) return; socket = new WebSocket(url, { handshakeTimeout: 12_000, maxPayload: 16 * 1024 * 1024 });
      socket.on('open', () => { state.connected = true; onOpen?.(socket); clearInterval(beat); beat = setInterval(() => { try { if (socket.readyState === 1) heartbeat ? socket.send(heartbeat) : socket.ping(); } catch {} }, 10_000); beat.unref?.(); });
      socket.on('message', bytes => { state.messages++; state.lastMessageAt = Date.now(); try { const message = socketPayload(bytes); if (message) onMessage(message); } catch (error) { this.noteError(`${name}:message`, error); } });
      socket.on('error', error => { this.noteError(`${name}:socket`, error); try { socket.close(); } catch {} });
      socket.on('close', () => { state.connected = false; clearInterval(beat); if (!stopped && !this.stopping) { state.reconnects++; retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(state.reconnects, 5))); retry.unref?.(); } });
    };
    open(); const close = () => { stopped = true; clearInterval(beat); clearTimeout(retry); try { socket?.close(); } catch {} }; this.sockets.push(close); return close;
  }

  startStreams() {
    const lbankSymbols = [...this.markets.lbank.keys()];
    for (let offset = 0; offset < lbankSymbols.length; offset += 100) {
      const group = lbankSymbols.slice(offset, offset + 100), id = `scanner-${offset / 100}`;
      this.openSocket(`lbank-${offset / 100 + 1}`, 'wss://uuws.rerrkvifj.com/ws/v3', {
        heartbeat: 'ping', onOpen: socket => socket.send(JSON.stringify({ x: 1, y: id, z: 1, a: { i: group.join(',') }, e: '{"bvc":"202","isUsd":1}' })),
        onMessage: message => { if (Number(message.x) !== 1 || ![3, 4].includes(Number(message.z))) return; for (const row of lbankTickerRows(message)) this.updateQuote('lbank', row.a, { price: row.i, venueAt: message.w }); },
      });
    }
    this.openSocket('mexc', 'wss://contract.mexc.com/edge', {
      heartbeat: '{"method":"ping"}', onOpen: socket => socket.send('{"method":"sub.tickers","param":{}}'),
      onMessage: message => { if (message.channel !== 'push.tickers' || !Array.isArray(message.data)) return; for (const row of message.data) this.updateQuote('mexc', row.symbol, { price: row.lastPrice, bid: row.bid1, ask: row.ask1, venueAt: message.ts }); },
    });
    this.openSocket('binance', 'wss://fstream.binance.com/ws/!bookTicker', {
      onMessage: message => { const rows = Array.isArray(message) ? message : [message.data || message]; for (const row of rows) if (row.s) this.updateQuote('binance', row.s, { bid: row.b, ask: row.a, bidQty: row.B, askQty: row.A, venueAt: row.E || row.T }); },
    });
  }

  startDepthQueues() {
    this.queues = { lbank: new WorkQueue(this, 'lbank', 350), mexc: new WorkQueue(this, 'mexc', 350), binance: new WorkQueue(this, 'binance', 200) };
    const symbols = new Set([...this.lbankMexc, ...this.lbankBinance]);
    for (const symbol of symbols) {
      this.queues.lbank.enqueue({ symbol, reason: 'baseline' });
      if (this.markets.mexc.has(symbol)) this.queues.mexc.enqueue({ symbol, reason: 'baseline' });
      if (this.markets.binance.has(symbol)) this.queues.binance.enqueue({ symbol, reason: 'baseline' });
    }
  }

  lagJson(reference, follower, symbol) {
    const row = this.lagStats.get(`${reference}>${follower}:${symbol}`); return row ? { samples: row.total, caught: row.caught, catchRate: row.total ? row.caught / row.total : null, ...row.lag.json() } : { samples: 0, caught: 0, catchRate: null, median: null, p90: null };
  }
  quoteJson(venue, symbol) {
    const row = this.quoteStats.get(`${venue}:${symbol}`); if (!row) return { updates: 0, changes: 0, changesPerMinute: 0, medianSpreadBps: null };
    const minutes = Math.max((row.lastAt - row.firstAt) / 60_000, 1 / 60); return { updates: row.updates, changes: row.changes, changesPerMinute: row.changes / minutes, medianSpreadBps: row.spread.percentile(.5), medianChangeIntervalMs: row.intervals.percentile(.5) };
  }
  depthJson(venue, symbol) {
    const row = this.depthStats.get(`${venue}:${symbol}`); return row ? { samples: row.count, medianSpreadBps: row.spread.percentile(.5), medianDepth5Usd: row.depth5.percentile(.5), medianDepth10Usd: row.depth10.percentile(.5), medianDepth25Usd: row.depth25.percentile(.5), medianDepth50Usd: row.depth50.percentile(.5), medianRequestMs: row.latency.percentile(.5) } : { samples: 0, medianSpreadBps: null, medianDepth25Usd: null };
  }

  rows(pair) {
    const peer = pair === 'lbank_mexc' ? 'mexc' : 'binance', symbols = pair === 'lbank_mexc' ? this.lbankMexc : this.lbankBinance;
    const rows = symbols.map(symbol => {
      const lq = this.quoteJson('lbank', symbol), pq = this.quoteJson(peer, symbol), ld = this.depthJson('lbank', symbol), pd = this.depthJson(peer, symbol);
      const turnover24h = Math.min(this.markets.lbank.get(symbol)?.turnover || 0, this.markets[peer].get(symbol)?.turnover || 0);
      const depth25Usd = ld.medianDepth25Usd != null && pd.medianDepth25Usd != null ? Math.min(ld.medianDepth25Usd, pd.medianDepth25Usd) : null;
      const worstSpreadBps = Math.max(ld.medianSpreadBps ?? 1e6, pd.medianSpreadBps ?? pq.medianSpreadBps ?? 1e6);
      const activity = Math.min(lq.changesPerMinute, pq.changesPerMinute);
      const lbLag = this.lagJson('binance', 'lbank', symbol), peerLag = peer === 'mexc' ? this.lagJson('binance', 'mexc', symbol) : lbLag;
      const directA = this.lagJson('lbank', 'mexc', symbol), directB = this.lagJson('mexc', 'lbank', symbol);
      return { pair, symbol, binanceReference: this.markets.binance.has(symbol), turnover24h, depth25Usd, worstSpreadBps: worstSpreadBps >= 1e6 ? null : worstSpreadBps, activityChangesPerMinute: activity, frozen: lq.changes === 0 || pq.changes === 0, lbank: { quote: lq, depth: ld }, [peer]: { quote: pq, depth: pd }, lag: pair === 'lbank_binance' ? { binanceToLbank: lbLag } : this.triple.has(symbol) ? { binanceToLbank: lbLag, binanceToMexc: peerLag, lbankBehindMexcMs: lbLag.median != null && peerLag.median != null ? lbLag.median - peerLag.median : null } : { lbankToMexc: directA, mexcToLbank: directB } };
    });
    const rank = (field, inverse = false) => { const valid = rows.map(row => row[field]).filter(Number.isFinite).sort((a, b) => a - b); return value => { if (!Number.isFinite(value) || !valid.length) return 0; const at = valid.findLastIndex(item => item <= value); const p = at / Math.max(1, valid.length - 1); return inverse ? 1 - p : p; }; };
    const turnoverRank = rank('turnover24h'), depthRank = rank('depth25Usd'), activityRank = rank('activityChangesPerMinute'), spreadRank = rank('worstSpreadBps', true);
    for (const row of rows) row.liquidityScore = Math.round(1000 * (.4 * turnoverRank(row.turnover24h) + .4 * depthRank(row.depth25Usd) + .15 * activityRank(row.activityChangesPerMinute) + .05 * spreadRank(row.worstSpreadBps))) / 10;
    return rows.sort((a, b) => b.liquidityScore - a.liquidityScore || b.turnover24h - a.turnover24h);
  }

  snapshot(final = false) {
    const lbankMexc = this.rows('lbank_mexc'), lbankBinance = this.rows('lbank_binance');
    return { version: 1, final, pid: process.pid, startedAt: iso(this.startedAt), endsAt: iso(this.endAt), generatedAt: iso(Date.now()), elapsedMs: Date.now() - this.startedAt, universe: { lbank: this.markets.lbank.size, mexc: this.markets.mexc.size, binance: this.markets.binance.size, lbankMexc: this.lbankMexc.length, lbankBinance: this.lbankBinance.length, triple: this.triple.size }, counters: { quoteSymbols: this.quoteStats.size, depthSnapshots: this.depthSequence, lagEvents: [...this.lagStats.values()].reduce((sum, row) => sum + row.total, 0), activeEvents: this.activeEvents.size }, sockets: this.socketStatus, errors: Object.fromEntries(this.errors), rankings: { lbankMexc, lbankBinance } };
  }
  status() { const report = this.snapshot(false); this.atomic(this.files.status, { ...report, rankings: undefined, outputDir: this.outputDir }); this.atomic(path.join(this.outputDir, 'report.partial.json'), report); }

  csv(rows) {
    const columns = ['rank', 'symbol', 'score', 'turnover24h', 'depth25Usd', 'spreadBps', 'activityPerMinute', 'frozen', 'binanceReference', 'lbankLagMs', 'peerLagMs', 'lbankBehindPeerMs', 'lagSamples'];
    const lines = [columns.join(',')]; rows.forEach((row, index) => { const a = row.lag.binanceToLbank || {}, b = row.lag.binanceToMexc || {}; const values = [index + 1, row.symbol, row.liquidityScore, row.turnover24h, row.depth25Usd, row.worstSpreadBps, row.activityChangesPerMinute, row.frozen, row.binanceReference, a.median, b.median, row.lag.lbankBehindMexcMs, a.samples || row.lag.lbankToMexc?.samples || row.lag.mexcToLbank?.samples || 0]; lines.push(values.map(value => value == null ? '' : String(value)).join(',')); }); return `${lines.join('\n')}\n`;
  }
  markdown(report) {
    const table = (title, rows) => [`## ${title}`, '', '| # | Symbol | Score | Turnover min | Depth 25bps min | Spread bps | Changes/min | Lag |', '|---:|---|---:|---:|---:|---:|---:|---:|', ...rows.map((row, index) => { const lag = row.lag.binanceToLbank?.median ?? row.lag.lbankBehindMexcMs ?? row.lag.lbankToMexc?.median ?? row.lag.mexcToLbank?.median; return `| ${index + 1} | ${row.symbol} | ${row.liquidityScore} | ${Math.round(row.turnover24h)} | ${row.depth25Usd == null ? 'n/a' : Math.round(row.depth25Usd)} | ${row.worstSpreadBps == null ? 'n/a' : row.worstSpreadBps.toFixed(2)} | ${row.activityChangesPerMinute.toFixed(2)} | ${lag == null ? 'n/a' : `${Math.round(lag)} ms`} |`; }), ''];
    return ['# LBank liquidity and convergence scan', '', `Started: ${report.startedAt}`, `Finished: ${report.generatedAt}`, `Duration: ${(report.elapsedMs / 3600000).toFixed(2)} h`, '', ...table('LBank ↔ MEXC', report.rankings.lbankMexc), ...table('LBank ↔ Binance', report.rankings.lbankBinance)].join('\n');
  }

  async finish(reason = 'completed') {
    if (this.finalized) return; this.finalized = true; this.stopping = true; for (const close of this.sockets) close(); for (const [key, event] of [...this.activeEvents]) this.finishEvent(key, event, true);
    const report = this.snapshot(true); report.reason = reason; this.atomic(path.join(this.outputDir, 'report.json'), report);
    fs.writeFileSync(path.join(this.outputDir, 'lbank-mexc.csv'), this.csv(report.rankings.lbankMexc)); fs.writeFileSync(path.join(this.outputDir, 'lbank-binance.csv'), this.csv(report.rankings.lbankBinance)); fs.writeFileSync(path.join(this.outputDir, 'report.md'), this.markdown(report));
    this.atomic(this.files.status, { final: true, reason, pid: process.pid, startedAt: report.startedAt, finishedAt: report.generatedAt, outputDir: this.outputDir, universe: report.universe, counters: report.counters, errors: report.errors });
  }

  async run() {
    await this.discover(); this.queues = {}; this.startDepthQueues(); this.startStreams(); this.status();
    const sweep = setInterval(() => this.sweepEvents(), 500), status = setInterval(() => { try { this.status(); } catch (error) { this.noteError('checkpoint', error); } }, 60_000);
    await sleep(Math.max(1, this.endAt - Date.now())); clearInterval(sweep); clearInterval(status); await this.finish('completed'); return this.snapshot(true);
  }
}

async function main() {
  const seconds = Number(argument('duration-seconds', 0)), minutes = Number(argument('duration-minutes', 0)), hours = Number(argument('duration-hours', 1));
  const durationMs = seconds > 0 ? seconds * 1000 : minutes > 0 ? minutes * 60_000 : hours * 3_600_000;
  const scanner = new Scanner({ durationMs, outputDir: argument('output', undefined), movementBps: argument('movement-bps', 3) });
  let signal; for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { if (!signal) { signal = name; scanner.finish(name).finally(() => process.exit(0)); } });
  try { const report = await scanner.run(); console.log(JSON.stringify({ ok: true, outputDir: scanner.outputDir, universe: report.universe, counters: report.counters })); }
  catch (error) { scanner.noteError('fatal', error); await scanner.finish('failed'); console.error(error.stack || error); process.exitCode = 1; }
}

if (require.main === module) main();
module.exports = { Scanner, SampleStat, normalizeDepth, depthSummary, commonSymbol, socketPayload, lbankTickerRows };
