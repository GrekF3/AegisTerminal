'use strict';

const { EventEmitter } = require('node:events');
const { normalizeBook } = require('./core.cjs');

const SocketImpl = globalThis.WebSocket || require('ws');

async function textOf(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof data.text === 'function') return data.text();
  return String(data ?? '');
}

function commonSymbol(value) { return String(value || '').toUpperCase().replace(/[-_]/g, ''); }

function decimalString(value) {
  const number = Number(value);
  if (!(number > 0)) throw new Error('Некорректный шаг цены');
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  return number.toFixed(Math.min(16, Math.max(0, -Math.floor(Math.log10(number))))).replace(/0+$/, '').replace(/\.$/, '');
}

function validateTime(value, receivedAt, maxSkewMs = 15_000) {
  let time = Number(value);
  if (time > 0 && time < 1e12) time *= 1000;
  return Number.isFinite(time) && Math.abs(receivedAt - time) <= maxSkewMs ? time : receivedAt;
}

function decodeBinance(raw, symbol, receivedAt = Date.now()) {
  const message = raw?.data || raw;
  if (!message || commonSymbol(message.s) !== symbol) return [];
  const venueAt = validateTime(message.E ?? message.T, receivedAt);
  if (message.e === 'depthUpdate') return [{ type: 'book', venue: 'binance', symbol, book: { bids: message.b, asks: message.a, receivedAt, venueAt } }];
  if (message.e === 'bookTicker' || message.b != null && message.a != null && message.B != null && message.A != null) {
    return [{ type: 'quote', venue: 'binance', symbol, bid: Number(message.b), ask: Number(message.a), receivedAt, venueAt }];
  }
  return [];
}

function decodeMexc(raw, symbol, multiplier = 1, receivedAt = Date.now(), venueSymbol = symbol) {
  if (!raw || typeof raw !== 'object') return [];
  const matches = value => [symbol, venueSymbol].some(candidate => commonSymbol(value) === commonSymbol(candidate));
  if (raw.channel === 'push.depth.full' && matches(raw.symbol)) {
    const data = raw.data || {}, scale = rows => (Array.isArray(rows) ? rows : []).map(row => [row[0], Number(row[1]) * multiplier]);
    return [{ type: 'book', venue: 'mexc', symbol, book: { bids: scale(data.bids), asks: scale(data.asks), receivedAt, venueAt: validateTime(raw.ts, receivedAt) } }];
  }
  if (raw.channel === 'push.tickers') {
    const rows = Array.isArray(raw.data) ? raw.data : raw.data ? [raw.data] : [];
    return rows.filter(row => matches(row.symbol)).flatMap(row => {
      const bid = Number(row.bid1), ask = Number(row.ask1), price = Number(row.lastPrice);
      if (bid > 0 && ask > bid) return [{ type: 'quote', venue: 'mexc', symbol, bid, ask, receivedAt, venueAt: validateTime(raw.ts, receivedAt) }];
      return price > 0 ? [{ type: 'quote', venue: 'mexc', symbol, bid: price, ask: price, receivedAt, venueAt: validateTime(raw.ts, receivedAt) }] : [];
    });
  }
  return [];
}

function decodeLbank(raw, symbol, multiplier = 1, receivedAt = Date.now()) {
  if (!raw || typeof raw !== 'object' || ![3, 4].includes(Number(raw.z))) return [];
  const venueAt = validateTime(raw.w, receivedAt);
  if (Number(raw.x) === 3) {
    const scale = rows => (Array.isArray(rows) ? rows : []).map(row => [row[0], Number(row[1]) * multiplier]);
    return [{ type: 'book', venue: 'lbank', symbol, book: { bids: scale(raw.b), asks: scale(raw.s), receivedAt, venueAt } }];
  }
  if (Number(raw.x) === 1) {
    const rows = Array.isArray(raw.d) ? raw.d : raw.d && typeof raw.d === 'object' ? [raw.d] : [];
    return rows.filter(row => commonSymbol(row.a) === symbol && Number(row.i) > 0).map(row => ({
      type: 'quote', venue: 'lbank', symbol, bid: Number(row.i), ask: Number(row.i), receivedAt, venueAt,
    }));
  }
  return [];
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Hedge-LBank-Impulse/1' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new Error('Слишком большой ответ каталога рынков');
  return JSON.parse(text);
}

async function resolveReference(symbol, fetcher = fetchJson) {
  symbol = commonSymbol(symbol);
  const [binance, mexc] = await Promise.allSettled([
    fetcher('https://fapi.binance.com/fapi/v1/exchangeInfo'),
    fetcher('https://contract.mexc.com/api/v1/contract/detail'),
  ]);
  const binanceRow = binance.status === 'fulfilled' ? (binance.value?.symbols || []).find(row => commonSymbol(row.symbol) === symbol && row.status === 'TRADING') : null;
  const mexcRows = mexc.status === 'fulfilled' ? (Array.isArray(mexc.value?.data) ? mexc.value.data : []) : [];
  const mexcRow = mexcRows.find(row => {
    const displaySymbol = commonSymbol(`${row.baseCoinName || row.baseCoin || ''}${row.quoteCoin || row.settleCoin || ''}`);
    return (commonSymbol(row.symbol) === symbol || displaySymbol === symbol) && row.state !== 2 && row.state !== '2';
  });
  if (!binanceRow && !mexcRow) throw new Error(`${symbol}: контракт отсутствует на Binance Futures и MEXC Futures`);
  return {
    leader: binanceRow ? 'binance' : 'mexc',
    hasBinance: Boolean(binanceRow), hasMexc: Boolean(mexcRow),
    mexcSymbol: mexcRow?.symbol || symbol.replace(/USDT$/, '_USDT'),
    mexcMultiplier: Number(mexcRow?.contractSize) > 0 ? Number(mexcRow.contractSize) : 1,
  };
}

class ManagedSocket {
  constructor({ name, url, subscribe, heartbeat, decode, onEvents, onStatus, WebSocketClass = SocketImpl }) {
    Object.assign(this, { name, url, subscribe, heartbeat, decode, onEvents, onStatus, WebSocketClass });
    this.closed = false; this.generation = 0; this.socket = null; this.reconnect = null; this.heartbeatTimer = null; this.lastMessageAt = 0;
  }
  start() { this.closed = false; this.connect(); }
  connect() {
    if (this.closed) return;
    const generation = ++this.generation; this.onStatus(this.name, { state: 'connecting', at: Date.now() });
    let socket;
    try { socket = this.socket = new this.WebSocketClass(this.url); }
    catch (error) { return this.scheduleReconnect(error); }
    socket.addEventListener('open', () => {
      if (generation !== this.generation || this.closed) return;
      this.lastMessageAt = Date.now(); this.onStatus(this.name, { state: 'connected', at: this.lastMessageAt });
      try { for (const payload of this.subscribe()) socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); }
      catch (error) { this.onStatus(this.name, { state: 'error', message: error.message, at: Date.now() }); socket.close(); return; }
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (generation !== this.generation || this.closed) return;
        if (Date.now() - this.lastMessageAt > 30_000) return socket.close();
        if (this.heartbeat && socket.readyState === 1) try { socket.send(this.heartbeat); } catch { socket.close(); }
      }, 10_000);
      this.heartbeatTimer.unref?.();
    });
    socket.addEventListener('message', async event => {
      if (generation !== this.generation || this.closed) return;
      this.lastMessageAt = Date.now();
      const text = await textOf(event.data); if (generation !== this.generation || this.closed || text === 'pong' || text === 'ping') return;
      try { const events = this.decode(JSON.parse(text), this.lastMessageAt); if (events.length) this.onEvents(events); }
      catch (error) { this.onStatus(this.name, { state: 'frame_error', message: error.message, at: Date.now() }); }
    });
    socket.addEventListener('error', () => { if (generation === this.generation && !this.closed) this.onStatus(this.name, { state: 'error', at: Date.now() }); });
    socket.addEventListener('close', () => {
      if (generation !== this.generation) return;
      clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; this.socket = null;
      if (!this.closed) this.scheduleReconnect();
    });
  }
  scheduleReconnect(error) {
    if (this.closed) return;
    this.onStatus(this.name, { state: 'reconnecting', message: error?.message, at: Date.now() });
    clearTimeout(this.reconnect); this.reconnect = setTimeout(() => this.connect(), 1500); this.reconnect.unref?.();
  }
  stop() {
    this.closed = true; this.generation++; clearTimeout(this.reconnect); clearInterval(this.heartbeatTimer);
    this.reconnect = null; this.heartbeatTimer = null; try { this.socket?.close(); } catch {} this.socket = null;
    this.onStatus(this.name, { state: 'stopped', at: Date.now() });
  }
}

class PublicMarketHub extends EventEmitter {
  constructor({ symbol, tickSize, lbankMultiplier = 1, reference, WebSocketClass = SocketImpl }) {
    super(); this.symbol = commonSymbol(symbol); this.tickSize = tickSize; this.lbankMultiplier = lbankMultiplier; this.reference = reference;
    this.WebSocketClass = WebSocketClass; this.sockets = []; this.books = new Map(); this.quotes = new Map(); this.status = new Map();
  }
  start() {
    this.stop(); const onEvents = events => events.forEach(event => this.accept(event)); const onStatus = (venue, value) => { this.status.set(venue, value); this.emit('status', { venue, ...value }); };
    const add = options => { const socket = new ManagedSocket({ ...options, onEvents, onStatus, WebSocketClass: this.WebSocketClass }); this.sockets.push(socket); socket.start(); };
    const idBase = String(Date.now()).slice(-9);
    add({ name: 'lbank', url: 'wss://uuws.rerrkvifj.com/ws/v3', heartbeat: 'ping',
      subscribe: () => [
        { x: 3, y: `3${idBase}`, z: 1, a: { i: `${this.symbol}_${decimalString(this.tickSize)}_25` }, e: '{"bvc":"202","isUsd":1}' },
        { x: 1, y: `1${idBase}`, z: 1, a: { i: this.symbol }, e: '{"bvc":"202","isUsd":1}' },
      ], decode: (message, at) => decodeLbank(message, this.symbol, this.lbankMultiplier, at) });
    if (this.reference.hasBinance) add({ name: 'binance', url: `wss://fstream.binance.com/stream?streams=${this.symbol.toLowerCase()}@bookTicker/${this.symbol.toLowerCase()}@depth20@100ms`,
      subscribe: () => [], decode: (message, at) => decodeBinance(message, this.symbol, at) });
    if (this.reference.hasMexc) add({ name: 'mexc', url: 'wss://contract.mexc.com/edge', heartbeat: '{"method":"ping"}',
      subscribe: () => [
        { method: 'sub.depth.full', param: { symbol: this.reference.mexcSymbol, limit: 20 }, gzip: false },
        { method: 'sub.tickers', param: {}, gzip: false },
      ], decode: (message, at) => decodeMexc(message, this.symbol, this.reference.mexcMultiplier, at, this.reference.mexcSymbol) });
  }
  accept(event) {
    if (event.type === 'book') {
      const book = normalizeBook(event.book); this.books.set(event.venue, book);
      this.quotes.set(event.venue, { bid: book.bids[0].price, ask: book.asks[0].price, mid: (book.bids[0].price + book.asks[0].price) / 2, receivedAt: book.receivedAt, venueAt: book.venueAt });
      this.emit('book', { ...event, book });
    } else if (event.type === 'quote' && event.bid > 0 && event.ask >= event.bid) {
      this.quotes.set(event.venue, { bid: event.bid, ask: event.ask, mid: (event.bid + event.ask) / 2, receivedAt: event.receivedAt, venueAt: event.venueAt });
      this.emit('quote', event);
    }
    this.emit('market', this.snapshot());
  }
  snapshot() { return { symbol: this.symbol, leader: this.reference.leader, books: Object.fromEntries(this.books), quotes: Object.fromEntries(this.quotes), status: Object.fromEntries(this.status), at: Date.now() }; }
  stop() { this.sockets.splice(0).forEach(socket => socket.stop()); this.books.clear(); this.quotes.clear(); }
}

module.exports = { ManagedSocket, PublicMarketHub, commonSymbol, decimalString, decodeBinance, decodeLbank, decodeMexc, resolveReference };
