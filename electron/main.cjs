const { app, BrowserWindow, ipcMain, safeStorage, Menu, Tray, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { getAdapter } = require("./exchanges/index.cjs");
const { normalizeExchangeIds, testExchangeAccounts } = require("./exchanges/connection-pool.cjs");
const { FeeRateCache, prioritizedSymbols, applyStrategyFees } = require("./exchanges/fee-rates.cjs");
const { requestJson } = require("./exchanges/transport.cjs");
const { HedgeSession } = require("./trading/hedge-session.cjs");
const { ContinuousHedgeSession, lossLimit } = require('./trading/continuous-session.cjs');
const { credentialFingerprint, recoverSession } = require("./trading/session-recovery.cjs");
const { buildPlan } = require("./trading/hedge-plan.cjs");
const { AccountFeed } = require("./account-feed.cjs");
const { HistoryStore } = require("./trading/history-store.cjs");
const { readJournal, writeJournal, archiveManualJournal, stopSavedJournal, closeOnlyJournal, sessionHasPendingWork } = require('./trading/local-stop-journal.cjs');
const { autoUpdater } = require("electron-updater");
const { attachUpdateStatus, updateFeed } = require('./update-status.cjs');
const { RollingLogger } = require("./logger.cjs");
const { acquireLiveTradingLock } = require('./trading/live-trading-lock.cjs');

// Development must never share settings, credentials or trading journals with the installed app.
if (!app.isPackaged) {
  const localProfile = path.join(app.getPath("appData"), "hedge-lbank-dev");
  fs.mkdirSync(localProfile, { recursive: true });
  app.setPath("userData", localProfile);
}

let mainWindow;
let tray;
let isQuitting = false;
let profileSession = null;
let tradingSession = null;
let localStoppedSnapshot = null;
let tradingStopRequest = 0;
let coinLogoCache = { expiresAt: 0, values: new Map() };
let coinLogoPromise = null;
const feeRateCache = new FeeRateCache();
let applicationLogger = null;
const sensitiveLogValues = new Set();
const accountFeed = new AccountFeed({ getAdapter });
accountFeed.on("snapshot", (value) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("accounts:snapshot", value); });
let journalFingerprint = null;
let lastTradingLog = "";
let tradingHistory = null;
let tradingHistoryScope = null;
let liveTradingLock = null;

function getTradingHistory() {
  if (!profileSession) throw new Error("Сессия не подтверждена");
  const identity = profileSession.profile.userCode || loadEncryptedCredentials().profile?.licenseKey;
  if (!identity) throw new Error("Не удалось определить владельца истории. Перезайдите в приложение.");
  const scope = crypto.createHash("sha256").update(`${profileSession.serverUrl}:${identity}`).digest("hex");
  if (scope !== tradingHistoryScope) {
    tradingHistory = new HistoryStore(path.join(app.getPath("userData"), "trade-history", scope), { sensitiveValues: () => [...sensitiveLogValues] });
    tradingHistoryScope = scope;
  }
  return tradingHistory;
}

function journalPath() { return path.join(app.getPath("userData"), "hedge-session.json"); }
function releaseLiveTradingLock() {
  // The typeof guard also keeps the isolated Stop-handler fixture read-only.
  if (typeof liveTradingLock === 'undefined' || !liveTradingLock) return;
  try { liveTradingLock.release(); }
  catch (error) { logEvent('warning', 'live_trading_lock_release_failed', { error }); }
  liveTradingLock = null;
}
function bindTradingSession(session) {
  session.on('state', value => {
    if (tradingSession === session) {
      publishTradingState(value);
      if (value?.active === false && !sessionHasPendingWork(session)) releaseLiveTradingLock();
    }
  });
  session.on('round', value => {
    if (tradingSession === session && !session.manualStop && !session.state.manualManagement) getTradingHistory().record(value);
  });
}
function restoreTradingSession() {
  if (tradingSession || !profileSession) return;
  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalPath(), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw new Error("Журнал хеджа повреждён. Проверьте позиции перед новым запуском."); return; }
  const value = journal.snapshot;
  if ((value?.manualManagement || value?.botStopped) && !value.active) {
    if (value.closeStatus === 'closed' && !value.lossLimitReached) return clearClosedTradingSession(value, journal);
    // A close error has already been shown in the previous app process. Keep the
    // unresolved safety lock, but do not replay the same stale red error after
    // every restart. Retry performs a fresh account snapshot below.
    const restored = ['failed', 'waiting_confirmation'].includes(value.closeStatus)
      ? { ...value, closeStatus: 'waiting_confirmation', closeError: undefined, error: undefined, notice: undefined }
      : value;
    if (restored !== value) writeJournal(journalPath(), { ...journal, snapshot: restored });
    localStoppedSnapshot = restored; journalFingerprint = journal.fingerprint;
    return;
  }
  if (!value?.active && !value?.requiresAttention) return;
  const credentials = loadEncryptedCredentials();
  tradingSession = recoverSession(journal, credentials, getAdapter);
  journalFingerprint = journal.fingerprint;
  localStoppedSnapshot = null;
  bindTradingSession(tradingSession);
}

async function stopTradingLocally(mode) {
  // Fence app requests waiting in the page's HTTP queue. This is local CDP,
  // never an exchange cancellation. The state is stopped synchronously first;
  // market cleanup waits for the fence so its fresh reads use the new epoch.
  let queueFence = Promise.resolve();
  try { queueFence = Promise.resolve(require('./exchanges/lbank-browser.cjs').browser.cancelQueuedRequests()).catch(error => logEvent('warning','local_queue_fence_failed',{error})); }
  catch(error) { logEvent('warning','local_queue_fence_failed',{error}); }
  let stopped;
  if (tradingSession) stopped = await tradingSession.stop(mode);
  else {
    const journal = stopSavedJournal(journalPath(), mode);
    journalFingerprint = journal.fingerprint;
    localStoppedSnapshot = journal.snapshot;
    publishTradingState(localStoppedSnapshot, journal);
    stopped = localStoppedSnapshot;
  }
  if (mode === 'pause') await queueFence;
  return stopped;
}

function clearClosedTradingSession(snapshot = tradingSession?.state || localStoppedSnapshot, journal = readJournal(journalPath())) {
  if (snapshot?.lossLimitReached) return snapshot;
  if (snapshot?.id && snapshot.closeStatus === 'closed') {
    archiveManualJournal(journalPath(), { ...(journal || {}), fingerprint: journalFingerprint ?? journal?.fingerprint, snapshot });
  }
  // Detach first so a late callback from the old engine cannot overwrite idle.
  tradingSession = null;
  localStoppedSnapshot = null;
  journalFingerprint = null;
  const idle = { state: 'idle', active: false };
  writeJournal(journalPath(), { fingerprint: null, snapshot: idle });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('trading:state', idle);
  logEvent('info', 'trading_session_reset', { previousSessionId: snapshot?.id, closeStatus: snapshot?.closeStatus });
  releaseLiveTradingLock();
  return idle;
}

function stoppedSessionSymbols(snapshot) {
  return [...new Set([...(Array.isArray(snapshot?.symbols) ? snapshot.symbols : []), ...(snapshot?.runs || []).map(run => run?.symbol)]
    .map(symbol => String(symbol || '').toUpperCase().replace(/[-_]/g, '')).filter(Boolean))];
}

async function stoppedSessionIsFlat() {
  const snapshot = tradingSession?.state || localStoppedSnapshot;
  const symbols = new Set(stoppedSessionSymbols(snapshot));
  if (!snapshot || !symbols.size || !snapshot.source || !snapshot.target) return false;
  let credentials, sourceAdapter, targetAdapter;
  if (tradingSession) {
    if (!tradingSession.config?.sourceCredentials || !tradingSession.config?.targetCredentials) return false;
    credentials = { [snapshot.source]: tradingSession.config.sourceCredentials, [snapshot.target]: tradingSession.config.targetCredentials };
    sourceAdapter = tradingSession.sourceAdapter;
    targetAdapter = tradingSession.targetAdapter;
  } else {
    const journal = readJournal(journalPath());
    credentials = loadEncryptedCredentials();
    if (journal?.fingerprint !== credentialFingerprint(credentials, snapshot.source, snapshot.target)) {
      throw new Error('Для сверки нужны исходные подключения этого хеджа.');
    }
    sourceAdapter = getAdapter(snapshot.source);
    targetAdapter = getAdapter(snapshot.target);
  }
  const venues = [
    { id: snapshot.source, adapter: sourceAdapter, credentials: credentials[snapshot.source] },
    { id: snapshot.target, adapter: targetAdapter, credentials: credentials[snapshot.target] },
  ];
  if (venues.some(({ adapter }) => !adapter || typeof adapter.getPositions !== 'function' || typeof adapter.getOpenOrders !== 'function')) return false;
  const snapshots = await Promise.all(venues.map(async venue => {
    const [positions, orders] = await Promise.all([
      venue.adapter.getPositions(venue.credentials),
      venue.adapter.getOpenOrders(venue.credentials),
    ]);
    if (!Array.isArray(positions) || !Array.isArray(orders)) throw new Error(`${venue.id}: биржа не вернула полный снимок позиций и заявок`);
    const hasPosition = positions.some(position => symbols.has(String(position?.symbol || '').toUpperCase().replace(/[-_]/g, ''))
      && position?.isOwn !== false && Number(position?.quantity) > 1e-12);
    const terminal = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    const hasOrder = orders.some(order => symbols.has(String(order?.symbol || '').toUpperCase().replace(/[-_]/g, ''))
      && !terminal.has(String(order?.status || '').toUpperCase()));
    return { id: venue.id, hasPosition, hasOrder };
  }));
  logEvent('info', 'stopped_session_flat_check', { sessionId: snapshot.id, symbols: [...symbols], venues: snapshots });
  return snapshots.every(value => !value.hasPosition && !value.hasOrder);
}

function reportTradingClose(patch) {
  const previous = tradingSession?.state || localStoppedSnapshot || {};
  const snapshot = { ...previous, ...patch, state: 'stopped', active: false, botStopped: true, stopMode: 'market', error: undefined,
    requiresAttention: patch.closeStatus !== 'closed' || Boolean(previous.lossLimitReached) };
  if (tradingSession) tradingSession.state = snapshot;
  else localStoppedSnapshot = snapshot;
  publishTradingState(snapshot);
  return snapshot;
}

function prepareExplicitClose() {
  const snapshot = tradingSession?.state || localStoppedSnapshot;
  if (tradingSession && !tradingSession.manualStop && !snapshot?.manualStop && !snapshot?.manualManagement) return tradingSession;
  if (sessionHasPendingWork(tradingSession)) return null;
  const journal = { ...(readJournal(journalPath()) || {}), fingerprint: journalFingerprint, snapshot };
  archiveManualJournal(journalPath(), journal, { beforeClose: true });
  const credentials = loadEncryptedCredentials();
  if (journal.fingerprint !== credentialFingerprint(credentials, snapshot?.source, snapshot?.target)) throw new Error('Для закрытия нужны исходные подключения этого хеджа. Бот уже остановлен.');
  const recovered = recoverSession(closeOnlyJournal(journal), credentials, getAdapter);
  if (!recovered) throw new Error('Не удалось восстановить заявки для закрытия. Бот уже остановлен.');
  tradingSession = recovered;
  localStoppedSnapshot = null;
  bindTradingSession(recovered);
  return recovered;
}

function getLogger() {
  if (!applicationLogger) applicationLogger = new RollingLogger(path.join(app.getPath("userData"), "hedge.log"));
  return applicationLogger;
}

function rememberSensitiveValues(value) {
  const visit = (item) => {
    if (typeof item === "string" && item.length >= 4) sensitiveLogValues.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  getLogger().setSensitiveValues([...sensitiveLogValues]);
}

function logEvent(level, event, details = {}) { getLogger().write(level, event, details); }

function underlyingCoinSymbol(symbol) {
  return String(symbol || "").toUpperCase().replace(/USDT$/, "").replace(/^(?:1000000|1000)/, "");
}

async function getCoinLogoMap() {
  if (coinLogoCache.expiresAt > Date.now()) return coinLogoCache.values;
  if (coinLogoPromise) return coinLogoPromise;
  coinLogoPromise = (async () => {
    try {
      const pages = await Promise.all([1, 2].map((page) => requestJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`, { headers: { accept: "application/json", "user-agent": `Hedge-LBank/${app.getVersion()}` }, exchangeName: "Coin logos" })));
      const values = new Map();
      pages.flat().forEach((coin) => { const symbol = String(coin?.symbol || "").toUpperCase(); if (symbol && coin?.image && !values.has(symbol)) values.set(symbol, String(coin.image)); });
      coinLogoCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, values };
      return values;
    } catch {
      return coinLogoCache.values;
    } finally { coinLogoPromise = null; }
  })();
  return coinLogoPromise;
}

async function appAdminRequest(pathname, options = {}) {
  if (!profileSession?.profile?.isAdmin || !profileSession.adminToken) throw new Error("Требуется админская сессия");
  const endpoint = new URL(pathname.replace(/^\//, ""), `${profileSession.serverUrl}/`).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${profileSession.adminToken}`,
        "content-type": "application/json",
        "user-agent": `Hedge-LBank/${app.getVersion()}`,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || `Backend HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Сервер не ответил за 12 секунд");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: app.isPackaged ? "Hedge LBank" : "Hedge LBank · Local",
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#090a0b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.NODE_ENV !== "production" && !app.isPackaged ? "http://127.0.0.1:3000" : null;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, "..", "out", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("page-title-updated", (event) => { if (!app.isPackaged) event.preventDefault(); });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === "win32") mainWindow.setSkipTaskbar(true);
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (process.platform === "win32") mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const packagedIcon = path.join(__dirname, "..", "out", "app-icon.png");
  const developmentIcon = path.join(__dirname, "..", "public", "app-icon.png");
  let icon = nativeImage.createFromPath(fs.existsSync(packagedIcon) ? packagedIcon : developmentIcon);
  if (process.platform === "win32") icon = icon.resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip(app.isPackaged ? "Hedge LBank" : "Hedge LBank · Local");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: app.isPackaged ? "Открыть Hedge LBank" : "Открыть Hedge LBank · Local", click: showMainWindow },
    { type: "separator" },
    { label: "Закрыть приложение", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", showMainWindow);
}

function settingsPath() { return path.join(app.getPath("userData"), "settings.ini"); }
function credentialsPath() { return path.join(app.getPath("userData"), "credentials.bin"); }
function deviceIdPath() { return path.join(app.getPath("userData"), "device.id"); }

function getDeviceId() {
  try {
    const existing = fs.readFileSync(deviceIdPath(), "utf8").trim();
    if (existing) return existing;
  } catch { }
  const value = crypto.randomUUID();
  fs.mkdirSync(path.dirname(deviceIdPath()), { recursive: true });
  fs.writeFileSync(deviceIdPath(), value, { encoding: "utf8", mode: 0o600 });
  return value;
}

function loadEncryptedCredentials() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Системное шифрование недоступно");
  try {
    const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(credentialsPath())));
    rememberSensitiveValues(value);
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("Не удалось прочитать сохранённые ключи");
  }
}

ipcMain.handle("window:action", (_event, action) => {
  if (!mainWindow) return;
  if (action === "minimize") mainWindow.minimize();
  if (action === "maximize") mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === "close") mainWindow.close();
});

ipcMain.handle("settings:load", () => {
  try { return JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { return null; }
});

ipcMain.handle("settings:save", (_event, value) => {
  if (value?.marginMode !== undefined) require('./trading/margin-mode.cjs').marginMode(value.marginMode);
  if (value?.maxLosses !== undefined) lossLimit(value.maxLosses);
  restoreTradingSession();
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { }
  if (tradingSession?.state?.active && (value.source !== undefined && value.source !== tradingSession.state.source || value.target !== undefined && value.target !== tradingSession.state.target)) throw new Error("Нельзя менять пару во время хеджа");
  const temporary = `${settingsPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...previous, ...value }, null, 2), "utf8");
  fs.renameSync(temporary, settingsPath());
  return true;
});

ipcMain.handle("credentials:load", () => {
  try { return loadEncryptedCredentials(); } catch { return null; }
});

ipcMain.handle("credentials:save", (_event, value) => {
  restoreTradingSession();
  if (tradingSession?.state?.active && credentialFingerprint(value, tradingSession.state.source, tradingSession.state.target) !== journalFingerprint) throw new Error("Нельзя менять ключи активного хеджа");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Системное шифрование недоступно");
  const lbankChanged = JSON.stringify(loadEncryptedCredentials().lbank) !== JSON.stringify(value?.lbank);
  fs.mkdirSync(path.dirname(credentialsPath()), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(value));
  fs.writeFileSync(credentialsPath(), encrypted);
  if (lbankChanged) require('./exchanges/lbank-browser.cjs').browser.disconnect();
  rememberSensitiveValues(value);
  logEvent("info", "credentials_saved", { exchanges: Object.keys(value || {}) });
  feeRateCache.clear();
  return true;
});

ipcMain.handle("market:exchange", async (_event, exchangeId) => {
  const adapter = getAdapter(exchangeId);
  if (!adapter?.getMarkets) throw new Error("Биржа не поддерживает загрузку рынков");
  const credentials = loadEncryptedCredentials();
  return adapter.getMarkets(credentials[exchangeId] || {});
});
ipcMain.handle("market:exchange-depth", async (_event, exchangeId, symbol) => {
  const adapter = getAdapter(exchangeId);
  if (!adapter?.getDepth) throw new Error("Биржа не поддерживает стакан");
  const credentials = loadEncryptedCredentials();
  return adapter.getDepth(String(symbol || "BTCUSDT"), 25, credentials[exchangeId] || {});
});
ipcMain.handle("market:common", async (_event, sourceId, targetId) => {
  const sourceAdapter = getAdapter(sourceId);
  const targetAdapter = getAdapter(targetId);
  if (!sourceAdapter?.getMarkets || !targetAdapter?.getMarkets) throw new Error("Для пары недоступен список futures-рынков");
  const credentials = loadEncryptedCredentials();
  const [sourceMarkets, targetMarkets, coinLogos] = await Promise.all([
    sourceAdapter.getMarkets(credentials[sourceId] || {}),
    targetAdapter.getMarkets(credentials[targetId] || {}),
    getCoinLogoMap(),
  ]);
  const targets = new Map(targetMarkets.map((item) => [item.symbol, item]));
  const commonMarkets = sourceMarkets.filter((item) => targets.has(item.symbol)).map((source) => {
    const target = targets.get(source.symbol);
    return {
      symbol: source.symbol,
      lastPrice: source.lastPrice,
      source,
      target,
      combinedTurnover: Number(source.turnover24h || 0) + Number(target.turnover24h || 0),
      logoUrl: coinLogos.get(underlyingCoinSymbol(source.symbol)) || null,
    };
  });
  const symbols = prioritizedSymbols(commonMarkets);
  const [sourceResult, targetResult] = await Promise.allSettled([
    feeRateCache.get(sourceId, sourceAdapter, credentials[sourceId] || {}, symbols, sourceMarkets),
    feeRateCache.get(targetId, targetAdapter, credentials[targetId] || {}, symbols, targetMarkets),
  ]);
  const sourceRates = sourceResult.status === "fulfilled" ? sourceResult.value : {};
  const targetRates = targetResult.status === "fulfilled" ? targetResult.value : {};
  return applyStrategyFees(commonMarkets, sourceRates, targetRates).sort((a, b) => {
    const aKnown = Number.isFinite(a.makerFee) && Number.isFinite(a.takerFee);
    const bKnown = Number.isFinite(b.makerFee) && Number.isFinite(b.takerFee);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown) {
      const feeDifference = (a.makerFee + a.takerFee) - (b.makerFee + b.takerFee);
      if (feeDifference) return feeDifference;
    }
    return b.combinedTurnover - a.combinedTurnover;
  });
});
ipcMain.handle("exchange:test", async (_event, exchangeId) => {
  try {
    if (!profileSession) throw new Error('Сессия не подтверждена');
    const credentials = loadEncryptedCredentials();
    const adapter = getAdapter(exchangeId);
    if (!adapter) return { ok: false, error: "Адаптер биржи ещё не подключён к backend" };
    const { browser, manualMode } = require('./exchanges/lbank-browser.cjs');
    if (exchangeId === 'lbank' && manualMode(credentials.lbank) && tradingSession?.state?.active) throw new Error('Нельзя переподключать профиль во время хеджа');
    const account = exchangeId === 'lbank' && manualMode(credentials.lbank)
      ? await browser.connect(credentials.lbank) : await adapter.getAccount(credentials[exchangeId] || {});
    logEvent("info", "exchange_connected", { exchangeId, latency: Date.now() - Number(account.rawUpdatedAt || Date.now()) });
    return { ok: true, account };
  } catch (error) {
    logEvent("error", "exchange_connection_failed", { exchangeId, error });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('undetectable:profiles', async () => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  const profiles = await require('./exchanges/undetectable.cjs').listProfiles();
  return profiles.map(({ id, name, status }) => ({ id, name, status }));
});
ipcMain.handle('exchange:disconnect', (_event, id) => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  if (tradingSession?.state?.active && [tradingSession.state.source, tradingSession.state.target].includes(id)) throw new Error('Сначала остановите активный хедж');
  if (id === 'lbank') require('./exchanges/lbank-browser.cjs').browser.disconnect();
  return true;
});
function lbankRecorderDirectory() { return path.join(app.getPath('userData'), 'diagnostics', 'lbank'); }
ipcMain.handle('lbank:recorder-status', () => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  return require('./exchanges/lbank-browser.cjs').browser.recorderStatus();
});
ipcMain.handle('lbank:recorder-start', async () => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  if (tradingSession?.state?.active) throw new Error('Перед диагностической записью остановите автоматический хедж');
  const credentials = loadEncryptedCredentials();
  const { browser, manualMode } = require('./exchanges/lbank-browser.cjs');
  if (!manualMode(credentials.lbank) || !browser.isConnected(credentials.lbank)) throw new Error('Сначала подключите LBank через Undetectable в приложении');
  const status = await browser.startRecorder(lbankRecorderDirectory());
  logEvent('info', 'lbank_recorder_started', { captureId: status.captureId });
  return status;
});
ipcMain.handle('lbank:recorder-mark', async (_event, marker) => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  return require('./exchanges/lbank-browser.cjs').browser.markRecorder(String(marker || ''));
});
ipcMain.handle('lbank:recorder-stop', async () => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  const status = await require('./exchanges/lbank-browser.cjs').browser.stopRecorder('user');
  logEvent('info', 'lbank_recorder_stopped', { captureId: status.captureId, eventCount: status.eventCount });
  return status;
});
ipcMain.handle('lbank:recorder-show', () => {
  if (!profileSession) throw new Error('Сессия не подтверждена');
  const status = require('./exchanges/lbank-browser.cjs').browser.recorderStatus();
  const root = path.resolve(lbankRecorderDirectory());
  const file = status.filePath && path.resolve(status.filePath);
  if (!file || (file !== root && !file.startsWith(`${root}${path.sep}`))) throw new Error('Запись LBank ещё не создана');
  shell.showItemInFolder(file);
  return true;
});
ipcMain.handle("exchange:test-many", async (_event, exchangeIds) => {
  let credentials;
  try { credentials = loadEncryptedCredentials(); } catch (error) {
    const ids = normalizeExchangeIds(exchangeIds);
    return Object.fromEntries(ids.map((id) => [id, { ok: false, error: error instanceof Error ? error.message : String(error) }]));
  }
  const result = await testExchangeAccounts(exchangeIds, credentials, getAdapter);
  logEvent("info", "exchange_pool_checked", { exchanges: Object.fromEntries(Object.entries(result).map(([id, state]) => [id, { ok: state.ok, latency: state.latency, error: state.error }])) });
  return result;
});

function publishTradingState(value, envelope = {}) {
  const key = `${value.state}:${value.currentSymbol || ""}:${value.error || value.closeError || ""}:${value.closeStatus || ''}:${value.notice?.level || ""}`;
  if (key !== lastTradingLog) { logEvent(value?.error || value?.closeError ? "error" : value.notice?.level==='warning'?'warning':"info", "trading_state", { state: value.state, symbol: value.currentSymbol, botStopped: value.botStopped, closeStatus: value.closeStatus, closeError: value.closeError, error: value.error, notice: value.notice }); lastTradingLog = key; }
  const temporary = `${journalPath()}.tmp`;
  const journal = { ...envelope, fingerprint: journalFingerprint, snapshot: value };
  fs.writeFileSync(temporary, JSON.stringify(journal), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, journalPath());
  if (value.manualManagement || value.botStopped) archiveManualJournal(journalPath(), journal);
  try {
    // A local stop must not require authentication or decrypt credentials just
    // to resolve a history owner; its complete journal is archived regardless.
    const history = !profileSession ? null : (value.manualManagement || value.botStopped) && !profileSession.profile?.userCode ? tradingHistory : getTradingHistory();
    if (value.strategy === 'continuous-intraday') {
      for (const run of value.runs || []) if (!run.roundRecorded && (value.manualManagement || value.botStopped || !['stopped', 'error'].includes(run.state))) history?.record({ ...value, id: run.id, sessionId: value.id, symbols: [run.symbol], totalMargin: run.margin, startedAt: run.startedAt, state: run.state, active: run.active, runs: [run] });
    } else history?.record(value);
  }
  catch (error) { logEvent("error", "trade_history_write_failed", { error }); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("trading:state", value);
}

ipcMain.handle("trading:history", (_event, options) => {
  if (!profileSession) throw new Error("Сессия не подтверждена");
  return getTradingHistory().list(options);
});

ipcMain.handle("accounts:configure", (_event, ids) => {
  if (!profileSession) throw new Error("Сессия не подтверждена");
  const configured = normalizeExchangeIds(ids);
  if (tradingSession?.state?.active) configured.push(tradingSession.state.source, tradingSession.state.target);
  const credentials = loadEncryptedCredentials();
  const { manualMode, browser } = require('./exchanges/lbank-browser.cjs');
  return accountFeed.configure([...new Set(configured)].filter(id => id !== 'lbank' || !manualMode(credentials.lbank) || browser.isConnected(credentials.lbank)), credentials);
});
ipcMain.handle("accounts:refresh", () => { if (!profileSession) throw new Error("Сессия не подтверждена"); return accountFeed.refresh(true); });
ipcMain.handle("trading:state", () => {
  if (!profileSession) return { state: "idle", active: false };
  restoreTradingSession();
  return tradingSession?.state || localStoppedSnapshot || { state: "idle", active: false };
});
ipcMain.handle("trading:preview", async (_event, options) => {
  try {
    if (!profileSession) throw new Error("Сессия не подтверждена");
    const credentials = loadEncryptedCredentials();
    return { ok: true, plan: await buildPlan({ ...options, sourceCredentials: credentials[options.source], targetCredentials: credentials[options.target] }, getAdapter(options.source), getAdapter(options.target)) };
  } catch (error) {
    logEvent('warning', 'hedge_preview_failed', { source: options?.source, target: options?.target, httpStatus: error.httpStatus, endpoint: error.endpoint, error });
    return { ok: false, error: error.message, httpStatus: error.httpStatus, retryAfterMs: error.retryAfterMs };
  }
});

ipcMain.handle("trading:start", async (_event, options) => {
  if (!profileSession) return { ok: false, error: "Сессия не подтверждена" };
  try {
    if (sessionHasPendingWork(tradingSession)) throw new Error('Бот остановлен; предыдущие запросы ещё завершаются. Новый запуск будет доступен после их завершения.');
    restoreTradingSession();
    const previous = tradingSession?.state || localStoppedSnapshot;
    if (previous?.active || previous?.requiresAttention || ['closing', 'waiting_confirmation', 'failed'].includes(previous?.closeStatus) || (previous?.botStopped && !previous.manualManagement && previous.closeStatus !== 'closed')) throw new Error("Уже есть активный или незавершённый хедж");
    const sourceAdapter = getAdapter(options?.source);
    const targetAdapter = getAdapter(options?.target);
    if (!sourceAdapter || !targetAdapter) throw new Error("Для выбранной пары нет торгового адаптера");
    const storedCredentials = loadEncryptedCredentials();
    const liveRequested = options?.dryRun === false;
    const usesLBank = options?.source === 'lbank' || options?.target === 'lbank';
    if (liveRequested && usesLBank && !liveTradingLock) {
      const lbankProfileId = storedCredentials?.lbank?.undetectableProfileId || 'default';
      liveTradingLock = acquireLiveTradingLock('Hedge LBank desktop', { resource: `lbank:${lbankProfileId}` });
    }
    archiveManualJournal(journalPath());
    journalFingerprint = credentialFingerprint(storedCredentials, options.source, options.target);
    tradingSession = new ContinuousHedgeSession({ sourceAdapter, targetAdapter });
    localStoppedSnapshot = null;
    bindTradingSession(tradingSession);
    const snapshot = tradingSession.start({
      ...options,
      symbols: Array.isArray(options?.symbols) ? options.symbols : [options?.symbol],
      totalNotional: Number(options?.totalNotional ?? options?.notional),
      sourceCredentials: storedCredentials[options?.source] || {},
      targetCredentials: storedCredentials[options?.target] || {},
      dryRun: options?.dryRun !== false,
      liveConfirmation: options?.liveConfirmation,
    });
    return { ok: true, snapshot };
  } catch (error) {
    if (!tradingSession?.state?.active && !sessionHasPendingWork(tradingSession)) releaseLiveTradingLock();
    logEvent("error", "trading_start_failed", { source: options?.source, target: options?.target, symbols: options?.symbols, error });
    return { ok: false, error: error instanceof Error ? error.message : String(error), snapshot: tradingSession?.state };
  }
});

ipcMain.handle('trading:reset-loss-limit', () => {
  if (!profileSession?.profile?.isAdmin) throw new Error('Сброс доступен только администратору');
  restoreTradingSession();
  if (!tradingSession && localStoppedSnapshot?.lossLimitReached) {
    localStoppedSnapshot = { ...localStoppedSnapshot, requiresAttention: false, lossLimitReached: false, error: undefined };
    publishTradingState(localStoppedSnapshot);
    logEvent('info', 'hedge_loss_limit_reset', { sessionId: localStoppedSnapshot.id });
    return localStoppedSnapshot;
  }
  if (!tradingSession?.state?.lossLimitReached || tradingSession.state.active) throw new Error('Сначала завершите все позиции сессии');
  tradingSession.publish({ state: 'stopped', requiresAttention: false, lossLimitReached: false, error: undefined });
  logEvent('info', 'hedge_loss_limit_reset', { sessionId: tradingSession.state.id });
  return tradingSession.state;
});

ipcMain.handle("trading:stop", async (_event, mode) => {
  const request = ++tradingStopRequest;
  try {
    mode ??= 'app-only';
    if (!['pause', 'app-only', 'market'].includes(mode)) throw new Error('Неизвестный способ остановки');
    if (!tradingSession && !localStoppedSnapshot) {
      const saved = readJournal(journalPath())?.snapshot;
      if (!saved || (!saved.active && saved.state === 'idle')) return { ok: true, snapshot: { state: 'idle', active: false } };
    }
    // Stopping automation is always local, including a direct market-close
    // request. Authentication and exchange failures concern cleanup only.
    const stopped = await stopTradingLocally(mode === 'market' ? 'pause' : mode);
    if (stopped.closeStatus === 'closed') return { ok: stopped.active === false, snapshot: clearClosedTradingSession(stopped) };
    if (mode !== 'market') return { ok: stopped.active === false, snapshot: stopped };
    if (request !== tradingStopRequest) return { ok: true, snapshot: tradingSession?.state || localStoppedSnapshot };
    if (!profileSession) throw new Error("Сессия не подтверждена");
    if (sessionHasPendingWork(tradingSession)) return { ok: true, snapshot: reportTradingClose({ closeStatus: 'waiting_confirmation', closeError: 'Бот остановлен. Предыдущие запросы ещё завершаются; повторите закрытие после их завершения.' }) };
    try {
      if (await stoppedSessionIsFlat()) {
        const closed = reportTradingClose({ closeStatus: 'closed', closeError: undefined, notice: undefined });
        return { ok: true, snapshot: clearClosedTradingSession(closed) };
      }
    } catch (error) {
      // An unavailable snapshot is never interpreted as zero. The normal
      // close/reconciliation path below remains authoritative.
      logEvent('warning', 'stopped_session_flat_check_failed', { sessionId: stopped.id, error });
    }
    if (request !== tradingStopRequest) return { ok: true, snapshot: tradingSession?.state || localStoppedSnapshot };
    const closing = prepareExplicitClose();
    if (!closing) return { ok: true, snapshot: reportTradingClose({ closeStatus: 'waiting_confirmation', closeError: 'Бот остановлен. Предыдущие запросы ещё завершаются; повторите закрытие после их завершения.' }) };
    const snapshot = await closing.stop('market');
    if (request !== tradingStopRequest) return { ok: true, snapshot: tradingSession?.state || localStoppedSnapshot };
    if (snapshot.manualManagement) return { ok: true, snapshot };
    if (!snapshot.closeStatus || snapshot.active) return { ok: true, snapshot: reportTradingClose({ closeStatus: snapshot.error ? 'failed' : 'waiting_confirmation', closeError: snapshot.closeError || snapshot.error || 'Бот остановлен. Подтверждение закрытия ещё не получено.' }) };
    return { ok: true, snapshot: snapshot.closeStatus === 'closed' ? clearClosedTradingSession(snapshot) : snapshot };
  } catch (error) {
    logEvent("error", "trading_stop_failed", { mode, error });
    const snapshot = tradingSession?.state || localStoppedSnapshot;
    if (mode === 'market' && (snapshot?.botStopped || snapshot?.manualManagement)) {
      if (request !== tradingStopRequest) return { ok: true, snapshot };
      return { ok: true, snapshot: reportTradingClose({ closeStatus: error.code === 'ORDER_PENDING_HISTORY' ? 'waiting_confirmation' : 'failed', closeError: error instanceof Error ? error.message : String(error) }) };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), snapshot };
  }
});

ipcMain.handle("profile:verify", async (_event, options) => {
  const serverUrl = String(options?.serverUrl || "").trim().replace(/\/$/, "");
  const licenseKey = String(options?.licenseKey || "").trim();
  rememberSensitiveValues([licenseKey]);
  if (!serverUrl) return { ok: false, error: "Укажите домен API" };
  if (!licenseKey) return { ok: false, error: "Введите ключ доступа" };
  let endpoint;
  try {
    const parsed = new URL(serverUrl);
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
      return { ok: false, error: "Для сервера требуется HTTPS" };
    }
    endpoint = new URL("verify", `${serverUrl}/`).toString();
  } catch {
    return { ok: false, error: "Некорректный домен API" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `Hedge-LBank/${app.getVersion()}` },
      body: JSON.stringify({ api_key: licenseKey, system_fingerprint: getDeviceId() }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload?.detail || `Backend HTTP ${response.status}` };
    if (!payload.valid) {
      profileSession = null;
      return { ok: false, error: payload.reason || "Ключ недействителен", reason: payload.reason };
    }
    rememberSensitiveValues([payload.admin_token, payload.support_token]);
    const profile = { userCode: payload.user_code || null, expiresAt: payload.expires_at || null, isAdmin: payload.is_admin === true };
    profileSession = { profile, verifiedAt: Date.now(), serverUrl, adminToken: payload.admin_token || null, supportToken: payload.support_token || null };
    logEvent("info", "profile_verified", { userCode: profile.userCode, isAdmin: profile.isAdmin, appVersion: app.getVersion() });
    return { ok: true, profile };
  } catch (error) {
    logEvent("error", "profile_verify_failed", { serverUrl, error });
    return { ok: false, error: error?.name === "AbortError" ? "Сервер не ответил за 12 секунд" : (error instanceof Error ? error.message : String(error)) };
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.handle("profile:session", () => {
  if (!profileSession) return { authenticated: false };
  const expiresAt = profileSession.profile.expiresAt ? Date.parse(profileSession.profile.expiresAt) : null;
  if (expiresAt && expiresAt <= Date.now()) {
    profileSession = null;
    return { authenticated: false };
  }
  return { authenticated: true, profile: profileSession.profile };
});

ipcMain.handle("profile:logout", () => {
  if (tradingSession?.state?.active) throw new Error("Сначала завершите активный хедж");
  accountFeed.dispose();
  require('./exchanges/lbank-browser.cjs').browser.disconnect();
  profileSession = null;
  return true;
});

ipcMain.handle("admin:users", async () => {
  try {
    const payload = await appAdminRequest("app-admin/users");
    return { ok: true, users: Array.isArray(payload.users) ? payload.users : [] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), users: [] };
  }
});

ipcMain.handle("admin:user-create", async (_event, value) => {
  try {
    const payload = await appAdminRequest("app-admin/users", {
      method: "POST",
      body: { name: String(value?.name || ""), ttl_days: value?.ttlDays ?? null, note: String(value?.note || "") },
    });
    return { ok: true, user: payload.user };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("admin:user-update", async (_event, keyId, value) => {
  try {
    const payload = await appAdminRequest(`app-admin/users/${Number(keyId)}`, { method: "POST", body: value || {} });
    return { ok: true, user: payload.user };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("logs:send", async () => {
  if (!profileSession?.supportToken || !profileSession?.serverUrl) return { ok: false, error: "Перезайдите в приложение перед отправкой логов" };
  try {
    logEvent("info", "support_log_upload_requested", { appVersion: app.getVersion(), platform: `${process.platform}-${process.arch}` });
    const payload = getLogger().snapshot();
    const form = new FormData();
    form.append("file", new Blob([payload], { type: "text/plain" }), "hedge.log");
    const response = await fetch(new URL("support/logs", `${profileSession.serverUrl}/`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${profileSession.supportToken}`,
        "x-app-version": app.getVersion(),
        "x-app-platform": `${process.platform}-${process.arch}`,
        "user-agent": `Hedge-LBank/${app.getVersion()}`,
      },
      body: form,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok !== true) throw new Error(result?.detail || `Backend HTTP ${response.status}`);
    logEvent("info", "support_log_upload_completed", { bytes: payload.length });
    return { ok: true, bytes: payload.length };
  } catch (error) {
    logEvent("error", "support_log_upload_failed", { error });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("external:telegram", async () => {
  await shell.openExternal("https://github.com/");
  return true;
});

const updateStatus = attachUpdateStatus(autoUpdater, {
  publish: (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status); },
  log: (level, message) => logEvent(level, 'app_update', { message }),
});

ipcMain.handle("update:configure", async (_event, options) => {
  const channel = options?.channel === "beta" ? "beta" : "stable";
  const serverUrl = String(options?.serverUrl || "").replace(/\/$/, "");
  autoUpdater.autoDownload = options?.autoUpdate !== false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Beta and stable are isolated by directory; both publish electron-builder's latest.yml feed.
  autoUpdater.channel = "latest";
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: options?.launchOnStartup === true });
  if (!serverUrl || !app.isPackaged) {
    const status = { state: app.isPackaged ? "not-configured" : "development" };
    updateStatus.publish(status);
    return { ok: true, ...status };
  }
  autoUpdater.setFeedURL(updateFeed(serverUrl, channel));
  await autoUpdater.checkForUpdates();
  return { ok: true, ...updateStatus.getStatus() };
});

ipcMain.handle("update:status", () => updateStatus.getStatus());

ipcMain.handle("update:download", async () => {
  updateStatus.beginDownload();
  await autoUpdater.downloadUpdate();
  return { ok: true };
});

ipcMain.handle("update:install", () => {
  restoreTradingSession();
  if (tradingSession?.state?.active) throw new Error("Обновление отложено до завершения хеджа");
  updateStatus.publish({ ...updateStatus.getStatus(), state: 'restarting' });
  autoUpdater.quitAndInstall(false, true);
  return true;
});

process.on("uncaughtExceptionMonitor", (error) => logEvent("fatal", "uncaught_exception", { error }));
process.on("unhandledRejection", (error) => logEvent("error", "unhandled_rejection", { error }));

app.whenReady().then(() => { logEvent("info", "application_started", { version: app.getVersion(), platform: `${process.platform}-${process.arch}` }); createWindow(); createTray(); });
let quitQueueFenced=false;
app.on("before-quit", event => {
  isQuitting = true;
  if(quitQueueFenced)return;
  event.preventDefault();
  // Let the local page fence arrive before Electron exits. Already dispatched
  // exchange requests retain their receipts; queued requests cannot submit.
  const lbankBrowser=require('./exchanges/lbank-browser.cjs').browser;
  Promise.race([Promise.allSettled([lbankBrowser.cancelQueuedRequests(),lbankBrowser.stopRecorder('quit')]),new Promise(resolve=>setTimeout(resolve,3000))])
    .catch(error=>logEvent('warning','quit_queue_fence_failed',{error}))
    .finally(()=>{releaseLiveTradingLock();quitQueueFenced=true;app.quit();});
});
app.on("window-all-closed", () => { /* The tray owns the application lifecycle. */ });
app.on("activate", showMainWindow);
