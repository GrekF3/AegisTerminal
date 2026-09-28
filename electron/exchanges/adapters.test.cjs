const test = require("node:test");
const assert = require("node:assert/strict");
const { adapters } = require("./index.cjs");
const mexc = require("./mexc.cjs");
const lbank = require("./lbank.cjs");
const binance = require("./binance.cjs");
const bybit = require("./bybit.cjs");
const bitget = require("./bitget.cjs");
const gateio = require("./gateio.cjs");
const okx = require("./okx.cjs");
const sizing = require("./order-sizing.cjs");

test("Binance USDT equity includes isolated and cross PnL, with no invented balance fallback", () => {
  const value = binance.normalizeAccount({ assets: [{ asset: "USDC", marginBalance: "9999", availableBalance: "9999" }, { asset: "USDT", walletBalance: "100", crossUnPnl: "2", unrealizedProfit: "7", marginBalance: "107", availableBalance: "0" }] });
  assert.equal(value.total, 107); assert.equal(value.available, 0);
  assert.throws(() => binance.normalizeAccount({ assets: [] }), /полный USDT-баланс/);
});

test("LBank HMAC signature keeps canonical MD5 protocol", () => {
  assert.equal(lbank.sign({ b: 2, a: 1 }, "secret"), "8ea434f10de91ef60b5fb5c3b40da43afc38cf16bfbcc30f7f4601c7b1e0b45f");
});

test("LBank normalizes a futures limit order without sending it", () => {
  const order = lbank.normalizeOrder({ symbol: "btcusdt", side: "BUY", volume: 0.01, price: 50000, orderPriceType: 0, clientOrderId: "test" });
  assert.deepEqual(order, { clientOrderId: "test", offsetFlag: "0", orderPriceType: "0", origType: "0", price: "50000", side: "BUY", symbol: "BTCUSDT", volume: "0.01" });
});

test("Binance normalizes futures LIMIT and MARKET orders", () => {
  const limit = binance.normalizeOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: 0.01, price: 50000, clientOrderId: "limit" });
  const market = binance.normalizeOrder({ symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: 0.01, clientOrderId: "market" });
  assert.equal(limit.timeInForce, "GTC");
  assert.equal(limit.price, "50000");
  assert.equal(market.price, undefined);
  assert.equal(market.side, "SELL");
});

test("Gate.io uses exact client order text instead of unsafe 18-digit JSON number", () => {
  assert.equal(gateio.orderLookupId({ orderId: 203224940138643900, clientOrderId: "t-hedge-exact-id" }), "t-hedge-exact-id");
  assert.equal(gateio.orderLookupId({ orderId: "203224940138643901" }), "203224940138643901");
  assert.throws(() => gateio.orderLookupId({}), /обязателен/);
});

test("OKX accepts contract sizes allowed by the instrument lot step", () => {
  const order = okx.normalizeOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", contracts: 0.1, price: 60000 });
  assert.equal(order.sz, "0.1");
  assert.throws(() => okx.normalizeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", contracts: 0 }), /положительное/);
  assert.equal(okx.stepPrecision(0.001), 3);
});

test('OKX protection is one reduce-only OCO with market exits on mark-price triggers',()=>{
  const body=okx.protectionBody({symbol:'BTCUSDT',side:'SELL',contracts:4,takeProfitPrice:59000,stopLossPrice:61000,
    clientOrderId:'protect-btc',marginMode:'isolated',positionMode:'long_short_mode'});
  assert.deepEqual({side:body.side,posSide:body.posSide,ordType:body.ordType,sz:body.sz,tpOrdPx:body.tpOrdPx,slOrdPx:body.slOrdPx,
    tpTriggerPxType:body.tpTriggerPxType,slTriggerPxType:body.slTriggerPxType},
  {side:'buy',posSide:'short',ordType:'oco',sz:'4',tpOrdPx:'-1',slOrdPx:'-1',tpTriggerPxType:'mark',slTriggerPxType:'mark'});
  assert.equal(okx.protectionStatus('live'),'ACTIVE');assert.equal(okx.protectionStatus('effective'),'TRIGGERED');
});

test('Bybit protection covers the full position with paired market TP/SL on mark price', async()=>{
  const protection={symbol:'BTCUSDT',side:'SELL',quantity:.002,takeProfitPrice:59000,stopLossPrice:61000,clientOrderId:'protect-btc'};
  const position={symbol:'BTCUSDT',side:'Sell',size:'0.002',positionIdx:2,tpslMode:'Full',takeProfit:'59000',stopLoss:'61000'};
  assert.deepEqual(bybit.protectionBody(protection,position),{
    category:'linear',symbol:'BTCUSDT',tpslMode:'Full',positionIdx:2,takeProfit:'59000',stopLoss:'61000',
    tpTriggerBy:'MarkPrice',slTriggerBy:'MarkPrice',tpOrderType:'Market',slOrderType:'Market',
  });
  const orders=[
    {orderId:'tp-1',symbol:'BTCUSDT',side:'Buy',qty:'0.002',positionIdx:2,tpslMode:'Full',orderStatus:'Untriggered',stopOrderType:'TakeProfit',triggerPrice:'59000',triggerBy:'MarkPrice'},
    {orderId:'sl-1',symbol:'BTCUSDT',side:'Buy',qty:'0.002',positionIdx:2,tpslMode:'Full',orderStatus:'Untriggered',stopOrderType:'StopLoss',triggerPrice:'61000',triggerBy:'MarkPrice'},
  ];
  const verified=bybit.protectionFromRows(protection,[position],orders);
  assert.equal(verified.status,'ACTIVE');assert.equal(verified.quantity,.002);assert.equal(verified.tpOrderId,'tp-1');assert.equal(verified.slOrderId,'sl-1');assert.equal(verified.triggerPriceType,'mark');
  assert.equal(bybit.protectionFromRows(protection,[position],orders.slice(0,1)).status,'PENDING');
  assert.equal(bybit.protectionFromRows(protection,[position],orders.map(row=>({...row,stopOrderType:`Partial${row.stopOrderType}`}))).status,'PENDING');
  assert.throws(()=>bybit.protectionFromRows(protection,[{...position,tpslMode:'Partial'}],orders),error=>error.code==='PROTECTION_CONFLICT');
  await assert.rejects(()=>bybit.placeProtection({},protection),/live-подтверждения/);
  assert.equal(bybit.supportsNativeProtection,true);
});

test("order sizing floors quantities and rounds prices to exchange steps", () => {
  assert.equal(sizing.floorToStep(67.55159253, 0.1), 67.5);
  assert.equal(sizing.floorToStep(0.6000000000001, 0.01), 0.6);
  assert.equal(sizing.roundToStep(0.512345, 0.0001), 0.5123);
});

test("OKX exposes the per-operation reason instead of All operations failed", () => {
  assert.throws(() => okx.validateResponse({ code: "1", msg: "All operations failed", data: [{ sCode: "51000", sMsg: "Parameter posSide error" }] }), error => error.exchangeCode === '51000' && error.code === 'EXCHANGE_REJECTED' && /Parameter posSide error.*51000/.test(error.message));
});

test('exchange validators retain actionable raw codes instead of flattening messages', () => {
  assert.throws(() => okx.validateResponse({ code: '1', data: [{ sCode: '51169', sMsg: 'no position' }] }), error => error.code === 'NO_POSITION' && error.exchangeCode === '51169');
  assert.throws(() => bybit.validateResponse({ retCode: 110034, retMsg: 'There is no net position' }), error => error.code === 'NO_POSITION' && error.exchangeCode === '110034');
  assert.throws(() => bitget.validateResponse({ code: '40010', msg: 'Request timed out' }), error => error.code === 'EXECUTION_UNKNOWN' && error.definitive === false);
  assert.throws(() => mexc.validateResponse({ success: true, code: 0, data: [{ orderId: '1', errorCode: 2041, errorMsg: 'order state cannot be cancelled' }] }), error => error.code === 'ALREADY_FINAL' && error.exchangeCode === '2041');
});

test("OKX normalizes configured leverage before applying it", () => {
  assert.equal(okx.normalizeLeverage(3.8), 3);
  assert.equal(okx.normalizeLeverage(0), 1);
  assert.equal(okx.normalizeLeverage(500), 125);
  assert.equal(okx.normalizeLeverage(undefined), null);
});

test("hedge position modes map opening and closing sides correctly", () => {
  assert.deepEqual(okx.positionFields({ side: "BUY", positionMode: "long_short_mode" }), { posSide: "long" });
  assert.deepEqual(okx.positionFields({ side: "BUY", positionMode: "long_short_mode", reduceOnly: true }), { posSide: "short" });
  assert.deepEqual(binance.positionFields({ side: "SELL", positionMode: "hedge" }), { positionSide: "SHORT" });
  assert.deepEqual(bybit.positionFields({ side: "BUY", positionMode: "hedge", reduceOnly: true }), { positionIdx: 2 });
  assert.deepEqual(bitget.positionFields({ side: "SELL", positionMode: "hedge", reduceOnly: true }), { tradeSide: "close", side: "buy" });
});

test("all configured exchanges expose futures account and market adapters", () => {
  assert.deepEqual(Object.keys(adapters).sort(), ["binance", "bitget", "bybit", "gateio", "lbank", "mexc", "okx"]);
  for (const [id, adapter] of Object.entries(adapters)) {
    assert.equal(typeof adapter.getAccount, "function", `${id} getAccount`);
    assert.equal(typeof adapter.getMarkets, "function", `${id} getMarkets`);
    assert.equal(typeof adapter.getFeeRates, "function", `${id} getFeeRates`);
    assert.equal(typeof adapter.getDepth, "function", `${id} getDepth`);
    assert.equal(typeof adapter.placeOrder, "function", `${id} placeOrder`);
  }
});

test("MEXC official signature matches local Mexc_flipper_3000 implementation", () => {
  const body = JSON.stringify({ symbol: "BTC_USDT", vol: 1 });
  assert.equal(mexc.sign("access", "1700000000000", body, "secret"), "4b31412315abc59005e777a20b22eeda8aca0d5fc061b71f95bdf0c083bfba0a");
});

test("MEXC custom SDK web signature and chash match local implementation", () => {
  const body = JSON.stringify({ symbol: "BTC_USDT", vol: 1 });
  assert.equal(mexc.signWeb("WEBabcdef", "1700000000000", body), "28dd7dca4f06cc4ad990081d3d32b11a");
  assert.equal(mexc.generateChash({ vol: 1, symbol: "BTC_USDT", type: 5 }), "f9f18805820ddc1ff7efbb780bfe9b97");
});

test("MEXC supports official and custom SDK credential modes", () => {
  assert.equal(mexc.modeOf({}), "official");
  assert.equal(mexc.modeOf({ connectionMode: "sdk" }), "sdk");
  const official = mexc.normalizeOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: 2, price: 50000 }, { connectionMode: "official" });
  const sdk = mexc.normalizeOrder({ symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: 2 }, { connectionMode: "sdk" });
  assert.equal(official.symbol, "BTC_USDT");
  assert.equal(official.side, 1);
  assert.equal(sdk.side, 3);
  assert.match(sdk.chash, /^[a-f0-9]{32}$/);
  assert.match(sdk.ts, /^\d{13}$/);
});

test("every exchange keeps live placement locked by default", async () => {
  for (const [id, adapter] of Object.entries(adapters)) {
    await assert.rejects(() => adapter.placeOrder({}, { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 1, volume: 1 }), /заблокирован/i, id);
  }
});
