'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULTS, TimeEwmaBasis, PullbackExitTracker, ReentryGate, aggressiveLimitFillEstimate, automaticPositionBudget, bookMetrics, conservativePaperFill, feeAwareEdge,
  marketEntryEstimate, marketExitEstimate, normalizeBook, planEntryExecution, quantityForNotional, rollingReturnBps, roundToTick, signalSide,
} = require('./core.cjs');
const { PublicMarketHub, commonSymbol, resolveReference } = require('./market-streams.cjs');
const { acquireLiveTradingLock } = require('../../electron/trading/live-trading-lock.cjs');

const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const STRATEGY_FIELDS = Object.freeze([
  'nominal', 'leverage', 'impulsePercent', 'cooldownSeconds', 'impulseWindowMs', 'warmupSeconds', 'basisHalfLifeSeconds',
  'entryLifetimeMs', 'minimumHoldMs', 'trailingActivationPercent', 'reversalPercent', 'reversalHoldMs', 'adversePercent', 'maxHoldSeconds',
  'minimumTrailNetPercent', 'maxEntrySlippagePercent', 'marketEntryImpulseMultiplier', 'depthSafetyMultiplier', 'maxLossPercent',
]);

function strategyDefaults(defaults = DEFAULTS) {
  return {
    nominal: 50, leverage: 5, impulsePercent: defaults.impulseBps / 100, cooldownSeconds: defaults.cooldownMs / 1000,
    impulseWindowMs: defaults.impulseWindowMs, warmupSeconds: defaults.warmupMs / 1000, basisHalfLifeSeconds: defaults.basisHalfLifeMs / 1000,
    entryLifetimeMs: defaults.entryLifetimeMs, minimumHoldMs: defaults.minimumHoldMs, trailingActivationPercent: defaults.trailingActivationBps / 100,
    reversalPercent: defaults.reversalBps / 100, reversalHoldMs: defaults.reversalHoldMs, adversePercent: defaults.adverseBps / 100,
    maxHoldSeconds: defaults.maxHoldMs / 1000, minimumTrailNetPercent: defaults.minimumTrailNetBps / 100,
    maxEntrySlippagePercent: defaults.maxEntrySlippageBps / 100, marketEntryImpulseMultiplier: defaults.marketEntryImpulseMultiplier,
    depthSafetyMultiplier: defaults.depthSafetyMultiplier, maxLossPercent: defaults.maxLossPercent,
  };
}

function validateStrategyField(key, raw) {
  const value = finite(raw);
  const integer = ['leverage', 'cooldownSeconds', 'impulseWindowMs', 'warmupSeconds', 'basisHalfLifeSeconds', 'entryLifetimeMs', 'minimumHoldMs', 'reversalHoldMs', 'maxHoldSeconds'].includes(key);
  if (value === null || integer && !Number.isInteger(value)) throw new Error(`${key}: требуется числовое значение${integer ? ' без дробной части' : ''}`);
  const ranges = {
    nominal: [0.01, 10_000_000], leverage: [1, 125], impulsePercent: [0.0001, 10], cooldownSeconds: [0, 86_400],
    impulseWindowMs: [250, 10_000], warmupSeconds: [0, 600], basisHalfLifeSeconds: [1, 600], entryLifetimeMs: [100, 10_000],
    minimumHoldMs: [0, 300_000], trailingActivationPercent: [0, 10], reversalPercent: [0.0001, 10], reversalHoldMs: [0, 10_000],
    adversePercent: [0.001, 20], maxHoldSeconds: [1, 300], minimumTrailNetPercent: [-10, 10],
    maxEntrySlippagePercent: [0, 1], marketEntryImpulseMultiplier: [1, 10], depthSafetyMultiplier: [1, 100], maxLossPercent: [.1, 10],
  };
  const [minimum, maximum] = ranges[key] || [-Infinity, Infinity];
  if (value < minimum || value > maximum) throw new Error(`${key}: допустимо от ${minimum} до ${maximum}`);
  return value;
}

function strategyPatch(input = {}) {
  const result = {};
  for (const key of STRATEGY_FIELDS) if (Object.hasOwn(input, key)) {
    // Basis starts learning from the first fresh quote. A persisted or legacy
    // warm-up value must never delay signals again.
    result[key] = key === 'warmupSeconds' ? 0 : validateStrategyField(key, input[key]);
  }
  return result;
}

function validateEffectiveStrategy(value) {
  const result = strategyPatch(value);
  for (const key of STRATEGY_FIELDS) if (!Object.hasOwn(result, key)) throw new Error(`${key}: настройка отсутствует`);
  if (result.minimumHoldMs >= result.maxHoldSeconds * 1000) throw new Error('Минимальное удержание должно быть короче максимального');
  return result;
}

function normalizeSettingsProfile(raw, defaults = DEFAULTS) {
  const fallback = strategyDefaults(defaults), source = raw && typeof raw === 'object' ? raw : {};
  const mode = source.mode === 'live' ? 'live' : 'paper', paperFast = mode === 'paper' && source.paperFast === true;
  const profileId = typeof source.profileId === 'string' ? source.profileId : '';
  const lastSymbol = /^[A-Z0-9]{1,20}USDT$/.test(commonSymbol(source.lastSymbol || source.symbol || 'BTCUSDT')) ? commonSymbol(source.lastSymbol || source.symbol || 'BTCUSDT') : 'BTCUSDT';
  if (source.version === 2 && source.global && typeof source.global === 'object') {
    const savedGlobal = strategyPatch(source.global);
    // One-time compatibility migration from the original generic micro-trail
    // defaults to the ZEC_USD1 pullback model. Explicit user risk values remain.
    if (savedGlobal.minimumHoldMs === 500 && savedGlobal.reversalPercent === .03 && savedGlobal.reversalHoldMs === 300
      && savedGlobal.adversePercent === .08 && savedGlobal.maxHoldSeconds === 10) {
      Object.assign(savedGlobal, { minimumHoldMs: 2000, reversalPercent: .02, reversalHoldMs: 0, adversePercent: .03, maxHoldSeconds: 60 });
    }
    savedGlobal.warmupSeconds = 0;
    const global = validateEffectiveStrategy({ ...fallback, ...savedGlobal }), symbols = {};
    for (const [rawSymbol, rawOverride] of Object.entries(source.symbols || {})) {
      const symbol = commonSymbol(rawSymbol); if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol) || !rawOverride || typeof rawOverride !== 'object') continue;
      const override = strategyPatch(rawOverride); delete override.warmupSeconds; validateEffectiveStrategy({ ...global, ...override }); symbols[symbol] = override;
    }
    return { version: 2, profileId, mode, paperFast, lastSymbol, global, symbols };
  }
  const legacyOverride = strategyPatch(source), symbols = Object.keys(legacyOverride).length ? { [lastSymbol]: legacyOverride } : {};
  return { version: 2, profileId, mode, paperFast, lastSymbol, global: fallback, symbols };
}

function defaultStateDirectory() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  if (!appData) throw new Error('Не удалось определить каталог LBank Impulse');
  return path.join(appData, 'Hedge LBank', 'impulse');
}

function safeError(error) {
  return {
    message: String(error?.message || error || 'Неизвестная ошибка').slice(0, 500),
    code: typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : undefined,
    definitive: error?.definitive === true,
    retryAfterMs: finite(error?.retryAfterMs),
  };
}

class StateStore {
  constructor(directory = defaultStateDirectory()) {
    this.directory = path.resolve(directory); this.file = path.join(this.directory, 'state.json'); this.settingsFile = path.join(this.directory, 'settings.json');
    this.journalFile = path.join(this.directory, 'journal.jsonl'); this.replayDirectory = path.join(this.directory, 'replays'); this.replayFile = null;
    fs.mkdirSync(this.replayDirectory, { recursive: true });
  }
  read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; return fallback; } }
  loadState() { return this.read(this.file, null); }
  loadSettings() { return this.read(this.settingsFile, null); }
  write(file, value) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temporary, file);
  }
  saveState(value) { this.write(this.file, value); }
  saveSettings(value) { this.write(this.settingsFile, value); }
  append(file, value) { fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 }); }
  journal(value) { this.append(this.journalFile, value); }
  startReplay(meta) {
    if (this.replayFile) return this.replayFile;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.replayFile = path.join(this.replayDirectory, `${stamp}-${String(meta?.config?.symbol || 'market').toLowerCase()}-${crypto.randomBytes(3).toString('hex')}.jsonl`);
    this.append(this.replayFile, { type: 'meta', version: 1, at: Date.now(), ...meta }); return this.replayFile;
  }
  recordReplay(value) { if (this.replayFile) this.append(this.replayFile, value); }
  endReplay(summary = {}) {
    if (!this.replayFile) return null;
    const file = this.replayFile; this.append(file, { type: 'end', at: Date.now(), ...summary }); this.replayFile = null; return file;
  }
}

function orderIdentity(order) {
  return { symbol: order.symbol, orderId: order.orderId, clientOrderId: order.clientOrderId, quantity: order.quantity, side: order.side };
}

function matchingSymbol(row, symbol) { return commonSymbol(row?.symbol) === symbol; }
function activeOrders(rows, symbol) { return (Array.isArray(rows) ? rows : []).filter(row => matchingSymbol(row, symbol) && !TERMINAL.has(String(row?.status || '').toUpperCase())); }
function positionsFor(rows, symbol, side = null) {
  const wanted = side === 'BUY' ? 'long' : side === 'SELL' ? 'short' : null;
  return (Array.isArray(rows) ? rows : []).filter(row => matchingSymbol(row, symbol) && Number(row?.quantity) > 1e-12 && (!wanted || String(row?.side).toLowerCase() === wanted));
}

class ImpulseEngine extends EventEmitter {
  constructor({
    browser, stateDirectory, now = () => Date.now(), sleeper = sleep, referenceResolver = resolveReference,
    hubFactory = options => new PublicMarketHub(options), lockFactory = (owner, resource) => acquireLiveTradingLock(owner, { resource }), defaults = {},
  } = {}) {
    super();
    if (!browser) throw new Error('ImpulseEngine требует LBankBrowser');
    this.browser = browser; this.now = now; this.sleep = sleeper; this.referenceResolver = referenceResolver; this.hubFactory = hubFactory; this.lockFactory = lockFactory;
    this.defaults = { ...DEFAULTS, ...defaults }; this.store = new StateStore(stateDirectory);
    this.settingsProfile = normalizeSettingsProfile(this.store.loadSettings(), this.defaults); this.settings = this.effectiveSettings(this.settingsProfile.lastSymbol);
    this.saveSettings();
    this.credentials = null; this.account = null; this.config = null; this.rules = null; this.fees = null; this.reference = null; this.hub = null;
    this.latest = null; this.leaderHistory = []; this.lastLeaderSampleAt = null; this.lastBasisPair = ''; this.basis = new TimeEwmaBasis({ halfLifeMs: this.defaults.basisHalfLifeMs, warmupMs: this.defaults.warmupMs });
    this.gate = new ReentryGate(this.defaults.cooldownMs); this.tracker = null; this.liveLock = null; this.operation = null; this.closePromise = null; this.watchdog = null; this.lastMarketEmit = 0;
    this.controlEpoch = 0; this.starting = false;
    const recovered = this.store.loadState();
    this.state = {
      version: 1, phase: 'disconnected', connected: false, configured: false, running: false, paused: false,
      mode: this.settings.mode === 'live' ? 'live' : 'paper', symbol: null, reference: null, profileId: null,
      activeOrder: null, position: null, protection: null, requiresAttention: false, error: null,
      sessionActive: false, sessionSymbol: null, sessionConfig: null, sessionStartedAt: null,
      sessionTrades: 0, sessionWins: 0, sessionLosses: 0, sessionBreakeven: 0,
      lastCloseAt: null, realizedGross: 0, feesPaid: 0, realizedNet: 0, lastExitReason: null,
      ...(recovered?.version === 1 ? {
        recovery: recovered.activeOrder || recovered.position || recovered.protection ? recovered : null,
        requiresAttention: Boolean(recovered.activeOrder || recovered.position || recovered.protection),
        phase: recovered.activeOrder || recovered.position || recovered.protection ? 'recovery' : 'disconnected',
        realizedGross: finite(recovered.realizedGross) || 0, feesPaid: finite(recovered.feesPaid) || 0, realizedNet: finite(recovered.realizedNet) || 0,
        sessionActive: recovered.sessionActive === true, sessionSymbol: recovered.sessionSymbol ? commonSymbol(recovered.sessionSymbol) : null,
        sessionConfig: typeof recovered.sessionConfig === 'string' ? recovered.sessionConfig : null,
        sessionStartedAt: finite(recovered.sessionStartedAt), sessionTrades: finite(recovered.sessionTrades) || 0,
        sessionWins: finite(recovered.sessionWins) || 0, sessionLosses: finite(recovered.sessionLosses) || 0,
        sessionBreakeven: finite(recovered.sessionBreakeven) || 0,
        lastCloseAt: finite(recovered.lastCloseAt), lastExitReason: recovered.lastExitReason || null,
      } : {}),
    };
    if (this.state.lastCloseAt) this.gate.closed(this.state.lastCloseAt);
    this.watchdog = setInterval(() => this.onWatchdog(), 100); this.watchdog.unref?.();
  }

  emitProtocol(type, payload = {}) {
    const value = { v: 1, type, at: this.now(), ...payload };
    if (['order', 'position', 'protection', 'error'].includes(type)) this.store.journal(value);
    this.emit('event', value); return value;
  }
  publicState() { return { ...this.state, settings: { ...this.settings }, settingsProfile: JSON.parse(JSON.stringify(this.settingsProfile)), account: this.account, config: this.config, rules: this.rules, fees: this.fees, evaluation: this.evaluation || null }; }
  publish(patch = {}) {
    Object.assign(this.state, patch); this.persist(); this.emitProtocol('state', { state: this.publicState() }); return this.publicState();
  }
  persist() {
    this.store.saveState({
      version: 1, profileId: this.state.profileId, mode: this.state.mode, symbol: this.state.symbol,
      activeOrder: this.state.activeOrder, position: this.state.position, protection: this.state.protection,
      sessionActive: this.state.sessionActive, sessionSymbol: this.state.sessionSymbol, sessionConfig: this.state.sessionConfig,
      sessionStartedAt: this.state.sessionStartedAt,
      sessionTrades: this.state.sessionTrades, sessionWins: this.state.sessionWins,
      sessionLosses: this.state.sessionLosses, sessionBreakeven: this.state.sessionBreakeven,
      realizedGross: this.state.realizedGross, feesPaid: this.state.feesPaid, realizedNet: this.state.realizedNet,
      lastCloseAt: this.state.lastCloseAt, lastExitReason: this.state.lastExitReason, savedAt: this.now(),
    });
  }
  effectiveSettings(symbol = this.settingsProfile.lastSymbol) {
    const normalized = commonSymbol(symbol || this.settingsProfile.lastSymbol || 'BTCUSDT');
    return { ...this.settingsProfile.global, ...(this.settingsProfile.symbols[normalized] || {}), symbol: normalized,
      profileId: this.settingsProfile.profileId, mode: this.settingsProfile.mode, paperFast: this.settingsProfile.paperFast };
  }
  saveSettings() { this.store.saveSettings(this.settingsProfile); }
  settingsResult() { return { settings: { ...this.settings }, settingsProfile: JSON.parse(JSON.stringify(this.settingsProfile)) }; }
  requireConnected() { if (!this.credentials || !this.state.connected) throw new Error('Сначала подключите профиль LBank · Undetectable'); }
  requireConfigured() { this.requireConnected(); if (!this.config || !this.hub) throw new Error('Сначала примените настройки монеты'); }

  saveDraft(options = {}) {
    if (this.starting || ['connecting', 'configuring'].includes(this.state.phase) || this.state.running || this.state.activeOrder || this.state.position || this.state.recovery) {
      throw new Error('Параметры активной стратегии изменять нельзя');
    }
    const next = JSON.parse(JSON.stringify(this.settingsProfile));
    if (Object.hasOwn(options, 'symbol')) {
      const symbol = commonSymbol(options.symbol); if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol)) throw new Error('Некорректный фьючерсный символ'); next.lastSymbol = symbol;
    }
    if (Object.hasOwn(options, 'mode')) {
      const mode = String(options.mode).toLowerCase(); if (!['paper', 'live'].includes(mode)) throw new Error('Режим должен быть Paper или Live'); next.mode = mode;
    }
    if (Object.hasOwn(options, 'paperFast')) next.paperFast = options.paperFast === true;
    if (Object.hasOwn(options, 'profileId')) {
      const profileId = String(options.profileId || '').trim(); if (profileId && !/^[A-Za-z0-9_-]{1,128}$/.test(profileId)) throw new Error('Некорректный профиль Undetectable'); next.profileId = profileId;
    }
    if (options.globalSettings && typeof options.globalSettings === 'object') next.global = validateEffectiveStrategy({ ...next.global, ...strategyPatch(options.globalSettings) });
    const direct = strategyPatch(options);
    if (Object.keys(direct).length) {
      const target = next.lastSymbol; const override = { ...(next.symbols[target] || {}), ...direct };
      validateEffectiveStrategy({ ...next.global, ...override }); next.symbols[target] = override;
    }
    const targetSymbol = commonSymbol(options.settingsSymbol || next.lastSymbol);
    if ((options.resetSymbolSettings === true || options.symbolSettings) && !/^[A-Z0-9]{1,20}USDT$/.test(targetSymbol)) throw new Error('Некорректный символ для настроек монеты');
    if (options.resetSymbolSettings === true) delete next.symbols[targetSymbol];
    if (options.symbolSettings && typeof options.symbolSettings === 'object') {
      const override = strategyPatch(options.symbolSettings); validateEffectiveStrategy({ ...next.global, ...override });
      if (Object.keys(override).length) next.symbols[targetSymbol] = override; else delete next.symbols[targetSymbol];
    }
    this.settingsProfile = normalizeSettingsProfile(next, this.defaults); this.settings = this.effectiveSettings(this.settingsProfile.lastSymbol);
    this.state.mode = this.settings.mode; this.saveSettings(); return this.settingsResult();
  }

  async listSymbols() {
    this.requireConnected();
    const rows = await this.browser.getMarkets(this.credentials);
    return [...new Set((Array.isArray(rows) ? rows : []).map(row => commonSymbol(row?.symbol)).filter(symbol => /^[A-Z0-9]{1,20}USDT$/.test(symbol)))].sort();
  }

  async listProfiles() {
    const rows = await require('../../electron/exchanges/undetectable.cjs').listProfiles();
    return rows.map(({ id, name, status }) => ({ id, name, status }));
  }

  async connect(profileId) {
    const id = String(profileId || '').trim(); if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Выберите профиль Undetectable');
    if (this.state.position || this.state.activeOrder) throw new Error('Нельзя менять профиль при незавершённой операции');
    this.hub?.stop(); this.hub = null;
    if (this.credentials) this.browser.disconnect();
    const credentials = { connectionMode: 'undetectable', undetectableProfileId: id };
    this.publish({ phase: 'connecting', connected: false, configured: false, error: null });
    try {
      this.account = await this.browser.connect(credentials); this.credentials = credentials; this.settingsProfile.profileId = id; this.settings = this.effectiveSettings(); this.saveSettings();
      this.publish({ phase: this.state.requiresAttention ? 'recovery' : 'connected', connected: true, profileId: id, error: null });
      this.emitProtocol('account', { account: this.account }); return { account: this.account, profileId: id };
    } catch (error) { this.credentials = null; this.publish({ phase: 'disconnected', connected: false, error: safeError(error) }); throw error; }
  }

  async configure(options = {}) {
    this.requireConnected(); if (this.state.running || this.state.activeOrder || this.state.position) throw new Error('Остановите текущую стратегию перед изменением настроек');
    const previousSymbol = this.config?.symbol || null;
    const symbol = commonSymbol(options.symbol || this.settings.symbol);
    let strategy = validateEffectiveStrategy({ ...this.effectiveSettings(symbol), ...strategyPatch(options) });
    let { nominal, leverage, impulsePercent, cooldownSeconds } = strategy;
    const mode = String(options.mode || this.settings.mode).toLowerCase();
    const paperFast = mode === 'paper' && (options.paperFast ?? this.settings.paperFast) === true;
    if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol)) throw new Error('Некорректный фьючерсный символ');
    if (!(nominal > 0)) throw new Error('Номинал должен быть больше нуля');
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error('Плечо должно быть целым от 1x до 125x');
    if (!(impulsePercent >= 0.0001 && impulsePercent <= 10)) throw new Error('Импульс должен быть от 0,0001% до 10%');
    if (!(cooldownSeconds >= 0 && cooldownSeconds <= 86_400)) throw new Error('Cooldown должен быть от 0 до 86400 секунд');
    if (!['paper', 'live'].includes(mode)) throw new Error('Режим должен быть Paper или Live');
    this.publish({ phase: 'configuring', configured: false, error: null });
    try {
      const [markets, rules, feeRows, account, reference] = await Promise.all([
        this.browser.getMarkets(this.credentials), this.browser.getTradingRules(symbol, this.credentials),
        this.browser.getFeeRates(this.credentials), this.browser.getAccount(this.credentials), this.referenceResolver(symbol),
      ]);
      if (!(Array.isArray(markets) && markets.some(row => commonSymbol(row.symbol) === symbol))) throw new Error(`${symbol}: контракт отсутствует или закрыт на LBank Futures`);
      const fees = feeRows?.[symbol] || feeRows?.default;
      if (!(finite(fees?.makerFee) >= 0 && finite(fees?.takerFee) >= 0)) throw new Error('LBank не подтвердил персональные maker/taker комиссии; Live-вход запрещён');
      let automaticBudget = null;
      if (options.autoPosition === true) {
        const marketPrice = finite(markets.find(row => commonSymbol(row.symbol) === symbol)?.lastPrice);
        automaticBudget = automaticPositionBudget({ available: account?.available, price: marketPrice, rules, reserveFraction: options.reserveFraction,
          maxLossPercent: strategy.maxLossPercent, hardStopBps: strategy.adversePercent * 100 * 3,
          entryFeeRate: fees.takerFee, exitFeeRate: fees.takerFee, riskBufferBps: this.defaults.riskBufferBps });
        nominal = automaticBudget.nominal; leverage = automaticBudget.leverage;
        strategy = { ...strategy, nominal, leverage };
      }
      if (!(finite(rules?.maxLeverage) >= 1) || leverage > Number(rules.maxLeverage)) throw new Error(`${symbol}: LBank разрешает плечо не выше ${rules?.maxLeverage || 'неизвестного'}x`);
      quantityForNotional(nominal, markets.find(row => commonSymbol(row.symbol) === symbol)?.lastPrice, rules);
      this.hub?.stop();
      this.account = account; this.rules = rules; this.fees = { makerFee: Number(fees.makerFee), takerFee: Number(fees.takerFee), source: fees.source || 'account' }; this.reference = reference;
      this.config = { ...strategy, symbol, impulseBps: impulsePercent * 100, warmupMs: strategy.warmupSeconds * 1000,
        basisHalfLifeMs: strategy.basisHalfLifeSeconds * 1000, trailingActivationBps: strategy.trailingActivationPercent * 100,
        reversalBps: strategy.reversalPercent * 100, adverseBps: strategy.adversePercent * 100, maxHoldMs: strategy.maxHoldSeconds * 1000,
        minimumTrailNetBps: strategy.minimumTrailNetPercent * 100, maxEntrySlippageBps: strategy.maxEntrySlippagePercent * 100,
        mode, paperFast, marginMode: 'isolated', autoPosition: options.autoPosition === true, automaticBudget };
      this.settingsProfile.lastSymbol = symbol; this.settingsProfile.mode = mode; this.settingsProfile.paperFast = paperFast;
      this.settings = { ...strategy, symbol, profileId: this.settingsProfile.profileId, mode, paperFast }; this.saveSettings();
      if (previousSymbol && previousSymbol !== symbol) this.gate = new ReentryGate(cooldownSeconds * 1000);
      else this.gate.cooldownMs = cooldownSeconds * 1000;
      this.hub = this.hubFactory({ symbol, tickSize: rules.tickSize, lbankMultiplier: rules.contractSize || 1, reference });
      this.hub.on('market', value => this.onMarket(value)); this.hub.on('status', value => this.emitProtocol('stream', value)); this.hub.start();
      this.resetSignalModel();
      const recovery = this.state.recovery;
      const wrongRecovery = recovery && (recovery.profileId && recovery.profileId !== this.state.profileId || recovery.symbol && commonSymbol(recovery.symbol) !== symbol);
      this.publish({ phase: recovery ? 'recovery' : 'ready', configured: true, mode, symbol, reference: reference.leader, error: wrongRecovery ? { message: 'Журнал восстановления относится к другому профилю или символу' } : null });
      this.emitProtocol('configured', { config: this.config, rules, fees: this.fees, reference });
      return { config: this.config, rules, fees: this.fees, reference, account };
    } catch (error) { this.publish({ phase: 'connected', configured: false, error: safeError(error) }); throw error; }
  }

  resetSignalModel() {
    this.leaderHistory = []; this.lastLeaderSampleAt = null; this.lastBasisPair = '';
    this.basis = new TimeEwmaBasis({ halfLifeMs: this.config?.basisHalfLifeMs ?? this.defaults.basisHalfLifeMs, warmupMs: this.config?.warmupMs ?? this.defaults.warmupMs });
    this.evaluation = null;
  }

  async start() {
    this.requireConfigured();
    if (this.state.requiresAttention || this.state.recovery) throw new Error('Сначала выполните STOP & FLAT и завершите восстановление');
    if (this.state.running) return this.publicState();
    if (this.starting) throw new Error('Запуск уже выполняется');
    const epoch = ++this.controlEpoch, assertCurrent = () => {
      if (epoch !== this.controlEpoch) throw Object.assign(new Error('Запуск отменён командой Pause или STOP & FLAT'), { code: 'START_CANCELED', definitive: true });
    };
    this.starting = true;
    try {
      if (this.config.mode === 'live') {
        if (!this.liveLock) this.liveLock = this.lockFactory('LBank Impulse', `lbank:${this.state.profileId}`);
        const [account, positions, orders] = await Promise.all([
          this.browser.getAccount(this.credentials), this.browser.getPositions(this.credentials), this.browser.getOpenOrders(this.credentials),
        ]);
        assertCurrent();
        if (positionsFor(positions, this.config.symbol).length) throw new Error('На LBank уже есть позиция по выбранной монете');
        if (activeOrders(orders, this.config.symbol).length) throw new Error('На LBank уже есть активная или условная заявка по выбранной монете');
        if (!(finite(account.available) * this.config.leverage + 1e-8 >= this.config.nominal)) throw new Error('Недостаточно доступной isolated-маржи для выбранного номинала');
        if (10_000 / this.config.leverage <= 40) throw new Error('Выбранное плечо не оставляет безопасного расстояния до аварийного SL');
        await this.browser.configureLeverage(this.credentials, { symbol: this.config.symbol, leverage: this.config.leverage, marginMode: 'isolated' }, { allowLiveTrading: true });
        assertCurrent(); this.account = account;
      }
      assertCurrent(); this.resetSignalModel();
      const sessionConfig = JSON.stringify(Object.fromEntries(['symbol', ...STRATEGY_FIELDS, 'mode', 'paperFast'].map(key => [key, this.config[key]])));
      if (!this.state.sessionActive || this.state.sessionConfig !== sessionConfig) Object.assign(this.state, {
        sessionSymbol: this.config.symbol, sessionConfig, sessionStartedAt: this.now(), sessionTrades: 0, sessionWins: 0, sessionLosses: 0, sessionBreakeven: 0,
        realizedGross: 0, feesPaid: 0, realizedNet: 0, lastCloseAt: null, lastExitReason: null });
      this.state.sessionActive = true;
      this.store.startReplay({ config: this.config, rules: this.rules, fees: this.fees, reference: this.reference, defaults: this.defaults });
      this.state.running = true; this.state.paused = false; this.state.error = null;
      this.publish({ phase: this.config.warmupMs > 0 ? 'warming_up' : 'waiting', running: true, paused: false, error: null }); return this.publicState();
    } catch (error) { this.releaseLock(); throw error; }
    finally { this.starting = false; }
  }

  async pause() {
    this.controlEpoch++;
    this.state.running = false; this.state.paused = true; this.publish({ phase: this.state.position ? 'position' : this.state.activeOrder ? 'canceling' : 'paused', running: false, paused: true });
    if (this.operation) await this.operation;
    if (this.state.activeOrder) await this.cancelEntry('pause');
    if (!this.state.position && !this.state.activeOrder) { this.releaseLock(); this.store.endReplay({ reason: 'pause', state: this.publicState() }); }
    return this.publicState();
  }

  async flatten(reason = 'manual_flatten') {
    this.controlEpoch++;
    this.state.running = false; this.state.paused = true; this.publish({ phase: 'flattening', running: false, paused: true, error: null });
    try {
      if (this.operation) await this.operation;
      if (this.state.recovery) await this.recoverAndFlatten(reason);
      if (this.state.activeOrder) await this.cancelEntry(reason);
      if (this.state.position) await this.closePosition(reason);
      if (!this.state.activeOrder && !this.state.position && !this.state.protection) {
        this.state.requiresAttention = false; this.state.recovery = null; this.state.sessionActive = false;
        this.publish({ phase: 'paused', requiresAttention: false, recovery: null, sessionActive: false, error: null }); this.releaseLock(); this.store.endReplay({ reason, state: this.publicState() });
      }
      return this.publicState();
    } catch (error) { this.attention(error, 'recovery'); throw error; }
  }

  async recoverAndFlatten(reason) {
    const recovery = this.state.recovery; if (!recovery) return;
    if (!this.config || recovery.profileId !== this.state.profileId || commonSymbol(recovery.symbol) !== this.config.symbol) throw new Error('Подключите профиль и символ из журнала восстановления');
    if (recovery.mode === 'live' && !this.liveLock) this.liveLock = this.lockFactory('LBank Impulse recovery', `lbank:${this.state.profileId}`);
    if (recovery.activeOrder?.orderId || recovery.activeOrder?.clientOrderId) {
      const known = await this.readOrder(recovery.activeOrder);
      if (!TERMINAL.has(known.status)) {
        await this.browser.cancelOrder(this.credentials, orderIdentity(recovery.activeOrder), { allowLiveTrading: true });
        const terminal = await this.waitTerminalOrder(recovery.activeOrder, 15_000);
        if (!terminal) throw new Error('Восстановленная заявка не получила конечный статус');
        if (terminal.executedQty > 0 && !recovery.position) recovery.position = this.positionFromFill(recovery.activeOrder, terminal);
      } else if (known.executedQty > 0 && !recovery.position) recovery.position = this.positionFromFill(recovery.activeOrder, known);
    }
    this.state.activeOrder = null;
    if (recovery.position) this.state.position = { ...recovery.position };
    if (recovery.protection) this.state.protection = { ...recovery.protection };
    this.state.recovery = null; this.persist();
    if (this.state.position) await this.closePosition(reason);
    else if (this.state.protection) await this.clearProtection();
  }

  onMarket(snapshot) {
    this.latest = snapshot; const now = this.now(), leader = snapshot.quotes?.[this.reference?.leader], lbankBook = snapshot.books?.lbank;
    if (leader?.mid > 0 && leader.receivedAt !== this.lastLeaderSampleAt) {
      this.lastLeaderSampleAt = leader.receivedAt; this.leaderHistory.push({ at: leader.receivedAt, price: leader.mid });
      this.leaderHistory = this.leaderHistory.filter(row => row.at >= now - Math.max(3000, (this.config?.impulseWindowMs || this.defaults.impulseWindowMs) * 3));
    }
    if (leader?.mid > 0 && lbankBook) {
      const lbank = bookMetrics(lbankBook, this.config?.nominal || 0), key = `${leader.receivedAt}:${lbank.receivedAt}`;
      if (key !== this.lastBasisPair && now - leader.receivedAt <= this.defaults.leaderMaxAgeMs && now - lbank.receivedAt <= this.defaults.lbankMaxAgeMs) {
        this.lastBasisPair = key; this.basis.update(leader.mid, lbank.mid, now);
      }
    }
    this.evaluate(now);
    if (now - this.lastMarketEmit >= 100) {
      this.lastMarketEmit = now; const replayMarket = this.marketView(now, 25), market = this.marketView(now, 8);
      this.store.recordReplay({ type: 'market', at: now, market: replayMarket }); this.emitProtocol('market', { market });
    }
    if (this.state.activeOrder && this.config?.mode === 'paper') this.updatePaperFill();
    if (this.state.position) this.monitorPosition(now);
    if (this.state.running && !this.state.activeOrder && !this.state.position && !this.operation) this.maybeEnter(now);
  }

  marketView(now = this.now(), depth = 8) {
    if (!this.latest) return { symbol: this.config?.symbol, leader: this.reference?.leader, venues: {}, evaluation: this.evaluation || null };
    const venues = {};
    for (const venue of ['lbank', 'binance', 'mexc']) {
      const quote = this.latest.quotes?.[venue], book = this.latest.books?.[venue];
      if (!quote && !book) continue;
      let metrics = null; try { if (book) metrics = bookMetrics(book, this.config?.nominal || 0); } catch {}
      venues[venue] = { bid: metrics?.bid ?? quote?.bid, ask: metrics?.ask ?? quote?.ask, mid: metrics?.mid ?? quote?.mid, spreadBps: metrics?.spreadBps ?? null,
        bidDepthUsd: metrics?.bidDepthUsd ?? null, askDepthUsd: metrics?.askDepthUsd ?? null, ageMs: now - (book?.receivedAt ?? quote?.receivedAt),
        bids: book?.bids?.slice(0, depth) || [], asks: book?.asks?.slice(0, depth) || [] };
    }
    const leaderPrice = this.latest.quotes?.[this.reference?.leader]?.mid, lbankBook = this.latest?.books?.lbank;
    let trackerView = null;
    if (this.tracker && leaderPrice > 0 && lbankBook) {
      try {
        const lbankMid = bookMetrics(lbankBook).mid, expectedFair = this.basis.expected(leaderPrice);
        trackerView = this.tracker.metrics({ leaderPrice, lbankPrice: lbankMid,
          lagBps: expectedFair > 0 ? (expectedFair - lbankMid) / lbankMid * 10_000 : null }, now);
      } catch {}
    }
    const positionPnl = this.positionPnl();
    if (trackerView && positionPnl) Object.assign(trackerView, { exitNetBps: positionPnl.netBps,
      trailNetReady: positionPnl.netBps >= (this.config?.minimumTrailNetBps ?? 0) });
    return { symbol: this.config?.symbol, leader: this.reference?.leader, venues, evaluation: this.evaluation || null,
      positionControl: trackerView, basisBps: this.basis.basisBps(),
      warmingRemainingMs: this.basis.firstAt == null ? (this.config?.warmupMs ?? this.defaults.warmupMs) : Math.max(0, (this.config?.warmupMs ?? this.defaults.warmupMs) - (now - this.basis.firstAt)) };
  }

  evaluate(now = this.now()) {
    if (!this.config || !this.latest || !this.reference) return null;
    const leader = this.latest.quotes?.[this.reference.leader], lbankBook = this.latest.books?.lbank;
    const impulseBps = rollingReturnBps(this.leaderHistory, now, this.config.impulseWindowMs), side = signalSide(impulseBps, this.config.impulseBps);
    const direction = impulseBps > 0 ? 'BUY' : impulseBps < 0 ? 'SELL' : null;
    this.gate.observeSignal(Boolean(side));
    const value = { at: now, impulseBps, direction, side, thresholdBps: this.config.impulseBps, minimumLagBps: this.defaults.extraEdgeBps, costsIgnored: false,
      basisReady: this.basis.ready(now), eligible: false, reason: null, leaderAgeMs: leader ? now - leader.receivedAt : null, lbankAgeMs: lbankBook ? now - lbankBook.receivedAt : null };
    if (!leader || now - leader.receivedAt > this.defaults.leaderMaxAgeMs) value.reason = 'leader_stale';
    else if (!lbankBook || now - lbankBook.receivedAt > this.defaults.lbankMaxAgeMs) value.reason = 'lbank_stale';
    else if (!value.basisReady) value.reason = 'warming_up';
    else if (!side) value.reason = 'no_impulse';
    else try {
      const expectedFair = this.basis.expected(leader.mid);
      const execution = planEntryExecution({ book: lbankBook, side, notional: this.config.nominal, rules: this.rules, expectedFair,
        impulseBps, thresholdBps: this.config.impulseBps, maxSlippageBps: this.config.maxEntrySlippageBps,
        marketImpulseMultiplier: this.config.marketEntryImpulseMultiplier, depthSafetyMultiplier: this.config.depthSafetyMultiplier,
        allowSizeToDepth: this.config.autoPosition === true });
      const entryPrice = execution.expectedFillPrice, quantity = execution.quantity;
      const exit = marketExitEstimate(lbankBook, side, quantity);
      const entryFeeRate = execution.postOnly ? this.fees.makerFee : this.fees.takerFee;
      const edge = exit.enough ? feeAwareEdge({ side, expectedFair, entryPrice, makerFee: entryFeeRate, takerFee: this.fees.takerFee, exitImpactBps: exit.impactBps, extraEdgeBps: this.defaults.extraEdgeBps }) : { eligible: false, netEdgeBps: null };
      const positiveLag = finite(edge.grossBps) > 0;
      const lagEligible = execution.canExecute !== false && exit.enough && edge.eligible === true;
      const paperFastEntry = this.config.mode === 'paper' && this.config.paperFast && execution.canExecute !== false && exit.enough;
      Object.assign(value, { entryPrice: execution.price, expectedEntryPrice: entryPrice, quantity, expectedFair, exitImpactBps: exit.impactBps, grossBps: edge.grossBps, costBps: edge.costBps,
        netEdgeBps: edge.netEdgeBps, requiredBps: edge.requiredBps, feesCovered: Boolean(edge.eligible), lagEligible, paperFast: paperFastEntry,
        entryType: execution.type, postOnly: execution.postOnly, executionReason: execution.routeReason,
        entryImpactBps: execution.estimatedImpactBps, depthCoverage: execution.depthCoverage, allocatedNotional: execution.allocatedNotional,
        sizedDown: execution.sizedDown, maxEntrySlippageBps: execution.maxSlippageBps, entryFeeRate,
        eligible: Boolean(lagEligible || paperFastEntry), reason: execution.canExecute === false ? execution.routeReason : !exit.enough ? 'insufficient_exit_depth' : lagEligible || paperFastEntry ? null : positiveLag ? 'edge_too_small' : 'lag_not_positive' });
    } catch (error) { value.reason = 'invalid_book_or_size'; value.detail = error.message; }
    this.evaluation = value;
    value.cooldownRemainingMs = Math.max(0, this.gate.lastClosedAt + this.gate.cooldownMs - now);
    if (this.state.running && !this.state.activeOrder && !this.state.position) {
      const phase = !value.basisReady && this.config.warmupMs > 0 ? 'warming_up' : value.cooldownRemainingMs > 0 ? 'cooldown' : 'waiting'; if (this.state.phase !== phase) this.publish({ phase });
      this.emitProtocol('signal', { signal: value });
    }
    return value;
  }

  maybeEnter(now) {
    const value = this.evaluation; if (!value?.eligible || !this.gate.canEnter(now)) return;
    const leader = this.latest?.quotes?.[this.reference.leader]; if (!leader) return;
    this.operation = this.beginEntry({ ...value, detectedAt: now, leaderEntry: leader.mid }).catch(error => this.handleOperationError(error)).finally(() => { this.operation = null; });
  }

  async beginEntry(signal) {
    if (!this.state.running || this.state.activeOrder || this.state.position) return;
    const marketEntry = signal.entryType === 'MARKET', postOnly = signal.postOnly === true;
    const entryNotional = finite(signal.quantity) * finite(signal.entryPrice);
    if (this.config.automaticBudget && entryNotional > this.config.automaticBudget.nominal * (1 + 1e-8)) {
      throw Object.assign(new Error('Вход заблокирован: объём превышает лимит риска'), { definitive: true, code: 'RISK_LIMIT_EXCEEDED' });
    }
    const entryDeadlineMs = this.config.mode === 'live' ? Math.min(this.config.entryLifetimeMs, 1200) : this.config.entryLifetimeMs;
    const order = {
      symbol: this.config.symbol, side: signal.side, quantity: signal.quantity, price: signal.entryPrice, type: marketEntry ? 'MARKET' : 'LIMIT', postOnly,
      leverage: this.config.leverage, marginMode: 'isolated', clientOrderId: `imp_${this.now()}_${crypto.randomBytes(5).toString('hex')}`,
      detectedAt: signal.detectedAt, expiresAt: signal.detectedAt + entryDeadlineMs, leaderEntry: signal.leaderEntry,
      executionReason: signal.executionReason, estimatedImpactBps: signal.entryImpactBps, depthCoverage: signal.depthCoverage,
      maxEntrySlippageBps: this.config.maxEntrySlippageBps, depthSafetyMultiplier: this.config.depthSafetyMultiplier,
      entryFeeRate: postOnly ? this.fees.makerFee : this.fees.takerFee,
      fastPrepared: this.config.mode === 'live', status: 'SUBMITTING', executedQty: 0, mode: this.config.mode, paperFast: this.config.mode === 'paper' && this.config.paperFast,
    };
    this.state.activeOrder = order; this.publish({ phase: 'submitting', activeOrder: order, error: null }); this.emitProtocol('order', { action: 'intent', order });
    try {
      if (this.config.mode === 'live') {
        const placed = await this.browser.placeOrder(this.credentials, order, { allowLiveTrading: true });
        order.orderId = placed.orderId; order.status = 'NEW';
      } else if (marketEntry) {
        const book = this.latest?.books?.lbank;
        const fill = book ? marketEntryEstimate(book, order.side, order.quantity, order.maxEntrySlippageBps) : null;
        const coverage = fill && order.quantity > 0 ? fill.availableWithinLimit / order.quantity : 0;
        if (!fill?.enough || fill.impactBps > order.maxEntrySlippageBps + 1e-8 || coverage + 1e-10 < this.config.depthSafetyMultiplier) {
          throw Object.assign(new Error('Paper MARKET отменён: свежая глубина больше не укладывается в лимит исполнения'), { definitive: true, code: 'ENTRY_DEPTH_CHANGED' });
        }
        order.orderId = `paper_${order.clientOrderId}`; order.status = 'FILLED'; order.executedQty = order.quantity; order.avgPrice = fill.avgPrice;
      } else { order.orderId = `paper_${order.clientOrderId}`; order.status = 'NEW'; }
      this.persist(); this.publish({ phase: 'order', activeOrder: order }); this.emitProtocol('order', { action: 'placed', order: { ...order } });
    } catch (error) {
      if (error?.definitive === true || error?.code === 'POST_ONLY_WOULD_TAKE') {
        this.state.activeOrder = null; this.gate.needsReset = true; this.publish({ phase: 'waiting', activeOrder: null, error: null });
        this.emitProtocol('order', { action: 'rejected', order, error: safeError(error) }); return;
      }
      throw Object.assign(error, { phase: 'entry_unknown' });
    }

    if (marketEntry) {
      let final = { ...order };
      if (this.config.mode === 'live') {
        final = await this.waitTerminalOrder(order, 15_000);
        if (!final) throw Object.assign(new Error('LBank не подтвердил конечный статус MARKET-входа; повтор запрещён'), { phase: 'entry_unknown', code: 'MARKET_ENTRY_UNKNOWN' });
      } else this.emitProtocol('order', { action: 'fill', simulatedTestFill: false, order: { ...order } });
      const executed = finite(final.executedQty) || 0;
      this.state.activeOrder = null; this.persist();
      if (executed > 0) await this.establishPosition(order, final);
      else {
        this.gate.needsReset = true; this.publish({ phase: this.state.running ? 'waiting' : 'paused', activeOrder: null });
        this.emitProtocol('order', { action: 'unfilled', reason: 'market_unfilled', order: { ...final } });
      }
      return;
    }

    let final = null, cancelReason = null;
    while (this.now() < order.expiresAt && this.state.activeOrder === order) {
      if (this.config.mode === 'paper') {
        this.updatePaperFill(); if (order.status === 'FILLED') { final = { ...order }; break; }
      } else {
        const known = await this.readOrder(order); Object.assign(order, known); this.persist();
        if (TERMINAL.has(order.status)) { final = { ...order }; break; }
      }
      const current = this.evaluate(this.now());
      if (!this.state.running) { cancelReason = 'paused'; break; }
      if (!current?.eligible || current.side !== order.side) { cancelReason = current?.reason || 'signal_ended'; break; }
      await this.sleep(this.config.mode === 'paper' ? 25 : 150);
    }
    if (!final) final = await this.cancelEntry(cancelReason || 'deadline', order);
    if (!final) return;
    const executed = finite(final.executedQty) || 0;
    this.state.activeOrder = null; this.persist();
    if (executed > 0) await this.establishPosition(order, final);
    else {
      this.gate.needsReset = true; this.publish({ phase: this.state.running ? 'waiting' : 'paused', activeOrder: null });
      this.emitProtocol('order', { action: 'unfilled', reason: cancelReason || 'deadline', order: { ...final } });
    }
  }

  updatePaperFill() {
    const order = this.state.activeOrder; if (!order || (order.type || 'LIMIT') !== 'LIMIT' || order.mode !== 'paper' || !this.latest?.books?.lbank || TERMINAL.has(order.status)) return order;
    const book = normalizeBook(this.latest.books.lbank);
    if (order.lastPaperBookAt === book.receivedAt) return order;
    order.lastPaperBookAt = book.receivedAt;
    const syntheticTestFill = order.paperFast && this.now() - order.detectedAt >= 250;
    const remaining = Math.max(0, order.quantity - (order.executedQty || 0));
    let fill, fillPrice = order.price;
    if (syntheticTestFill) fill = remaining;
    else if (order.postOnly === false) {
      const estimate = aggressiveLimitFillEstimate(book, order.side, remaining, order.price);
      fill = estimate.filledQuantity; fillPrice = estimate.avgPrice || order.price;
    } else ({ fill } = conservativePaperFill(book, order, this.rules.tickSize));
    if (fill > order.quantity * 1e-10) {
      const previous = order.executedQty || 0, total = previous + fill;
      order.avgPrice = previous > 0 ? ((order.avgPrice || order.price) * previous + fillPrice * fill) / total : fillPrice;
      order.executedQty = total; order.status = total >= order.quantity - order.quantity * 1e-8 ? 'FILLED' : 'PARTIALLY_FILLED'; this.persist();
      this.emitProtocol('order', { action: 'fill', simulatedTestFill: syntheticTestFill, order: { ...order } });
    }
    return order;
  }

  async readOrder(order) {
    if (order.mode === 'paper') return { ...order };
    return this.browser.getOrder(this.credentials, orderIdentity(order));
  }

  async waitTerminalOrder(order, timeoutMs = 15_000) {
    const deadline = this.now() + timeoutMs, waits = [150, 250, 500, 1000]; let attempt = 0, last = null;
    while (this.now() < deadline) {
      last = await this.readOrder(order); Object.assign(order, last); this.persist();
      if (TERMINAL.has(String(last.status).toUpperCase())) return { ...order, ...last };
      await this.sleep(waits[Math.min(attempt++, waits.length - 1)]);
    }
    return null;
  }

  async cancelEntry(reason = 'cancel', expected = this.state.activeOrder) {
    const order = expected; if (!order || this.state.activeOrder !== order) return null;
    this.publish({ phase: 'canceling' }); this.emitProtocol('order', { action: 'cancel_requested', reason, order: { ...order } });
    if (order.mode === 'paper') { if (!TERMINAL.has(order.status)) order.status = order.executedQty > 0 ? 'CANCELED' : 'CANCELED'; this.persist(); return { ...order }; }
    let known = await this.readOrder(order);
    if (!TERMINAL.has(known.status)) {
      let canceled = null;
      try { canceled = await this.browser.cancelOrder(this.credentials, orderIdentity(order), { allowLiveTrading: true }); }
      catch (error) {
        if (error?.definitive === true) throw error;
        known = await this.waitTerminalOrder(order, 15_000);
        if (!known) throw Object.assign(new Error('Результат отмены LBank неизвестен; повторная отмена запрещена'), { code: 'ORDER_CANCEL_UNKNOWN', cause: error });
      }
      if (canceled) known = TERMINAL.has(String(canceled?.status || '').toUpperCase()) ? canceled : await this.waitTerminalOrder(order, 15_000);
      if (!known) throw Object.assign(new Error('LBank не подтвердил отмену входной заявки; повтор запрещён'), { code: 'ORDER_CANCEL_UNKNOWN' });
    }
    Object.assign(order, known); this.persist(); this.emitProtocol('order', { action: 'terminal', reason, order: { ...order } }); return { ...order };
  }

  positionFromFill(order, fill) {
    const quantity = finite(fill.executedQty) || 0, avgPrice = finite(fill.avgPrice) || finite(order.avgPrice) || order.price;
    const reportedFee = finite(fill.fee);
    return { symbol: order.symbol, side: order.side, quantity, avgPrice, openedAt: this.now(), leaderEntry: finite(order.leaderEntry) || this.latest?.quotes?.[this.reference?.leader]?.mid, mode: order.mode,
      entryOrderId: order.orderId, entryClientOrderId: order.clientOrderId, entryType: order.type || 'LIMIT', postOnly: order.postOnly === true,
      entryFeeRate: finite(order.entryFeeRate) ?? (order.type === 'MARKET' ? this.fees.takerFee : this.fees.makerFee),
      entryFee: reportedFee === null ? avgPrice * quantity * (finite(order.entryFeeRate) ?? (order.type === 'MARKET' ? this.fees.takerFee : this.fees.makerFee)) : reportedFee };
  }

  async establishPosition(order, fill) {
    const position = this.positionFromFill(order, fill); if (!(position.quantity > 0 && position.avgPrice > 0 && position.leaderEntry > 0)) throw new Error('Исполненный вход не содержит точного объёма или цены');
    this.state.position = position; this.state.activeOrder = null; this.tracker = new PullbackExitTracker({ side: position.side, leaderEntry: position.leaderEntry, openedAt: position.openedAt,
      lbankEntry: position.avgPrice, minimumHoldMs: this.config.minimumHoldMs,
      signalThresholdBps: this.config.trailingActivationBps, trailBps: this.config.reversalBps,
      emergencyBps: this.config.adverseBps, maxHoldMs: this.config.maxHoldMs });
    this.publish({ phase: 'protecting', position, activeOrder: null }); this.emitProtocol('position', { action: 'opened', position });
    if (position.mode === 'paper') {
      this.state.protection = this.protectionIntent(position, `paper_protection_${this.now()}`); this.publish({ phase: 'position', protection: this.state.protection }); return;
    }
    try {
      const confirmed = await this.waitPosition(position, 10_000); if (!confirmed) throw new Error('LBank не подтвердил позицию после исполнения входа');
      const intent = this.protectionIntent(position); this.state.protection = { ...intent, status: 'SUBMITTING' }; this.persist();
      let placed;
      try { placed = await this.browser.placeProtection(this.credentials, intent, { allowLiveTrading: true }); }
      catch (error) {
        if (error?.definitive === true) throw error;
        for (let attempt = 0; attempt < 8 && !placed; attempt++) {
          try { placed = await this.browser.getProtection(this.credentials, intent); }
          catch (readError) { if (readError?.code !== 'PROTECTION_NOT_FOUND' || attempt === 7) throw error; }
          if (!placed) await this.sleep(500);
        }
        if (!placed?.orderId) throw error;
      }
      this.state.protection = { ...intent, ...placed, orderId: placed.orderId, status: placed.status || 'PENDING' }; this.persist();
      let verified = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { verified = await this.browser.getProtection(this.credentials, { symbol: position.symbol, orderId: placed.orderId }); if (verified) break; }
        catch (error) { if (error?.code !== 'PROTECTION_NOT_FOUND' || attempt === 7) throw error; }
        await this.sleep(500);
      }
      if (!verified) throw new Error('Серверный TP/SL не подтверждён');
      this.state.protection = { ...this.state.protection, ...verified, status: verified.status || 'PENDING' }; this.publish({ phase: 'position', protection: this.state.protection }); this.emitProtocol('protection', { action: 'confirmed', protection: this.state.protection });
    } catch (error) {
      this.emitProtocol('protection', { action: 'failed', error: safeError(error) });
      await this.closePosition('protection_failed');
      if (this.state.position) throw error;
    }
  }

  protectionIntent(position, clientOrderId = `guard_${this.now()}_${crypto.randomBytes(5).toString('hex')}`) {
    const long = position.side === 'BUY';
    const takeProfitPrice = roundToTick(position.avgPrice * (long ? 1.01 : .99), this.rules.tickSize, long ? 'up' : 'down');
    const hardStopFraction = Math.max(this.config?.adverseBps || this.defaults.adverseBps, .01) * 3 / 10_000;
    const stopLossPrice = roundToTick(position.avgPrice * (long ? 1 - hardStopFraction : 1 + hardStopFraction), this.rules.tickSize, long ? 'down' : 'up');
    return { symbol: position.symbol, quantity: position.quantity, side: position.side, takeProfitPrice, stopLossPrice, clientOrderId, mode: position.mode };
  }

  async waitPosition(position, timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const rows = positionsFor(await this.browser.getPositions(this.credentials), position.symbol, position.side);
      if (rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0) + position.quantity * 1e-8 >= position.quantity) return rows;
      await this.sleep(500);
    }
    return null;
  }

  monitorPosition(now) {
    if (!this.state.position || !this.tracker || this.operation) return;
    const leader = this.latest?.quotes?.[this.reference?.leader], lbankBook = this.latest?.books?.lbank; if (!leader || !lbankBook) return;
    let lbank; try { lbank = bookMetrics(lbankBook, this.config.nominal); } catch { return; }
    const expectedFair = this.basis.expected(leader.mid), lagBps = expectedFair > 0 ? (expectedFair - lbank.mid) / lbank.mid * 10_000 : null;
    const reason = this.tracker.observe({ leaderPrice: leader.mid, lbankPrice: lbank.mid, lagBps }, now), pnl = this.positionPnl(); this.emitPnl(now);
    const discretionary = ['signal_ended', 'trailing_pullback'].includes(reason);
    if (reason && (!discretionary || pnl?.netBps >= (this.config?.minimumTrailNetBps ?? 0))) {
      this.operation = this.closePosition(reason).catch(error => this.handleOperationError(error)).finally(() => { this.operation = null; });
    }
  }

  positionPnl() {
    const position = this.state.position, book = this.latest?.books?.lbank; if (!position || !book) return null;
    try {
      const exit = marketExitEstimate(book, position.side, position.quantity); if (!exit.enough) return null;
      const gross = (position.side === 'BUY' ? exit.avgPrice - position.avgPrice : position.avgPrice - exit.avgPrice) * position.quantity;
      const entryFee = finite(position.entryFee) ?? position.avgPrice * position.quantity * this.fees.makerFee, exitFee = exit.avgPrice * position.quantity * this.fees.takerFee;
      const net = gross - entryFee - exitFee, entryNotional = position.avgPrice * position.quantity;
      return { gross, entryFee, exitFee, net, netBps: entryNotional > 0 ? net / entryNotional * 10_000 : null, exitPrice: exit.avgPrice };
    } catch { return null; }
  }

  emitPnl(now = this.now()) {
    const position = this.state.position, pnl = this.positionPnl(); if (!position || !pnl) return;
    this.emitProtocol('pnl', { pnl: { ...pnl, ageMs: now - position.openedAt } });
  }

  async closePosition(reason = 'close') {
    if (this.closePromise) return this.closePromise;
    const closing = this.performClosePosition(reason);
    this.closePromise = closing;
    try { return await closing; }
    finally { if (this.closePromise === closing) this.closePromise = null; }
  }

  async performClosePosition(reason = 'close') {
    const position = this.state.position; if (!position) { if (this.state.protection) await this.clearProtection(); return; }
    this.publish({ phase: 'closing', lastExitReason: reason }); this.emitProtocol('position', { action: 'close_requested', reason, position });
    let closePrice = null, closeFee = 0, closeQuote = 0, closeQuantity = 0, pnlKnown = true;
    if (position.mode === 'paper') {
      const exit = marketExitEstimate(this.latest?.books?.lbank, position.side, position.quantity);
      if (!exit.enough) throw new Error('Paper: в стакане недостаточно глубины для аварийного выхода');
      closePrice = exit.avgPrice; closeQuantity = position.quantity; closeQuote = closePrice * closeQuantity; closeFee = closePrice * position.quantity * this.fees.takerFee;
    } else {
      let remaining = position.quantity;
      closeAttempts: for (let attempt = 0; attempt < 3 && remaining > position.quantity * 1e-8; attempt++) {
        const closeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
        let plan;
        try { plan = await this.browser.getClosePlan(this.credentials, { symbol: position.symbol, side: closeSide, quantity: remaining }); }
        catch (error) {
          if (await this.isFreshFlat(position)) { remaining = 0; pnlKnown = false; break; }
          throw error;
        }
        if (!Array.isArray(plan) || !plan.length) throw new Error('LBank не построил точный план reduce-only закрытия');
        let filledThisAttempt = 0, quote = 0, fees = 0;
        for (const leg of plan) {
          const order = { symbol: position.symbol, side: closeSide, quantity: leg.quantity, type: 'MARKET', reduceOnly: true, positionId: leg.positionId,
            clientOrderId: `flat_${this.now()}_${crypto.randomBytes(5).toString('hex')}`, mode: 'live' };
          this.emitProtocol('order', { action: 'close_intent', order });
          let placed;
          try { placed = await this.browser.placeOrder(this.credentials, order, { allowLiveTrading: true }); }
          catch (error) {
            if (error?.code === 'NO_POSITION' && await this.isFreshFlat(position)) { remaining = 0; pnlKnown = false; break closeAttempts; }
            throw error;
          }
          order.orderId = placed.orderId;
          const final = await this.waitTerminalOrder(order, 15_000); if (!final) throw new Error('LBank не подтвердил конечный статус MARKET-закрытия');
          const executed = finite(final.executedQty) || 0; if (executed <= 0) continue;
          filledThisAttempt += executed; quote += executed * (finite(final.avgPrice) || 0); fees += finite(final.fee) || 0;
        }
        if (!(filledThisAttempt > 0)) throw new Error('MARKET-закрытие не исполнило подтверждённый объём');
        remaining = Math.max(0, remaining - filledThisAttempt); closeQuantity += filledThisAttempt; closeQuote += quote; closeFee += fees;
      }
      if (remaining > position.quantity * 1e-8) throw new Error('После трёх подтверждённых MARKET-попыток остался открытый объём');
      const flat = await this.waitFlat(position, 10_000); if (!flat) throw new Error('LBank не подтвердил нулевую позицию после закрытия');
    }
    if (pnlKnown && closeQuantity > 0 && closeQuote > 0) closePrice = closeQuote / closeQuantity;
    if (pnlKnown && !(closePrice > 0)) {
      const book = this.latest?.books?.lbank; if (book) { const estimate = marketExitEstimate(book, position.side, position.quantity); if (estimate.enough) closePrice = estimate.avgPrice; }
    }
    const gross = pnlKnown && closePrice > 0 ? (position.side === 'BUY' ? closePrice - position.avgPrice : position.avgPrice - closePrice) * position.quantity : null;
    const entryFee = finite(position.entryFee) ?? position.avgPrice * position.quantity * this.fees.makerFee;
    if (pnlKnown && !(closeFee > 0) && closePrice > 0) closeFee = closePrice * position.quantity * this.fees.takerFee;
    if (pnlKnown) {
      const tradeNet = gross - entryFee - closeFee;
      this.state.realizedGross += gross; this.state.feesPaid += entryFee + closeFee; this.state.realizedNet = this.state.realizedGross - this.state.feesPaid;
      this.state.sessionTrades += 1;
      if (tradeNet > 1e-12) this.state.sessionWins += 1;
      else if (tradeNet < -1e-12) this.state.sessionLosses += 1;
      else this.state.sessionBreakeven += 1;
    }
    const closedAt = this.now(); this.gate.closed(closedAt); this.state.position = null; this.tracker = null; this.state.lastCloseAt = closedAt; this.state.lastExitReason = reason; this.persist();
    try { await this.clearProtection(); }
    catch (error) {
      this.publish({ phase: 'recovery', position: null, requiresAttention: true, error: safeError(error) });
      this.emitProtocol('error', { error: safeError(error), alarm: false }); throw error;
    }
    this.publish({ phase: this.state.running ? 'cooldown' : 'paused', position: null, protection: null, lastCloseAt: closedAt, lastExitReason: reason,
      sessionTrades: this.state.sessionTrades, sessionWins: this.state.sessionWins, sessionLosses: this.state.sessionLosses, sessionBreakeven: this.state.sessionBreakeven,
      realizedGross: this.state.realizedGross, feesPaid: this.state.feesPaid, realizedNet: this.state.realizedNet });
    this.emitProtocol('position', { action: 'closed', reason, position,
      result: { closePrice, gross, fees: pnlKnown ? entryFee + closeFee : null, net: pnlKnown ? gross - entryFee - closeFee : null, pnlKnown } });
    if (!this.state.running) { this.releaseLock(); this.store.endReplay({ reason, state: this.publicState() }); }
  }

  async waitFlat(position, timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const rows = positionsFor(await this.browser.getPositions(this.credentials), position.symbol, position.side);
      if (!rows.length) return true; await this.sleep(500);
    }
    return false;
  }

  async isFreshFlat(position) {
    const rows = positionsFor(await this.browser.getPositions(this.credentials), position.symbol, position.side);
    return rows.length === 0;
  }

  async clearProtection() {
    let protection = this.state.protection; if (!protection) return;
    if (protection.mode !== 'paper' && !protection.orderId) {
      try {
        const recovered = await this.browser.getProtection(this.credentials, protection);
        if (recovered?.orderId) { protection = this.state.protection = { ...protection, ...recovered }; this.persist(); }
      } catch (error) { if (error?.code !== 'PROTECTION_NOT_FOUND') throw error; }
    }
    if (protection.mode !== 'paper' && protection.orderId) {
      try { await this.browser.cancelProtection(this.credentials, protection, { allowLiveTrading: true }); }
      catch (error) { if (error?.code !== 'PROTECTION_NOT_FOUND') throw error; }
      let absent = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { await this.browser.getProtection(this.credentials, { symbol: protection.symbol, orderId: protection.orderId }); }
        catch (error) { if (error?.code === 'PROTECTION_NOT_FOUND') { absent = true; break; } if (attempt === 7) throw error; }
        await this.sleep(500);
      }
      if (!absent) throw new Error('LBank не подтвердил отмену серверного TP/SL');
    }
    this.state.protection = null; this.persist(); this.emitProtocol('protection', { action: 'cleared', orderId: protection.orderId });
  }

  onWatchdog() {
    const now = this.now(); if (!this.state.position || this.operation) return;
    const leader = this.latest?.quotes?.[this.reference?.leader], lbank = this.latest?.books?.lbank;
    const stale = !leader || now - leader.receivedAt > this.defaults.positionLeaderMaxAgeMs || !lbank || now - lbank.receivedAt > this.defaults.positionLbankMaxAgeMs;
    if (stale) this.operation = this.closePosition('stale_market_data').catch(error => this.handleOperationError(error)).finally(() => { this.operation = null; });
    else this.monitorPosition(now);
  }

  attention(error, phase = 'error') {
    this.state.running = false; this.state.paused = true; this.state.requiresAttention = true;
    this.publish({ phase, running: false, paused: true, requiresAttention: true, error: safeError(error) }); this.emitProtocol('error', { error: safeError(error), alarm: Boolean(this.state.position) });
  }
  handleOperationError(error) { this.attention(error, error?.phase || 'error'); }
  releaseLock() { try { this.liveLock?.release(); } finally { this.liveLock = null; } }

  async shutdown() {
    try { if (this.state.activeOrder || this.state.position || this.state.recovery) await this.flatten('shutdown'); }
    finally { clearInterval(this.watchdog); this.hub?.stop(); this.browser.disconnect(); if (!this.state.activeOrder && !this.state.position && !this.state.recovery) this.releaseLock(); this.store.endReplay({ reason: 'shutdown', state: this.publicState() }); }
  }
}

module.exports = { ImpulseEngine, StateStore, activeOrders, defaultStateDirectory, positionsFor, safeError };
