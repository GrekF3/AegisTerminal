'use strict';

class IdempotentDispatcher {
  constructor(executor, errorView, { limit = 1000 } = {}) {
    if (typeof executor !== 'function' || typeof errorView !== 'function') throw new Error('Dispatcher требует executor и errorView');
    this.executor = executor; this.errorView = errorView; this.limit = limit; this.completed = new Map(); this.inflight = new Map();
  }

  validate(request) {
    if (request?.v !== 1) throw new Error('Неподдерживаемая версия JSONL-протокола');
    const requestId = String(request?.requestId || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new Error('Некорректный requestId');
    if (!/^[a-z][a-zA-Z0-9_]{1,31}$/.test(String(request?.command || ''))) throw new Error('Некорректная команда sidecar');
    return requestId;
  }

  async dispatch(request) {
    let requestId;
    try { requestId = this.validate(request); }
    catch (error) { return { v: 1, type: 'response', requestId: null, ok: false, error: this.errorView(error) }; }
    if (this.completed.has(requestId)) return this.completed.get(requestId);
    if (this.inflight.has(requestId)) return this.inflight.get(requestId);
    const promise = (async () => {
      try { return { v: 1, type: 'response', requestId, ok: true, result: await this.executor(request.command, request.params || {}) }; }
      catch (error) { return { v: 1, type: 'response', requestId, ok: false, error: this.errorView(error) }; }
    })();
    this.inflight.set(requestId, promise);
    try {
      const response = await promise; this.completed.set(requestId, response);
      while (this.completed.size > this.limit) this.completed.delete(this.completed.keys().next().value);
      return response;
    } finally { this.inflight.delete(requestId); }
  }
}

module.exports = { IdempotentDispatcher };
