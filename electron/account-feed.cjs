const { EventEmitter } = require("events");
const FIELDS = ["account", "positions", "orders"];

class AccountFeed extends EventEmitter {
  constructor({ getAdapter, now = Date.now, intervalMs = 1000 }) {
    super(); this.getAdapter = getAdapter; this.now = now; this.intervalMs = intervalMs;
    this.entries = new Map(); this.timer = null;
  }
  configure(ids, credentials) {
    for (const [id, entry] of this.entries) {
      if (!ids.includes(id) || JSON.stringify(entry.credentials) !== JSON.stringify(credentials[id])) this.entries.delete(id);
    }
    for (const id of ids) {
      if (!this.entries.has(id)) this.entries.set(id, { credentials: credentials[id], snapshot: { exchange: id, account: null, positions: [], orders: [], updatedAt: null, status: "syncing", errors: {} }, nextAt: {}, failures: {}, pending: {}, syncing: {} });
    }
    if (!this.timer) { this.timer = setInterval(() => this.refresh(), this.intervalMs); this.timer.unref?.(); }
    this.refresh(); return this.snapshot();
  }
  snapshot() { return { exchanges: Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.snapshot])), receivedAt: this.now() }; }
  async refresh(force = false) {
    await Promise.all([...this.entries].flatMap(([id, entry]) => FIELDS.map((field) => {
      if (entry.pending[field]) return entry.pending[field];
      if (!force && entry.nextAt[field] > this.now()) return;
      entry.pending[field] = this.poll(id, entry, field).finally(() => { entry.pending[field] = null; });
      return entry.pending[field];
    })));
    return this.snapshot();
  }
  async poll(id, entry, field) {
    const adapter = this.getAdapter(id), startedAt = this.now();
    const method = { account: "getAccount", positions: "getPositions", orders: "getOpenOrders" }[field];
    const errors = () => ({ ...entry.snapshot.errors });
    try {
      if (!adapter?.[method]) throw new Error(field === "positions" ? "Получение позиций для этой биржи ещё не поддерживается" : "Получение ордеров для этой биржи ещё не поддерживается");
      const value = await adapter[method](entry.credentials);
      if (field === "account" && (!Number.isFinite(value?.total) || !Number.isFinite(value?.available))) throw new Error("Некорректный баланс биржи");
      if (field !== "account" && !Array.isArray(value)) throw new Error("Некорректный снимок аккаунта");
      if (this.entries.get(id) !== entry) return;
      entry.failures[field] = 0;
      entry.syncing[field] = false;
      // Binance's all-symbol openOrders costs 40 weight: do not poll it at 1 Hz.
      // Account balances and positions keep their independent 1-second cadence.
      entry.nextAt[field] = field === "orders" ? this.now() + (id === "binance" ? 10_000 : id === "lbank" ? 5_000 : 0) : 0;
      const nextErrors = errors(); delete nextErrors[field];
      entry.snapshot = { ...entry.snapshot, [field]: value, [field + "UpdatedAt"]: this.now(), errors: nextErrors, ...(field === "account" ? { latency: this.now() - startedAt } : {}) };
    } catch (error) {
      if (this.entries.get(id) !== entry) return;
      if(error.code==='SNAPSHOT_REFRESH_PENDING') {
        entry.syncing[field]=true;
        entry.nextAt[field]=this.now()+Math.max(250,Number(error.retryAfterMs)||250);
      } else {
      entry.syncing[field]=false;
      entry.failures[field] = (entry.failures[field] || 0) + 1;
      entry.nextAt[field] = this.now() + Math.max(Number(error.retryAfterMs) || 0, Math.min(30_000, 1000 * 2 ** Math.min(entry.failures[field], 5)));
      entry.snapshot = { ...entry.snapshot, errors: { ...errors(), [field]: error.message || String(error) } };
      }
    }
    entry.snapshot = { ...entry.snapshot, updatedAt: this.now(), status: Object.keys(entry.snapshot.errors).length ? "stale" : !Object.values(entry.syncing).some(Boolean) && FIELDS.every((f) => entry.snapshot[f + "UpdatedAt"] != null) ? "live" : "syncing" };
    this.emit("snapshot", this.snapshot());
  }
  dispose() { clearInterval(this.timer); this.timer = null; this.entries.clear(); }
}
module.exports = { AccountFeed };
