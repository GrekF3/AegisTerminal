function normalizeExchangeIds(exchangeIds) {
  return [...new Set((Array.isArray(exchangeIds) ? exchangeIds : [])
    .map((id) => String(id || "").trim().toLowerCase())
    .filter((id) => /^[a-z0-9_-]+$/.test(id)))];
}

async function testExchangeAccounts(exchangeIds, credentials, getAdapter) {
  const ids = normalizeExchangeIds(exchangeIds);
  if (!ids.length) return {};
  const entries = await Promise.all(ids.map(async (id) => {
    if (id === 'lbank' && require('./lbank-browser.cjs').manualMode(credentials?.[id])) return [id, { ok: false, manual: true, error: 'Undetectable подключается только вручную' }];
    const adapter = getAdapter(id);
    if (!adapter?.getAccount) return [id, { ok: false, error: "Адаптер биржи не подключён" }];
    try {
      const startedAt = Date.now();
      const account = await adapter.getAccount(credentials?.[id] || {});
      return [id, { ok: true, account, latency: Date.now() - startedAt }];
    } catch (error) {
      return [id, { ok: false, error: error instanceof Error ? error.message : String(error) }];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = { normalizeExchangeIds, testExchangeAccounts };
