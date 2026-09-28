// Run only with Electron. Read-only diagnostics: never calls leverage, place, cancel or close.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { getAdapter } = require("../electron/exchanges/index.cjs");
let stage = "initialization";
app.setPath("userData", path.join(app.getPath("appData"), "hedge-lbank-dev"));
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Системное шифрование недоступно");
  const directory = app.getPath("userData");
  stage = "settings";
  const settings = JSON.parse(fs.readFileSync(path.join(directory, "settings.ini"), "utf8"));
  stage = "decryption";
  const credentials = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(directory, "credentials.bin"))));
  stage = "account-reads";
  const secretValues = [];
  const collect = (value) => { if (typeof value === "string" && value.length >= 4) secretValues.push(value); else if (value && typeof value === "object") Object.values(value).forEach(collect); };
  collect(credentials);
  const safeError = (error) => secretValues.reduce((value, secret) => value.split(secret).join("[REDACTED]"), String(error.message)).replace(/(signature|sign|api_key|apiKey)=([^&\s]+)/gi, "$1=[REDACTED]");
  const results = await Promise.all([...new Set([settings.source, settings.target])].map(async (id) => {
    try {
      const adapter = getAdapter(id);
      const checked = (label, task) => task.catch((error) => { throw new Error(label + ": " + safeError(error)); });
      const [account, positions, rules] = await Promise.all([checked("balance", adapter.getAccount(credentials[id])), checked("positions", adapter.getPositions(credentials[id])), checked("rules", adapter.getTradingRules("BTCUSDT", credentials[id]))]);
      return { exchange: id, ok: true, totalUSDT: account.total, availableUSDT: account.available, openPositions: positions.length, btcRules: rules };
    } catch (error) { return { exchange: id, ok: false, message: safeError(error) }; }
  }));
  console.log(JSON.stringify({ decryption: "ok", hasSavedLogin: Boolean(credentials.profile?.licenseKey), liveTradingEnabled: settings.liveTradingEnabled, results }));
  app.exit(results.every((r) => r.ok) ? 0 : 1);
}).catch((error) => { console.error(JSON.stringify({ error: "Не удалось проверить локальный зашифрованный профиль", stage, errorType: error.name })); app.exit(1); });
