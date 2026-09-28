function assertOrderDeadline(order, now = Date.now()) {
  if (order?.expiresAt != null && (!Number.isFinite(order.expiresAt) || now >= order.expiresAt)) {
    throw Object.assign(new Error('Цена/время maker-заявки устарели до отправки'), { definitive: true });
  }
}
module.exports = { assertOrderDeadline };
