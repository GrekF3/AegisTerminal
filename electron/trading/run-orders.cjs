function runOrders(run) {
  return [...(run?.targetOrders || [run?.targetOrder]), ...(run?.sourceOrders || []), ...(run?.closeOrders || [])].filter(Boolean);
}
module.exports = { runOrders };
