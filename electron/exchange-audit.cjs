const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const { adapters, getAdapter } = require("./exchanges/index.cjs");

app.setPath("userData", path.join(app.getPath("appData"), "hedge-lbank"));

function redact(message, credentials) {
  let value = String(message || "unknown error");
  for (const secret of Object.values(credentials || {})) {
    if (typeof secret === "string" && secret.length >= 3) value = value.split(secret).join("<redacted>");
  }
  return value.replace(/(?:https?|socks\w*):\/\/[^\s]+/gi, "<proxy>");
}

app.whenReady().then(async () => {
  try {
    const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(app.getPath("userData"), "credentials.bin"))));
    const results = {};
    for (const id of Object.keys(adapters)) {
      const adapter = getAdapter(id);
      const credentials = stored[id] || {};
      const secretLengths = [credentials.apiKey, credentials.secret, credentials.passphrase, credentials.authorization].filter((value) => typeof value === "string").map((value) => value.length);
      const item = { configured: secretLengths.length >= 2 || (id === "mexc" && Boolean(credentials.authorization)), plausible: secretLengths.every((length) => length >= 8), proxy: credentials.proxyEnabled === true || credentials.proxyEnabled === "true" };
      try {
        const markets = await adapter.getMarkets(credentials);
        item.public = { ok: true, markets: markets.length };
      } catch (error) { item.public = { ok: false, error: redact(error instanceof Error ? error.message : String(error), credentials) }; }
      if (item.configured) {
        try {
          const account = await adapter.getAccount(credentials);
          item.private = { ok: true, finite: Number.isFinite(account.total) && Number.isFinite(account.available) };
        } catch (error) { item.private = { ok: false, error: redact(error instanceof Error ? error.message : String(error), credentials) }; }
      }
      results[id] = item;
    }
    process.stdout.write(JSON.stringify(results, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) }));
  } finally { app.quit(); }
});
