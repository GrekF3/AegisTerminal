function venue(id, options = {}) {
  const orders = new Map(); const placed = []; const canceled = []; const events = options.events || []; const protections = new Map();
  const adapter = {
    placed, canceled, orders, events, protections, supportsNativeProtection: true,
    getAccount: async () => ({ available: 1000, total: 1000 }),
    getDepth: async () => ({ bids: [{ price: 9.999, quantity: 10000 }], asks: [{ price: 10, quantity: 10000 }] }),
    getDayOpen: async () => ({ time: Math.floor(Date.now() / 86400000) * 86400000, open: options.dayOpen || 9 }),
    getTradingRules: async () => ({ quantityStep: 0.1, minQuantity: 0.1, minNotional: 1, maxLeverage: 100, tickSize: 0.001 }),
    getOpenOrders: async () => [],
    getFeeRates: async () => ({ default: { makerFee: 0, takerFee: 0 } }),
    getPositions: async () => {
      const positions = new Map();
      for (const order of orders.values()) {
        if (order.rejected) continue;
        const key = order.symbol + (order.reduceOnly ? order.side === "BUY" ? "short" : "long" : order.side === "BUY" ? "long" : "short");
        const quantity = (positions.get(key)?.quantity || 0) + (order.reduceOnly ? -1 : 1) * (order.filled || 0);
        positions.set(key, { id: key, exchange: id, symbol: order.symbol, side: key.endsWith("long") ? "long" : "short", quantity, unrealizedPnl: options.pnl || 0 });
      }
      return [...positions.values()].filter((p) => p.quantity > 1e-8);
    },
    configureLeverage: async (_c, order) => { events.push(`${id}:leverage:${order.symbol}:${order.leverage}`); if (options.leverageError) throw new Error(options.leverageError); },
    placeOrder: async (_c, order) => {
      events.push(`${id}:place:${order.symbol}`); placed.push({ ...order });
      if (options.reject && options.reject(order)) throw Object.assign(new Error("source rejected"), { definitive: true });
      orders.set(order.clientOrderId, { ...order, calls: 0 });
      if (options.unknown && options.unknown(order)) throw new Error("network timeout");
      return { orderId: String(placed.length), clientOrderId: order.clientOrderId };
    },
    getOrder: async (_c, reference) => {
      const order = orders.get(reference.clientOrderId);
      if (!order || options.unreadable) throw new Error("order not found");
      order.calls++;
      const status = options.status ? options.status(order, order.calls) : { status: "FILLED", executedQty: order.quantity };
      order.filled = Number(status.executedQty);
      return { avgPrice: 10, ...status };
    },
    cancelOrder: async (_c, order) => { canceled.push(order.clientOrderId); const item = orders.get(order.clientOrderId); if (item) item.canceled = true; },
    placeProtection: async (_c, protection) => {
      const value = { ...protection, orderId: `p-${protections.size + 1}`, status: 'ACTIVE' };
      protections.set(protection.clientOrderId, value); return value;
    },
    getProtection: async (_c, reference) => protections.get(reference.clientOrderId) || { ...reference, status: 'CANCELED' },
    cancelProtection: async (_c, reference) => { const value = protections.get(reference.clientOrderId); if (value) value.status = 'CANCELED'; return value; },
  };
  return adapter;
}
const liveConfig = { source: "a", target: "b", symbol: "BTCUSDT", quantity: 1, price: 10, targetSide: "BUY", dryRun: false, liveConfirmation: "LIVE_TRADING_CONFIRMED" };
module.exports = { venue, liveConfig };
