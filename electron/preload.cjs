const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hedgeDesktop", {
  window: (action) => ipcRenderer.invoke("window:action", action),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (value) => ipcRenderer.invoke("settings:save", value),
  loadCredentials: () => ipcRenderer.invoke("credentials:load"),
  saveCredentials: (value) => ipcRenderer.invoke("credentials:save", value),
  listUndetectableProfiles: () => ipcRenderer.invoke('undetectable:profiles'),
  disconnectExchange: (id) => ipcRenderer.invoke('exchange:disconnect', id),
  getLBankRecorderStatus: () => ipcRenderer.invoke('lbank:recorder-status'),
  startLBankRecorder: () => ipcRenderer.invoke('lbank:recorder-start'),
  markLBankRecorder: (marker) => ipcRenderer.invoke('lbank:recorder-mark', marker),
  stopLBankRecorder: () => ipcRenderer.invoke('lbank:recorder-stop'),
  showLBankRecorder: () => ipcRenderer.invoke('lbank:recorder-show'),
  resetLossLimit: () => ipcRenderer.invoke('trading:reset-loss-limit'),
  getExchangeMarkets: (exchangeId) => ipcRenderer.invoke("market:exchange", exchangeId),
  getExchangeDepth: (exchangeId, symbol) => ipcRenderer.invoke("market:exchange-depth", exchangeId, symbol),
  getCommonMarkets: (sourceId, targetId) => ipcRenderer.invoke("market:common", sourceId, targetId),
  testExchange: (exchangeId) => ipcRenderer.invoke("exchange:test", exchangeId),
  testExchanges: (exchangeIds) => ipcRenderer.invoke("exchange:test-many", exchangeIds),
  startTrading: (options) => ipcRenderer.invoke("trading:start", options),
  stopTrading: (mode) => ipcRenderer.invoke("trading:stop", mode),
  previewHedge: (options) => ipcRenderer.invoke("trading:preview", options),
  getTradingState: () => ipcRenderer.invoke("trading:state"),
  getTradingHistory: (options) => ipcRenderer.invoke("trading:history", options),
  configureAccounts: (ids) => ipcRenderer.invoke("accounts:configure", ids),
  refreshAccounts: () => ipcRenderer.invoke("accounts:refresh"),
  onAccountSnapshot: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("accounts:snapshot", listener);
    return () => ipcRenderer.removeListener("accounts:snapshot", listener);
  },
  verifyProfile: (options) => ipcRenderer.invoke("profile:verify", options),
  getProfileSession: () => ipcRenderer.invoke("profile:session"),
  logoutProfile: () => ipcRenderer.invoke("profile:logout"),
  getAdminUsers: () => ipcRenderer.invoke("admin:users"),
  createAdminUser: (value) => ipcRenderer.invoke("admin:user-create", value),
  updateAdminUser: (keyId, value) => ipcRenderer.invoke("admin:user-update", keyId, value),
  configureUpdates: (options) => ipcRenderer.invoke("update:configure", options),
  getUpdateStatus: () => ipcRenderer.invoke("update:status"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  sendLogs: () => ipcRenderer.invoke("logs:send"),
  openTelegram: () => ipcRenderer.invoke("external:telegram"),
  onUpdateStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  onTradingState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("trading:state", listener);
    return () => ipcRenderer.removeListener("trading:state", listener);
  },
});
