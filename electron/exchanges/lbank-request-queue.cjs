// Serialized into the selected page. The limiter is shared across all app
// scopes on that page, and counts actual SDK calls, not high-level operations.
function installLBankRequestQueue(host = self) {
  const key = Symbol.for('hedge.lbank.http-queue.v1');
  if (host[key]) return;
  const queue = [], epochs = new Map();
  let running = false, lastStart = -Infinity;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const wait = Math.max(0, lastStart + 1000 - Date.now());
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        queue.sort((a,b) => b.options.priority - a.options.priority);
        const item = queue.shift(), { options } = item;
        try {
          if (options.epoch !== (epochs.get(options.scope) || 0)) throw Object.assign(new Error('LBank: запрос отменён после остановки бота'), {code:'LOCAL_REQUEST_CANCELED'});
          options.check?.();
          lastStart = Date.now();
          item.resolve(await item.fn());
        } catch (error) { item.reject(error); }
      }
    } finally { running = false; }
  };
  host[key] = {
    epoch: scope => epochs.get(scope) || 0,
    cancel: scope => epochs.set(scope, (epochs.get(scope) || 0) + 1),
    run: (fn, options) => new Promise((resolve,reject) => { queue.push({fn,options,resolve,reject}); void pump(); }),
  };
}
function cancelLBankQueuedRequests(scope) { self[Symbol.for('hedge.lbank.http-queue.v1')]?.cancel(scope); }
module.exports = { installLBankRequestQueue, cancelLBankQueuedRequests };
