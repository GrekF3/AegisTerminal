"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as Slider from "@radix-ui/react-slider";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowClockwise, ArrowsDownUp, ArrowsLeftRight, CaretRight, Check, CircleNotch, ClockCounterClockwise, Coins, Copy, Eye, EyeSlash, GearSix,
  Info, Minus, MinusCircle, Plus, PlusCircle, Power, Question, ShieldCheck,
  SlidersHorizontal, SpinnerGap, Stop, TrendUp, Wallet, Warning, X, UserCircle,
  Bell, CloudCheck, DownloadSimple, Key, Lifebuoy, LockKeyOpen, MagnifyingGlass, Monitor, PaperPlaneTilt, PencilSimple, PlugsConnected, RocketLaunch, SignOut, TelegramLogo, UserPlus, UsersThree
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AdminUser, LBankRecorderStatus, PortfolioSnapshot, StopMode, TradeSnapshot, UpdateStatus } from "@/types/desktop";
import { UpdateProgressDetails, updateLabel } from '@/components/update-progress';
import { AccountStatus } from "@/components/account-status";
import { AutomatedHedge } from "@/components/automated-hedge";
import { TradingHistoryView } from "@/components/trading-history";
import { StopDialog } from '@/components/stop-dialog';
import { botIsStopped, canManageStoppedTrade, tradeFeedback } from '@/lib/trade-feedback';
import { createTradingNotifications } from '@/lib/trading-notifications';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProfilePicker } from "@/components/ui/profile-picker";
import { cn } from "@/lib/utils";
import { BlackHoleHeroSection } from "@/components/ui/blackhole-hero-section";

type Tab = "status" | "hedge" | "users" | "settings" | "history";
type ExchangeId = "lbank" | "binance" | "bybit" | "okx" | "bitget" | "mexc" | "gateio";
type SetupStep = "exchanges" | "credentials";
type HedgeStep = "market" | "setup" | "leverage" | "ready";
type AuthState = "checking" | "signed_out" | "signed_in";
type Notice = { id: number; kind: "success" | "warning" | "error"; message: string };
type CommonMarket = { symbol: string; lastPrice: number; makerFee: number | null; takerFee: number | null; combinedTurnover: number; logoUrl?: string | null };

const DEFAULT_SERVER_URL = process.env.NEXT_PUBLIC_HEDGE_API_URL || "https://hedge.swallet.site";

type Exchange = {
  id: ExchangeId;
  name: string;
  logo: string;
  fields: { id: string; label: string; hint?: string }[];
};

const exchanges: Exchange[] = [
  { id: "lbank", name: "LBank", logo: "./exchanges/lbank.ico", fields: [{ id: "apiKey", label: "API Key" }, { id: "secret", label: "Secret Key" }, { id: "signatureMethod", label: "Signature Method", hint: "Для текущего backend используется HmacSHA256. LBank также поддерживает RSA." }] },
  { id: "binance", name: "Binance", logo: "./exchanges/binance.svg", fields: [{ id: "apiKey", label: "API Key" }, { id: "secret", label: "Secret Key" }] },
  { id: "bybit", name: "Bybit", logo: "./exchanges/bybit.ico", fields: [{ id: "apiKey", label: "API Key" }, { id: "secret", label: "Secret Key" }] },
  { id: "okx", name: "OKX", logo: "./exchanges/okx.svg", fields: [{ id: "apiKey", label: "API Key" }, { id: "secret", label: "Secret Key" }, { id: "passphrase", label: "Passphrase", hint: "Пароль, который вы создали вместе с API-ключом OKX." }] },
  { id: "bitget", name: "Bitget", logo: "./exchanges/bitget.ico", fields: [{ id: "apiKey", label: "API Key" }, { id: "secret", label: "Secret Key" }, { id: "passphrase", label: "Passphrase", hint: "Кодовая фраза API-ключа. Это не пароль от аккаунта." }] },
  { id: "mexc", name: "MEXC", logo: "./exchanges/mexc.svg", fields: [{ id: "apiKey", label: "Access Key" }, { id: "secret", label: "Secret Key" }] },
  { id: "gateio", name: "Gate.io", logo: "./exchanges/gateio.ico", fields: [{ id: "apiKey", label: "API Key" }, { id: "secret", label: "API Secret" }] },
];

const markets = [
  { symbol: "BTC", name: "Bitcoin", maker: null, taker: null, score: null, group: "", color: "#f7931a" },
  { symbol: "ETH", name: "Ethereum", maker: null, taker: null, score: null, group: "", color: "#627eea" },
  { symbol: "SOL", name: "Solana", maker: null, taker: null, score: null, group: "", color: "#9b7bff" },
  { symbol: "XRP", name: "XRP", maker: null, taker: null, score: null, group: "", color: "#d8dee9" },
  { symbol: "DOGE", name: "Dogecoin", maker: null, taker: null, score: null, group: "", color: "#d6ab4e" },
  { symbol: "ADA", name: "Cardano", maker: null, taker: null, score: null, group: "", color: "#4977d1" },
  { symbol: "LINK", name: "Chainlink", maker: null, taker: null, score: null, group: "", color: "#375bd2" },
  { symbol: "AVAX", name: "Avalanche", maker: null, taker: null, score: null, group: "", color: "#e84142" },
  { symbol: "SUI", name: "Sui", maker: null, taker: null, score: null, group: "", color: "#63b4f4" },
  { symbol: "NEAR", name: "Near", maker: null, taker: null, score: null, group: "", color: "#d8dee9" },
];

const coinLogos: Record<string, string> = {
  BTC: "./coins/btc.png", ETH: "./coins/eth.png", SOL: "./coins/sol.png",
  XRP: "./coins/xrp.png", DOGE: "./coins/doge.png", ADA: "./coins/ada.png",
  LINK: "./coins/link.png", AVAX: "./coins/avax.png", SUI: "./coins/sui.png",
  NEAR: "./coins/near.png", BNB: "./coins/bnb.png", TRX: "./coins/trx.png",
  HYPE: "./coins/hype.jpg", ZEC: "./coins/zec.png", LEO: "./coins/leo.png",
  XMR: "./coins/xmr.png", XLM: "./coins/xlm.jpg", BCH: "./coins/bch.png",
  TON: "./coins/ton.png", LTC: "./coins/ltc.png", HBAR: "./coins/hbar.png",
  SHIB: "./coins/shib.png",
};

const topAltcoins = ["ETH", "BNB", "XRP", "SOL", "TRX", "HYPE", "ZEC", "DOGE", "LINK", "LEO", "XMR", "ADA", "XLM", "BCH", "TON", "LTC", "HBAR", "SUI", "AVAX", "SHIB"];
const topAltcoinRank = new Map(topAltcoins.map((symbol, index) => [symbol, index]));

function marketMeta(symbol: string) {
  return markets.find((item) => item.symbol === symbol) || { symbol, name: symbol, maker: null, taker: null, score: null, group: "", color: "#9da49f" };
}

function isExchangeConfigured(id: ExchangeId, values: Record<string, string> | undefined) {
  if (!values) return false;
  if (isManualConnection(id, values)) return Boolean(values.undetectableProfileId?.trim());
  if (id === "mexc" && values.connectionMode === "sdk") return Boolean(values.authorization?.trim());
  const base = Boolean(values.apiKey?.trim() && values.secret?.trim());
  return id === "okx" || id === "bitget" ? base && Boolean(values.passphrase?.trim()) : base;
}
function isManualConnection(id: ExchangeId, values?: Record<string, string>) { return id === 'lbank' && values?.connectionMode === 'undetectable'; }

export function HedgeTerminal() {
  const [tab, setTab] = useState<Tab>("status");
  const [connectOpen, setConnectOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("exchanges");
  const [source, setSource] = useState<ExchangeId>("binance");
  const [target, setTarget] = useState<ExchangeId>("lbank");
  const [enabledExchanges, setEnabledExchanges] = useState<ExchangeId[]>([]);
  const [connectedExchanges, setConnectedExchanges] = useState<ExchangeId[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [editingExchange, setEditingExchange] = useState<ExchangeId | null>(null);
  const [editingSaving, setEditingSaving] = useState(false);
  const [editingError, setEditingError] = useState("");
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>({});
  const [connected, setConnected] = useState(false);
  const [accounts, setAccounts] = useState<Record<string, { available: number; total: number; rawUpdatedAt?: number }>>({});
  const [accountLatency, setAccountLatency] = useState<number | null>(null);
  const [accountSyncAt, setAccountSyncAt] = useState<number | null>(null);
  const [accountSyncing, setAccountSyncing] = useState(false);
  const [hedgeStep, setHedgeStep] = useState<HedgeStep>("market");
  const [selected, setSelected] = useState<string[]>(["SOL", "XRP", "DOGE", "LINK"]);
  const [margin, setMargin] = useState(100);
  const [leverageByCoin, setLeverageByCoin] = useState<Record<string, number>>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [tradePending, setTradePending] = useState(false);
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot>({ exchanges: {}, receivedAt: 0 });
  const lastTradeNotice = useRef("");
  const shownTradingRun = useRef("");
  const [orders, setOrders] = useState(8);
  const [delay, setDelay] = useState(3);
  const [leverage, setLeverage] = useState(25);
  const [marginMode, setMarginMode] = useState<"isolated" | "cross">("isolated");
  const [hedgePercent, setHedgePercent] = useState(98); const [maxLosses, setMaxLosses] = useState(5);
  const [running, setRunning] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopPendingMode,setStopPendingMode]=useState<StopMode|null>(null);
  const [stopError,setStopError]=useState('');
  const stopInFlight=useRef<{id:number;mode:StopMode}|null>(null);
  const stopRequestId=useRef(0);
  const tradingNotifications=useRef(createTradingNotifications());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [liveMarkets, setLiveMarkets] = useState<Record<string, { price: number; change: number; funding: number; volume: number }>>({});
  const [availableMarkets, setAvailableMarkets] = useState<CommonMarket[]>([]);
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<number | null>(null);
  const [updateChannel, setUpdateChannel] = useState<"beta" | "stable">("stable");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  // User-started hedges are live; legacy saved simulation flags must not override this mode.
  const liveTradingEnabled = true;
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [licenseKey, setLicenseKey] = useState("");
  const [profileName, setProfileName] = useState("Trader");
  const [isAdmin, setIsAdmin] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [startupUpdate, setStartupUpdate] = useState<UpdateStatus>({ state: "checking" });
  const [startupUpdateVisible, setStartupUpdateVisible] = useState(true);
  const [licenseStatus, setLicenseStatus] = useState<{ state: "idle" | "checking" | "valid" | "invalid"; message?: string; expiresAt?: string | null; userCode?: string | null }>({ state: "idle" });
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState("");
  const [tradeState, setTradeState] = useState("idle");
  const [tradeSnapshot, setTradeSnapshot] = useState<TradeSnapshot>({ state: "idle", active: false });
  const tradeSnapshotRef = useRef<TradeSnapshot>({ state: "idle", active: false });
  const [tradeError, setTradeError] = useState("");
  const [sendingLogs, setSendingLogs] = useState(false);
  const notificationAudio = useRef<HTMLAudioElement | null>(null);
  const warningAudio = useRef<HTMLAudioElement | null>(null);
  const backgroundErrorAudio = useRef<HTMLAudioElement | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const soundsEnabledRef = useRef(true);
  const startupUpdateActive = useRef(true);
  const updateInstallTriggered = useRef(false);

  useEffect(() => {
    soundsEnabledRef.current = soundsEnabled;
    if (!soundsEnabled) {
      [notificationAudio.current, warningAudio.current, backgroundErrorAudio.current].forEach((audio) => { if (audio) { audio.loop = false; audio.pause(); audio.currentTime = 0; } });
    }
  }, [soundsEnabled]);

  useEffect(() => {
    notificationAudio.current = new Audio("./sounds/notification.mp3");
    warningAudio.current = new Audio("./sounds/warning.mp3");
    backgroundErrorAudio.current = new Audio("./sounds/background-error.mp3");
    notificationAudio.current.volume = .41;
    warningAudio.current.volume = .48;
    backgroundErrorAudio.current.volume = .36;
    const userReturned = () => { if (backgroundErrorAudio.current) backgroundErrorAudio.current.loop = false; };
    const visibilityChanged = () => { if (!document.hidden) userReturned(); };
    window.addEventListener("focus", userReturned);
    window.addEventListener("pointermove", userReturned, { passive: true });
    window.addEventListener("pointerdown", userReturned, { passive: true });
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("focus", userReturned);
      window.removeEventListener("pointermove", userReturned);
      window.removeEventListener("pointerdown", userReturned);
      document.removeEventListener("visibilitychange", visibilityChanged);
      [notificationAudio.current, warningAudio.current, backgroundErrorAudio.current].forEach((audio) => audio?.pause());
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  function notify(kind: Notice["kind"], message: string) {
    setNotice({ id: Date.now(), kind, message });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === "success" ? 3200 : 5200);
    if (!soundsEnabledRef.current) return;
    const outside = document.hidden || !document.hasFocus();
    const audio = kind === "success" ? notificationAudio.current : outside ? backgroundErrorAudio.current : warningAudio.current;
    if (!audio) return;
    if (audio === backgroundErrorAudio.current) audio.loop = true;
    else { audio.loop = false; audio.currentTime = 0; }
    audio.play().catch(() => {});
  }

  async function autoConnectExchanges(exchangeIds: ExchangeId[], activeSource: ExchangeId, activeTarget: ExchangeId, credentialsSnapshot: Record<string, Record<string, string>>, shouldApply: () => boolean = () => true) {
    const desktop = window.hedgeDesktop;
    if (!desktop) return;
    const requested = [...new Set(exchangeIds)].filter((id) => exchanges.some((exchange) => exchange.id === id) && !isManualConnection(id, credentialsSnapshot[id]));
    setEnabledExchanges(current => current.filter(id => !isManualConnection(id, credentialsSnapshot[id])));
    const configured = requested.filter((id) => isExchangeConfigured(id, credentialsSnapshot[id]));
    const missing = requested.filter((id) => !configured.includes(id));
    if (!configured.length) {
      if (!shouldApply()) return;
      setConnectedExchanges([]);
      setAccounts({});
      setConnected(false);
      if (missing.length) notify("warning", `Нужны API-ключи: ${missing.map((id) => exchanges.find((exchange) => exchange.id === id)?.name || id).join(", ")}`);
      return;
    }
    const connectionResults = await desktop.testExchanges(configured);
    if (!shouldApply()) return;
    const successful = configured.filter((id) => connectionResults[id]?.ok && connectionResults[id]?.account);
    const nextAccounts = Object.fromEntries(successful.map((id) => [id, connectionResults[id].account!])) as Record<string, { available: number; total: number; rawUpdatedAt?: number }>;
    setConnectedExchanges(successful);
    setAccounts(nextAccounts);
    setConnected(successful.includes(activeSource) && successful.includes(activeTarget));
    if (successful.length) {
      setAccountLatency(Math.max(...successful.map((id) => connectionResults[id].latency || 0)));
      setAccountSyncAt(Date.now());
    }
    const failed = configured.filter((id) => !connectionResults[id]?.ok);
    const successfulNames = successful.map((id) => exchanges.find((exchange) => exchange.id === id)?.name || id).join(", ");
    const failedNames = [...failed, ...missing].map((id) => exchanges.find((exchange) => exchange.id === id)?.name || id).join(", ");
    if (successful.length && failedNames) notify("warning", `Подключены: ${successfulNames}. Проверьте: ${failedNames}`);
    // Successful automatic connections are already visible in account status.
    else if (failedNames) notify("error", `Не подключены: ${failedNames}`);
  }

  useEffect(() => {
    if (!window.hedgeDesktop && new URLSearchParams(window.location.search).has("login")) setAuthState("signed_out");
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      const desktop = window.hedgeDesktop;
      if (!desktop) {
        if (active) {
          startupUpdateActive.current = false;
          setStartupUpdateVisible(false);
          setAuthState(new URLSearchParams(window.location.search).has("login") ? "signed_out" : "signed_in");
        }
        return;
      }
      const [settings, storedCredentials] = await Promise.all([desktop.loadSettings(), desktop.loadCredentials()]);
      if (!active) return;
      if (settings) {
        if (Array.isArray(settings.selected)) setSelected(settings.selected as string[]);
        if (typeof settings.margin === "number") setMargin(settings.margin);
        if (typeof settings.orders === "number") setOrders(settings.orders);
        if (typeof settings.delay === "number") setDelay(settings.delay);
        if (typeof settings.leverage === "number") setLeverage(settings.leverage);
        if (settings.leverageByCoin && typeof settings.leverageByCoin === "object") setLeverageByCoin(settings.leverageByCoin as Record<string, number>);
        setMarginMode(settings.marginMode === "cross" ? "cross" : "isolated");
        if (typeof settings.hedgePercent === "number") setHedgePercent(settings.hedgePercent); if (Number.isSafeInteger(settings.maxLosses) && Number(settings.maxLosses) >= 0) setMaxLosses(Number(settings.maxLosses));
        if (typeof settings.source === "string") setSource(settings.source as ExchangeId);
        if (typeof settings.target === "string") setTarget(settings.target as ExchangeId);
        if (Array.isArray(settings.enabledExchanges)) setEnabledExchanges(settings.enabledExchanges as ExchangeId[]);
        if (settings.updateChannel === "stable" || settings.updateChannel === "beta") setUpdateChannel(settings.updateChannel);
        if (typeof settings.autoUpdate === "boolean") setAutoUpdate(settings.autoUpdate);
        if (typeof settings.launchOnStartup === "boolean") setLaunchOnStartup(settings.launchOnStartup);
        if (typeof settings.soundsEnabled === "boolean") setSoundsEnabled(settings.soundsEnabled);
        if (typeof settings.profileName === "string") setProfileName(settings.profileName);
      }
      setSettingsLoaded(true);
      if (storedCredentials) setCredentials(storedCredentials);
      const rawStoredUrl = typeof settings?.serverUrl === "string" ? settings.serverUrl.trim() : "";
      const storedUrl = !rawStoredUrl || /^http:\/\/(?:127\.0\.0\.1|localhost):8000\/?$/i.test(rawStoredUrl)
        ? DEFAULT_SERVER_URL
        : rawStoredUrl;
      setServerUrl(storedUrl);
      const bootUpdateChannel = settings?.updateChannel === "beta" ? "beta" : "stable";
      const bootAutoUpdate = settings?.autoUpdate !== false;
      const bootLaunchOnStartup = settings?.launchOnStartup === true;
      try {
        const status = await desktop.configureUpdates({ channel: bootUpdateChannel, serverUrl: storedUrl, autoUpdate: bootAutoUpdate, launchOnStartup: bootLaunchOnStartup });
        if (active) {
          setUpdateStatus(status);
          setStartupUpdate(status);
        }
      } catch (error) {
        if (active) setStartupUpdate({ state: "error", message: error instanceof Error ? error.message : String(error) });
      }
      const storedKey = typeof storedCredentials?.profile?.licenseKey === "string" ? storedCredentials.profile.licenseKey : "";
      setLicenseKey(storedKey);
      if (!storedKey) { setAuthState("signed_out"); return; }
      const result = await desktop.verifyProfile({ serverUrl: storedUrl, licenseKey: storedKey });
      if (!active) return;
      if (result.ok) {
        setIsAdmin(result.profile?.isAdmin === true);
        setLicenseStatus({ state: "valid", message: result.profile?.isAdmin ? "Admin-доступ" : "Ключ активен", expiresAt: result.profile?.expiresAt, userCode: result.profile?.userCode });
        setAuthState("signed_in");
        const storedSource = (typeof settings?.source === "string" ? settings.source : "binance") as ExchangeId;
        const storedTarget = (typeof settings?.target === "string" ? settings.target : "lbank") as ExchangeId;
        const configured = Array.isArray(settings?.enabledExchanges)
          ? settings.enabledExchanges as ExchangeId[]
          : [storedSource, storedTarget];
        await autoConnectExchanges(configured, storedSource, storedTarget, storedCredentials || {}, () => active);
      } else {
        setIsAdmin(false);
        setAuthError(result.error || "Не удалось восстановить сессию");
        setAuthState("signed_out");
      }
    }
    boot().catch((error) => { if (active) { setAuthError(error instanceof Error ? error.message : String(error)); setAuthState("signed_out"); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let pending = false;
    setAvailableMarkets([]);
    const refresh = async () => {
      if (pending || !window.hedgeDesktop?.getExchangeMarkets || authState !== "signed_in") return;
      pending = true;
      try {
        const [items, common] = await Promise.all([window.hedgeDesktop.getExchangeMarkets(source), window.hedgeDesktop.getCommonMarkets(source, target)]);
        if (!active) return;
        setAvailableMarkets(common);
        const next: Record<string, { price: number; change: number; funding: number; volume: number }> = {};
        items.forEach((item) => {
          const open = item.open24h || item.lastPrice;
          next[item.symbol] = { price: item.lastPrice, change: open ? ((item.lastPrice - open) / open) * 100 : 0, funding: item.fundingRate, volume: item.turnover24h };
        });
        setLiveMarkets(next);
        setMarketUpdatedAt(Date.now());
      } catch { } finally { pending = false; }
    };
    refresh();
    const timer = window.setInterval(refresh, 6_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [source, target, authState]);

  useEffect(() => window.hedgeDesktop?.onUpdateStatus?.((status) => {
    setUpdateStatus(status);
    if (startupUpdateActive.current) setStartupUpdate(status);
    else if (status.state === "error") notify("error", status.message || "Ошибка обновления приложения");
  }) || undefined, []);

  useEffect(() => {
    if (!startupUpdateVisible) return;
    if (["current", "development", "not-configured"].includes(startupUpdate.state)) {
      const timer = window.setTimeout(() => {
        startupUpdateActive.current = false;
        setStartupUpdateVisible(false);
      }, 420);
      return () => window.clearTimeout(timer);
    }
    if (startupUpdate.state === "ready" && autoUpdate && !updateInstallTriggered.current) {
      updateInstallTriggered.current = true;
      const timer = window.setTimeout(() => {
        setStartupUpdate((current) => ({ ...current, state: "restarting" }));
        window.hedgeDesktop?.installUpdate();
      }, 900);
      return () => window.clearTimeout(timer);
    }
  }, [startupUpdate.state, startupUpdateVisible, autoUpdate]);
  useEffect(() => {
    const apply = (status: TradeSnapshot) => {
      const alert = tradingNotifications.current(status);
      status=applyTradingSnapshot(status);
      if (alert) notify(alert.kind, alert.message);
      const key = `${status.id}:${status.state}:${status.error || ""}`;
      if (key !== lastTradeNotice.current) {
        if (status.error) { setTradeError(status.error); }
        else setTradeError("");
        if (status.state === "monitoring" && status.id && shownTradingRun.current !== status.id) { shownTradingRun.current = status.id; setTab("status"); }
        lastTradeNotice.current = key;
      }
    };
    const dispose = window.hedgeDesktop?.onTradingState?.(apply);
    if (authState === "signed_in") window.hedgeDesktop?.getTradingState?.().then(apply).catch((error) => { setTradeError(error.message); notify("error", error.message); });
    return dispose;
  }, [authState]);

  useEffect(()=>{
    if(!running && (source==='lbank'||target==='lbank') && marginMode!=='isolated')setMarginMode('isolated');
  },[source,target,marginMode,running]);

  useEffect(() => {
    if (!settingsLoaded || authState !== "signed_in") return;
    const timer = setTimeout(() => {
      window.hedgeDesktop?.saveSettings({ source, target, selected, margin, leverageByCoin, leverage, hedgePercent, marginMode, maxLosses }).catch((error) => notify("error", error.message));
    }, 500);
    return () => clearTimeout(timer);
  }, [settingsLoaded, authState, source, target, selected, margin, leverageByCoin, leverage, hedgePercent, marginMode, maxLosses]);

  useEffect(() => {
    if (authState !== "signed_in" || !window.hedgeDesktop?.configureAccounts) return;
    let active = true;
    const apply = (value: PortfolioSnapshot) => {
      if (!active) return;
      setPortfolio(value);
      const ids = Object.keys(value.exchanges) as ExchangeId[];
      setAccounts(Object.fromEntries(ids.filter((id) => value.exchanges[id].account).map((id) => [id, value.exchanges[id].account!])));
      const live = ids.filter((id) => value.exchanges[id].account && !value.exchanges[id].errors?.account && Date.now() - (value.exchanges[id].accountUpdatedAt || 0) < 5000);
      setConnectedExchanges(live);
      setConnected(live.includes(source) && live.includes(target));
    };
    const dispose = window.hedgeDesktop.onAccountSnapshot(apply);
    window.hedgeDesktop.configureAccounts(enabledExchanges.filter((id) => isExchangeConfigured(id, credentials[id]))).then(apply).catch((error) => notify("error", error.message));
    return () => { active = false; dispose(); };
  }, [authState, source, target, enabledExchanges, credentials]);

  async function connect() {
    setConnecting(true);
    setConnectionError("");
    try {
      if (!window.hedgeDesktop) throw new Error("Подключение к биржам доступно только в Electron-приложении");
      await window.hedgeDesktop.saveCredentials(credentials);
      const configured = [...new Set<ExchangeId>([source, target, ...enabledExchanges])];
      await window.hedgeDesktop.saveSettings({ source, target, enabledExchanges: configured, selected, margin, orders, delay, leverage, leverageByCoin, hedgePercent, marginMode, maxLosses, updateChannel, autoUpdate, launchOnStartup, soundsEnabled, liveTradingEnabled, serverUrl, profileName });
      const startedAt = performance.now();
      const results = await window.hedgeDesktop.testExchanges(configured);
      for (const id of configured.filter(id => isManualConnection(id, credentials[id]))) results[id] = await window.hedgeDesktop.testExchange(id);
      const requiredFailure = [source, target].map((id) => results[id]).find((result) => !result?.ok || !result.account);
      if (requiredFailure) throw new Error(requiredFailure?.error || "Основная пара не вернула futures-баланс");
      const successful = configured.filter((id) => results[id]?.ok && results[id]?.account);
      setAccounts(Object.fromEntries(successful.map((id) => [id, results[id].account!])));
      setEnabledExchanges(configured);
      setConnectedExchanges(successful);
      setAccountLatency(Math.round(performance.now() - startedAt));
      setAccountSyncAt(Date.now());
      setConnected(true); setConnectOpen(false); setTab("status");
      const failedExtras = configured.filter((id) => !results[id]?.ok && id !== source && id !== target);
      notify(failedExtras.length ? "warning" : "success", failedExtras.length ? `Основная пара подключена; проверьте: ${failedExtras.join(", ")}` : `Подключено бирж: ${successful.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionError(message);
      notify("error", message);
    } finally {
      setConnecting(false);
    }
  }

  function saveSettings(goToReady = true) {
    window.hedgeDesktop?.saveSettings({ source, target, enabledExchanges, selected, margin, orders, delay, leverage, leverageByCoin, hedgePercent, marginMode, maxLosses, updateChannel, autoUpdate, launchOnStartup, soundsEnabled, liveTradingEnabled, serverUrl, profileName });
    window.hedgeDesktop?.saveCredentials({ ...credentials, profile: { licenseKey } });
    window.hedgeDesktop?.configureUpdates({ channel: updateChannel, serverUrl, autoUpdate, launchOnStartup });
    if (goToReady) setHedgeStep("ready");
    notify("success", "Настройки сохранены");
  }

  async function sendSupportLogs() {
    if (!window.hedgeDesktop || sendingLogs) return;
    setSendingLogs(true);
    try {
      const result = await window.hedgeDesktop.sendLogs();
      if (!result.ok) throw new Error(result.error || "Не удалось отправить логи");
      notify("success", `Логи отправлены · ${Math.max(1, Math.ceil(Number(result.bytes || 0) / 1024))} КБ`);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally { setSendingLogs(false); }
  }

  async function retryStartupUpdate() {
    if (!window.hedgeDesktop) return;
    updateInstallTriggered.current = false;
    setStartupUpdate({ state: "checking" });
    try {
      const status = await window.hedgeDesktop.configureUpdates({ channel: updateChannel, serverUrl, autoUpdate, launchOnStartup });
      setStartupUpdate(status);
    } catch (error) {
      setStartupUpdate({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function downloadStartupUpdate() {
    setStartupUpdate((current) => ({ ...current, state: "downloading", percent: 0 }));
    try { await window.hedgeDesktop?.downloadUpdate(); }
    catch (error) { setStartupUpdate({ state: "error", message: error instanceof Error ? error.message : String(error) }); }
  }

  function continueWithoutUpdate() {
    startupUpdateActive.current = false;
    setStartupUpdateVisible(false);
  }

  async function refreshAccounts(showError = true) {
    if (!window.hedgeDesktop?.refreshAccounts || accountSyncing) return;
    setAccountSyncing(true);
    try { setPortfolio(await window.hedgeDesktop.refreshAccounts()); }
    catch (error) { if (showError) notify("error", error instanceof Error ? error.message : String(error)); }
    finally { setAccountSyncing(false); }
  }

  async function verifyLicense() {
    setLicenseStatus({ state: "checking" });
    try {
      if (!window.hedgeDesktop) throw new Error("Проверка доступна в desktop-приложении");
      await window.hedgeDesktop.saveCredentials({ ...credentials, profile: { licenseKey } });
      const result = await window.hedgeDesktop.verifyProfile({ serverUrl, licenseKey });
      if (!result.ok) throw new Error(result.error || "Ключ не прошёл проверку");
      setLicenseStatus({ state: "valid", message: result.profile?.isAdmin ? "Admin-доступ" : "Ключ активен", expiresAt: result.profile?.expiresAt, userCode: result.profile?.userCode });
      setIsAdmin(result.profile?.isAdmin === true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLicenseStatus({ state: "invalid", message });
      notify("error", message);
    }
  }

  function persistEnabledExchanges(next: ExchangeId[]) {
    const normalized = [...new Set(next)].filter((id) => exchanges.some((exchange) => exchange.id === id));
    setEnabledExchanges(normalized);
    window.hedgeDesktop?.saveSettings({ source, target, enabledExchanges: normalized, selected, margin, orders, delay, leverage, leverageByCoin, hedgePercent, marginMode, maxLosses, updateChannel, autoUpdate, launchOnStartup, soundsEnabled, liveTradingEnabled, serverUrl, profileName });
    return normalized;
  }

  async function toggleExchangeConnection(id: ExchangeId) {
    if (running && (id === source || id === target)) { notify("warning", "Сначала остановите активный хедж"); return; }
    const configured = isExchangeConfigured(id, credentials[id]);
    const active = configured && enabledExchanges.includes(id) && (!isManualConnection(id, credentials[id]) || connectedExchanges.includes(id));
    if (active) {
      await window.hedgeDesktop?.disconnectExchange(id);
      persistEnabledExchanges(enabledExchanges.filter((exchangeId) => exchangeId !== id));
      const nextConnected = connectedExchanges.filter((exchangeId) => exchangeId !== id);
      setConnectedExchanges(nextConnected);
      setConnected(nextConnected.includes(source) && nextConnected.includes(target));
      setAccounts((current) => { const next = { ...current }; delete next[id]; return next; });
      notify("success", `${exchanges.find((exchange) => exchange.id === id)?.name} отключена`);
      return;
    }
    if (!configured) { setEditingError(""); setEditingExchange(id); return; }
    const result = await window.hedgeDesktop?.testExchange(id);
    if (!result?.ok || !result.account) { setEditingError(result?.error || "Биржа не ответила"); setEditingExchange(id); return; }
    persistEnabledExchanges([...enabledExchanges, id]);
    setAccounts((current) => ({ ...current, [id]: result.account! }));
    const nextConnected = [...new Set<ExchangeId>([...connectedExchanges, id])];
    setConnectedExchanges(nextConnected);
    setConnected(nextConnected.includes(source) && nextConnected.includes(target));
    notify("success", `${exchanges.find((exchange) => exchange.id === id)?.name} подключена`);
  }

  async function saveEditedExchange() {
    if (!editingExchange || editingSaving || !window.hedgeDesktop) return;
    setEditingSaving(true); setEditingError("");
    try {
      await window.hedgeDesktop.saveCredentials(credentials);
      const result = await window.hedgeDesktop.testExchange(editingExchange);
      if (!result.ok || !result.account) throw new Error(result.error || "Биржа не вернула futures-баланс");
      const nextEnabled = persistEnabledExchanges([...enabledExchanges, editingExchange]);
      setAccounts((current) => ({ ...current, [editingExchange]: result.account! }));
      const nextConnected = [...new Set<ExchangeId>([...connectedExchanges, editingExchange])];
      setConnectedExchanges(nextConnected);
      setConnected(nextEnabled.includes(source) && nextEnabled.includes(target) && nextConnected.includes(source) && nextConnected.includes(target));
      notify("success", `${exchanges.find((exchange) => exchange.id === editingExchange)?.name} подключена и сохранена`);
      setEditingExchange(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEditingError(message); notify("error", message);
    } finally { setEditingSaving(false); }
  }

  async function login() {
    if (authPending) return;
    setAuthPending(true);
    setAuthError("");
    try {
      const desktop = window.hedgeDesktop;
      if (!desktop) { setAuthState("signed_in"); return; }
      const nextCredentials = { ...credentials, profile: { licenseKey } };
      const result = await desktop.verifyProfile({ serverUrl, licenseKey });
      if (!result.ok) throw new Error(result.error || "Ключ не прошёл проверку");
      await Promise.all([
        desktop.saveCredentials(nextCredentials),
        desktop.saveSettings({ source, target, enabledExchanges, selected, margin, orders, delay, leverage, leverageByCoin, hedgePercent, marginMode, maxLosses, updateChannel, autoUpdate, launchOnStartup, soundsEnabled, liveTradingEnabled, serverUrl, profileName }),
      ]);
      setCredentials(nextCredentials);
      setLicenseStatus({ state: "valid", message: result.profile?.isAdmin ? "Admin-доступ" : "Ключ активен", expiresAt: result.profile?.expiresAt, userCode: result.profile?.userCode });
      setIsAdmin(result.profile?.isAdmin === true);
      setAuthState("signed_in");
      await autoConnectExchanges(enabledExchanges, source, target, nextCredentials);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = /failed to fetch|fetch failed|networkerror/i.test(rawMessage)
        ? "Сервер авторизации недоступен"
        : rawMessage;
      setAuthError(message);
      notify("error", message);
    } finally { setAuthPending(false); }
  }

  async function logout() {
    if (running) { notify("warning", "Сначала остановите активный хедж"); return; }
    const { profile: _profile, ...exchangeCredentials } = credentials;
    await Promise.all([window.hedgeDesktop?.logoutProfile(), window.hedgeDesktop?.saveCredentials(exchangeCredentials)]);
    setCredentials(exchangeCredentials);
    setLicenseKey("");
    setLicenseStatus({ state: "idle" });
    setIsAdmin(false);
    setTab("status");
    setConnected(false);
    setAuthState("signed_out");
  }

  async function startTrading(acceptImpact = false) {
    if (tradePending || running) return;
    setTradePending(true); setTradeError("");
    try {
      if (!window.hedgeDesktop) throw new Error("Торговля доступна только в desktop-приложении");
      const symbols = selected.map((symbol) => `${symbol}USDT`);
      if (!symbols.length) throw new Error("Выберите монеты из общих рынков двух бирж");
      const protectedMarginMode=source==='lbank'||target==='lbank'?'isolated':marginMode;
      const protectedMaxLeverage=source==='lbank'||target==='lbank'?20:125;
      const protectedLeverageByCoin=Object.fromEntries(Object.entries(leverageByCoin).map(([symbol,value])=>[symbol,Math.min(value,protectedMaxLeverage)]));
      await window.hedgeDesktop.saveSettings({ source, target, selected, margin, leverageByCoin:protectedLeverageByCoin, hedgePercent, marginMode:protectedMarginMode, maxLosses });
      const result = await window.hedgeDesktop.startTrading({ source, target, symbols, totalMargin: margin, leverageBySymbol: Object.fromEntries(selected.map((symbol) => [`${symbol}USDT`, Math.min(protectedMaxLeverage,protectedLeverageByCoin[symbol] ?? Math.max(1, Math.round(leverage / 10)))])), hedgePercent, marginMode:protectedMarginMode, maxLosses, acceptImpact, dryRun: false, liveConfirmation: "LIVE_TRADING_CONFIRMED" });
      if (!result.ok) throw new Error(result.error || "Не удалось запустить цикл");
      if (result.snapshot) applyTradingSnapshot(result.snapshot);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setTradeError(message); notify("error", message); }
    finally { setTradePending(false); }
  }

  function applyTradingSnapshot(snapshot: TradeSnapshot) {
    const status = { ...snapshot, ...tradeFeedback(snapshot) };
    if (botIsStopped(status)) { status.state = 'stopped'; status.active = false; status.botStopped = true; }
    tradeSnapshotRef.current = status;
    setTradeSnapshot(status); setTradeState(status.state); setRunning(status.active);
    setTradeError(status.error || '');
    return status;
  }

  function openStopDialog() {
    if (botIsStopped(tradeSnapshotRef.current)) { setStopError(''); setStopOpen(true); return; }
    void requestStop('pause');
  }

  async function requestStop(mode: StopMode) {
    // Taking manual control always supersedes an exchange close still in flight.
    if(stopInFlight.current && (mode !== 'app-only' || stopInFlight.current.mode === 'app-only')) return;
    const requestId=++stopRequestId.current;
    stopInFlight.current={id:requestId,mode};setStopPendingMode(mode);setStopError('');
    try {
      if(!window.hedgeDesktop)throw new Error('Остановка доступна в desktop-приложении');
      // Send the local pause on the first click, before asking about positions.
      const response = window.hedgeDesktop.stopTrading(mode);
      setStopOpen(true);
      const result = await response;
      if(requestId!==stopRequestId.current)return;
      if(result.snapshot)applyTradingSnapshot(result.snapshot);
      else if(result.botStopped)applyTradingSnapshot({...tradeSnapshotRef.current,botStopped:true,active:false,state:'stopped'});
      const stopped=botIsStopped(tradeSnapshotRef.current);
      if (mode === 'market') {
        const status=tradeSnapshotRef.current;
        const confirmedClosed=status.state==='idle'||status.closeStatus==='closed';
        if (!result.ok || status.closeStatus === 'failed' || status.closeStatus === 'waiting_confirmation') {
          const message=result.error || status.closeError || 'Биржа ещё не подтвердила закрытие. Позиции и заявки могут оставаться открытыми.';
          if(stopped)applyTradingSnapshot({...status,closeError:message});
          setStopError(message);
          notify('warning',`${stopped?'Бот остановлен. ':''}Закрытие не подтверждено: ${message}`);
          return;
        }
        if(status.closeStatus === 'closing')return;
        if(!confirmedClosed) {
          setStopError('Биржа ещё не подтвердила закрытие. Позиции и заявки могут оставаться открытыми.');
          return;
        }
        notify('success','Все позиции и заявки сессии закрыты');
      } else if(!result.ok || !stopped) {
        throw new Error(result.error || 'Не получено подтверждение локальной остановки. Повторите Стоп.');
      }
      setTradeError('');
      if(mode!=='pause')setStopOpen(false);
    }catch(error){
      if(requestId!==stopRequestId.current)return;
      const message=error instanceof Error?error.message:String(error);
      setStopOpen(true);setStopError(message);
      if(mode==='market' && botIsStopped(tradeSnapshotRef.current)) {
        applyTradingSnapshot({...tradeSnapshotRef.current,closeStatus:'failed',closeError:message});
        notify('warning',`Бот остановлен. Закрытие не подтверждено: ${message}`);
      } else notify('warning',message);
    }
    finally{if(requestId===stopRequestId.current){stopInFlight.current=null;setStopPendingMode(null);}}
  }

  return (
    <Tooltip.Provider delayDuration={250}>
      <main className="app-shell">
        <div className="market-backdrop" style={{ backgroundImage: "url('./art/market-depth-bg.png')" }} />
        <Titlebar />
        {startupUpdateVisible ? <StartupUpdateScreen status={startupUpdate} autoUpdate={autoUpdate} onRetry={retryStartupUpdate} onDownload={downloadStartupUpdate} onInstall={() => { setStartupUpdate((current) => ({ ...current, state: "restarting" })); window.hedgeDesktop?.installUpdate(); }} onContinue={continueWithoutUpdate} /> : authState !== "signed_in" ? <AuthScreen pending={authPending || authState === "checking"} serverReady={Boolean(serverUrl)} licenseKey={licenseKey} setLicenseKey={setLicenseKey} error={authError} onLogin={login} /> : <>
        <div className="app-body">
          <Sidebar tab={tab} setTab={setTab} connected={connected} isAdmin={isAdmin} source={source} target={target} enabledExchanges={enabledExchanges} connectedExchanges={connectedExchanges} accounts={accounts} credentials={credentials} onEditExchange={(id) => { setEditingError(""); setEditingExchange(id); }} onToggleExchange={toggleExchangeConnection} onEditPair={() => { setSetupStep("exchanges"); setConnectOpen(true); }} />
          <section className="content-shell">
            <div key={tab} className="content-view view-enter">
                {tab === "settings" ? <SettingsView marginMode={marginMode} setMarginMode={setMarginMode} maxLosses={maxLosses} setMaxLosses={setMaxLosses} tradingActive={running} resetLossLimit={isAdmin && (tradeSnapshot.state === "loss_limit" || tradeSnapshot.lossLimitReached) ? async () => { try { const state = await window.hedgeDesktop?.resetLossLimit(); if (state) setTradeSnapshot(state); } catch (e) { notify("error", e instanceof Error ? e.message : String(e)); } } : undefined} updateChannel={updateChannel} setUpdateChannel={setUpdateChannel} autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate} launchOnStartup={launchOnStartup} setLaunchOnStartup={setLaunchOnStartup} soundsEnabled={soundsEnabled} setSoundsEnabled={setSoundsEnabled} serverUrl={serverUrl} setServerUrl={setServerUrl} licenseKey={licenseKey} setLicenseKey={setLicenseKey} licenseStatus={licenseStatus} onVerifyLicense={verifyLicense} profileName={profileName} setProfileName={setProfileName} updateStatus={updateStatus} onSave={() => saveSettings(false)} onLogout={logout} sendingLogs={sendingLogs} onSendLogs={sendSupportLogs} onOpenTelegram={() => window.hedgeDesktop?.openTelegram()} /> : tab === "users" && isAdmin ? <UsersView notify={notify} /> : tab === "status" ? (
                  Object.keys(portfolio.exchanges).length || tradeSnapshot.active || botIsStopped(tradeSnapshot) || canManageStoppedTrade(tradeSnapshot) ? <AccountStatus source={source} target={target} exchanges={exchanges} portfolio={portfolio} trade={tradeSnapshot} onRefresh={() => refreshAccounts(true)} onStop={openStopDialog} onHedge={() => setTab("hedge")} onExchangeClick={(id) => {
                    if (running) { notify("warning", "Пара закреплена за активным хеджем"); return; }
                    if (id === source || id === target) { setSetupStep("exchanges"); setConnectOpen(true); }
                    else { setEditingError(""); setEditingExchange(id as ExchangeId); }
                  }} /> : <EmptyStatus onConnect={() => setConnectOpen(true)} />
                ) : tab === "history" ? <TradingHistoryView exchanges={exchanges} /> : (
                  <AutomatedHedge configured={[source, target].every(id => isExchangeConfigured(id, credentials[id]) && (!isManualConnection(id, credentials[id]) || connectedExchanges.includes(id)))} source={source} target={target} exchanges={exchanges} connected={connected} available={Math.min(accounts[source]?.available || 0, accounts[target]?.available || 0)}
                    selected={selected} setSelected={setSelected} margin={margin} setMargin={setMargin} leverages={leverageByCoin} setLeverages={setLeverageByCoin} defaultLeverage={Math.max(1, Math.round(leverage / 10))}
                    hedgePercent={hedgePercent} setHedgePercent={setHedgePercent} markets={availableMarkets} live={liveTradingEnabled} trade={tradeSnapshot} pending={tradePending} error={tradeError}
                    onRun={startTrading} onStop={openStopDialog} onStatus={() => setTab("status")} onPair={() => { setSetupStep("exchanges"); setConnectOpen(true); }}
                    renderCoin={(symbol, logo) => <Coin symbol={symbol} color={marketMeta(symbol).color} logo={logo} />} />
                )}
            </div>
          </section>
        </div>
        <ConnectionDialog open={connectOpen} setOpen={setConnectOpen} step={setupStep} setStep={setSetupStep} source={source} setSource={setSource} target={target} setTarget={setTarget} enabledExchanges={enabledExchanges} setEnabledExchanges={setEnabledExchanges} connecting={connecting} onConnect={connect} credentials={credentials} setCredentials={setCredentials} error={connectionError} />
        <ExchangeEditorDialog exchangeId={editingExchange} setExchangeId={setEditingExchange} credentials={credentials} setCredentials={setCredentials} saving={editingSaving} error={editingError} onSave={saveEditedExchange} />
        <StopDialog open={stopOpen} setOpen={setStopOpen} onStop={market=>requestStop(market?'market':'app-only')} onPause={()=>requestStop('pause')} pendingMode={stopPendingMode} error={stopError} trade={tradeSnapshot} exchanges={exchanges}/>
        <AnimatePresence>{notice && <motion.div key={notice.id} className={cn("toast", notice.kind)} initial={{ opacity: 0, x: 18, scale: .98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 12, scale: .98 }}><span className="toast-icon">{notice.kind === "success" ? <Check size={15} weight="bold" /> : <Warning size={15} weight="fill" />}</span><span>{notice.message}</span><button onClick={() => setNotice(null)} aria-label="Закрыть уведомление"><X size={13} /></button></motion.div>}</AnimatePresence>
        </>}
      </main>
    </Tooltip.Provider>
  );
}

function StartupUpdateScreen({ status, autoUpdate, onRetry, onDownload, onInstall, onContinue }: { status: UpdateStatus; autoUpdate: boolean; onRetry: () => void; onDownload: () => void; onInstall: () => void; onContinue: () => void }) {
  const percent = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
  const copy: Record<string, { title: string; detail: string }> = {
    idle: { title: "Подготовка", detail: "Запускаем проверку" },
    checking: { title: "Проверяем обновления", detail: "Сверяем версию приложения" },
    available: { title: `Доступна версия ${status.version || ""}`.trim(), detail: autoUpdate ? "Начинаем загрузку" : "Обновление готово к загрузке" },
    downloading: { title: updateLabel(status), detail: status.phase === 'preparing' ? 'Определяем изменения относительно установленной версии' : status.phase === 'verifying' ? 'Собираем и проверяем целостность пакета' : `${percent}%` },
    ready: { title: "Обновление готово", detail: autoUpdate ? "Перезапускаем приложение" : `Версия ${status.version || "загружена"}` },
    restarting: { title: "Перезапускаем", detail: "Запускаем обновлённое приложение" },
    current: { title: "Версия актуальна", detail: "Открываем приложение" },
    development: { title: "Локальная сборка", detail: "Открываем приложение" },
    "not-configured": { title: "Обновления недоступны", detail: "Открываем приложение" },
    error: { title: "Не удалось проверить обновление", detail: status.message || "Проверьте подключение к сети" },
  };
  const content = copy[status.state] || copy.checking;
  const busy = ["idle", "checking", "available", "downloading", "restarting"].includes(status.state);
  return <section className="startup-update" aria-live="polite" aria-busy={busy}>
    <div className="startup-update-core">
      <div className="startup-update-brand"><LogoMark /><span><strong>HEDGE</strong><em>LBANK</em></span></div>
      <div className={cn("startup-update-orbit", status.state === "error" && "error", ["ready", "current"].includes(status.state) && "complete")}>
        <span className="orbit-ring ring-one" /><span className="orbit-ring ring-two" />
        <span className="orbit-center">{status.state === "error" ? <Warning size={23} /> : ["ready", "current"].includes(status.state) ? <Check size={24} weight="bold" /> : <CircleNotch size={24} />}</span>
      </div>
      <div className="startup-update-copy"><h1>{content.title}</h1><p>{content.detail}</p></div>
      <UpdateProgressDetails status={status} />
      {status.state === "downloading" && status.percent != null && <div className="startup-update-progress" role="progressbar" aria-label="Загрузка обновления" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ transform: `scaleX(${percent / 100})` }} /></div>}
      {status.state === "available" && !autoUpdate && <Button onClick={onDownload}>Загрузить</Button>}
      {status.state === "ready" && !autoUpdate && <Button onClick={onInstall}>Перезапустить</Button>}
      {status.state === "error" && <div className="startup-update-actions"><Button onClick={onRetry}>Повторить</Button><Button variant="ghost" onClick={onContinue}>Продолжить</Button></div>}
    </div>
  </section>;
}

function AuthScreen({ pending, serverReady, licenseKey, setLicenseKey, error, onLogin }: { pending: boolean; serverReady: boolean; licenseKey: string; setLicenseKey: (value: string) => void; error: string; onLogin: () => void }) {
  return <section className="auth-screen">
    <BlackHoleHeroSection className="auth-blackhole" focus={[.7, .48]} scrim="left" scrimStrength={.9} elevation={-6} fov={44} glow={.8} steps={220} resolution={.62} hotColor="#d8ff8a" midColor="#83b937" coolColor="#263515" />
    <div className="auth-panel">
      <div className="auth-brand"><LogoMark /><span><strong>HEDGE</strong><em>LBANK DESKTOP</em></span></div>
      <form className="auth-form" onSubmit={(event) => { event.preventDefault(); if (!pending && serverReady && licenseKey) onLogin(); }}><div className="auth-fields">
        <label className="field"><span>Ключ доступа</span><div className="key-input"><Key size={16} /><Input autoFocus type="password" autoComplete="new-password" value={licenseKey} onChange={(event) => setLicenseKey(event.target.value)} placeholder="Введите ключ" disabled={pending} /></div></label>
      </div>
      {error && <div className="auth-error"><Warning size={15} /><span>{error}</span></div>}
      <Button className="auth-submit" disabled={pending || !serverReady || !licenseKey} aria-busy={pending}>{pending ? <><CircleNotch className="spin" size={17} /> Проверяем</> : <>Войти</>}</Button></form>
    </div>
  </section>;
}

function Titlebar() {
  const call = (action: "minimize" | "maximize" | "close") => window.hedgeDesktop?.window(action);
  return <header className="titlebar">
    <div className="window-brand"><LogoMark /><strong>HEDGE</strong><span>LBANK</span></div>
    <div className="drag-region" />
    <div className="window-controls">
      <button onClick={() => call("minimize")} aria-label="Свернуть"><Minus size={13} /></button>
      <button onClick={() => call("maximize")} aria-label="Развернуть"><span className="maximize-glyph" /></button>
      <button className="close-control" onClick={() => call("close")} aria-label="Закрыть"><X size={14} /></button>
    </div>
  </header>;
}

function LogoMark() { return <span className="logo-mark"><img src="./app-icon.png" alt="" draggable={false} /></span>; }

function Sidebar({ tab, setTab, connected, isAdmin, source, target, enabledExchanges, connectedExchanges, accounts, credentials, onEditExchange, onToggleExchange, onEditPair }: { tab: Tab; setTab: (tab: Tab) => void; connected: boolean; isAdmin: boolean; source: ExchangeId; target: ExchangeId; enabledExchanges: ExchangeId[]; connectedExchanges: ExchangeId[]; accounts: Record<string, { available: number; total: number }>; credentials: Record<string, Record<string, string>>; onEditExchange: (id: ExchangeId) => void; onToggleExchange: (id: ExchangeId) => void; onEditPair: () => void }) {
  return <aside className="sidebar">
    <nav>
      <button aria-label="Статус" className={cn("nav-item", tab === "status" && "active")} onClick={() => setTab("status")}><Power size={18} /><span>Статус</span>{connected && <i />}</button>
      <button aria-label="Хедж" className={cn("nav-item", tab === "hedge" && "active")} onClick={() => setTab("hedge")}><ArrowsDownUp size={18} /><span>Хедж</span></button>
      <button aria-label="История" className={cn("nav-item", tab === "history" && "active")} onClick={() => setTab("history")}><ClockCounterClockwise size={18} /><span>История</span></button>
      {isAdmin && <button aria-label="Пользователи" className={cn("nav-item", tab === "users" && "active")} onClick={() => setTab("users")}><UsersThree size={18} /><span>Пользователи</span></button>}
    </nav>
    <div className="connection-rail"><div className="connection-rail-head"><span>Подключения</span><button onClick={onEditPair} aria-label="Изменить пару бирж"><PencilSimple size={13} /></button></div>{exchanges.map((exchange) => {
      const required = exchange.id === source || exchange.id === target;
      const configured = isExchangeConfigured(exchange.id, credentials[exchange.id]);
      const manual = isManualConnection(exchange.id, credentials[exchange.id]);
      const enabled = configured && enabledExchanges.includes(exchange.id) && (!manual || connectedExchanges.includes(exchange.id));
      const online = configured && connectedExchanges.includes(exchange.id);
      const account = accounts[exchange.id];
      return <div className={cn("connection-rail-row", enabled && "enabled", online && "online")} key={exchange.id}>
        <button className="connection-rail-main" onClick={() => onEditExchange(exchange.id)} title={`Редактировать ${exchange.name}`}><img src={exchange.logo} alt="" /><span><strong>{exchange.name}</strong><em>{online && account ? `${account.total.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT` : configured ? "настроена" : "нет ключей"}</em></span>{required && <b>{exchange.id === source ? "И" : "Ц"}</b>}</button>
        <Tooltip.Root><Tooltip.Trigger asChild><button className={cn("rail-switch", enabled && "on")} onClick={() => onToggleExchange(exchange.id)} aria-label={enabled ? `Отключить ${exchange.name}` : `Подключить ${exchange.name}`}><i /></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={7}>{manual ? enabled ? "Отключить CDP · браузер останется открыт" : "Подключить запущенный профиль вручную" : enabled ? "Отключить и убрать из автозапуска" : configured ? "Подключить и добавить в автозапуск" : "Сначала добавить API-ключи"}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>
      </div>;
    })}</div>
    <button aria-label="Настройки" className={cn("nav-item bottom", tab === "settings" && "active")} onClick={() => setTab("settings")}><GearSix size={18} /><span>Настройки</span></button>
  </aside>;
}

function EmptyStatus({ onConnect }: { onConnect: () => void }) {
  return <div className="empty-status">
    <button className="connect-orbit" onClick={onConnect} aria-label="Добавить API ключи"><span><Plus size={28} weight="light" /></span></button>
    <div className="empty-copy"><h1>Подключите две биржи</h1><p>Добавьте API-ключи, чтобы увидеть futures-балансы и настроить хедж.</p></div>
    <Button onClick={onConnect}><Plus size={16} weight="bold" /> Добавить подключение</Button>
    <div className="security-note"><ShieldCheck size={14} /> Ключи остаются на этом устройстве</div>
  </div>;
}

function formatAdminDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function UsersView({ notify }: { notify: (kind: Notice["kind"], message: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [ttlDays, setTtlDays] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadUsers() {
    setLoading(true);
    const result = await window.hedgeDesktop?.getAdminUsers();
    if (!result?.ok) notify("error", result?.error || "Не удалось загрузить пользователей");
    else setUsers(result.users);
    setLoading(false);
  }

  useEffect(() => { loadUsers(); }, []);

  function toggleKey(id: number) {
    setVisibleKeys((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function copyKey(key: string) {
    await navigator.clipboard.writeText(key);
    notify("success", "Ключ скопирован");
  }

  async function createUser() {
    if (!name.trim() || saving) return;
    setSaving(true);
    const parsedTtl = ttlDays.trim() ? Number(ttlDays) : null;
    if (parsedTtl !== null && (!Number.isInteger(parsedTtl) || parsedTtl < 1)) {
      notify("warning", "Срок укажите целым числом дней");
      setSaving(false);
      return;
    }
    const result = await window.hedgeDesktop?.createAdminUser({ name: name.trim(), ttlDays: parsedTtl, note: note.trim() });
    if (!result?.ok || !result.user) notify("error", result?.error || "Не удалось создать пользователя");
    else {
      setUsers((current) => [result.user!, ...current]);
      setVisibleKeys((current) => new Set(current).add(result.user!.id));
      setSelectedUser(result.user);
      setCreateOpen(false);
      setName(""); setTtlDays(""); setNote("");
      notify("success", "Пользователь и ключ созданы");
    }
    setSaving(false);
  }

  async function updateUser(user: AdminUser, value: { revoked?: boolean; reset_device?: boolean }) {
    const result = await window.hedgeDesktop?.updateAdminUser(user.id, value);
    if (!result?.ok || !result.user) { notify("error", result?.error || "Не удалось изменить пользователя"); return; }
    setUsers((current) => current.map((item) => item.id === result.user!.id ? result.user! : item));
    setSelectedUser(result.user);
    notify("success", value.reset_device ? "Привязка устройства сброшена" : value.revoked ? "Ключ заблокирован" : "Ключ разблокирован");
  }

  return <div className="users-page">
    <div className="view-header users-header"><div><h1>Пользователи</h1><p>Ключи доступа и активность приложения</p></div><Button onClick={() => setCreateOpen(true)}><UserPlus size={17} weight="bold" /> Добавить пользователя</Button></div>
    <div className="users-summary"><span><strong>{users.length}</strong> всего</span><span><strong>{users.filter((user) => !user.revoked).length}</strong> активны</span><span><strong>{users.filter((user) => user.last_used_at).length}</strong> входили</span></div>
    <div className="users-table">
      <div className="users-table-head"><span>Пользователь</span><span>Ключ</span><span>Статус</span><span>Последний вход</span><span /></div>
      {loading ? <div className="users-empty"><CircleNotch className="spin" size={20} /> Загрузка</div> : users.length === 0 ? <div className="users-empty"><UsersThree size={22} /><span>Пока никого нет</span></div> : users.map((user) => {
        const visible = visibleKeys.has(user.id);
        return <div className="users-row" key={user.id}>
          <button className="user-identity" onClick={() => setSelectedUser(user)}><span>{(user.label || "U").slice(0, 2).toUpperCase()}</span><div><strong>{user.label || "Без имени"}</strong><em>{user.user_code ? `ID ${user.user_code}` : "Ещё не входил"}</em></div></button>
          <div className="user-key"><code>{visible ? user.key : `••••••••••••••${user.key.slice(-4)}`}</code><button onClick={() => toggleKey(user.id)} aria-label={visible ? "Скрыть ключ" : "Показать ключ"}>{visible ? <EyeSlash size={16} /> : <Eye size={16} />}</button><button onClick={() => copyKey(user.key)} aria-label="Копировать ключ"><Copy size={16} /></button></div>
          <span className={cn("user-status", user.revoked ? "blocked" : "active")}>{user.revoked ? "Заблокирован" : user.status}</span>
          <time>{formatAdminDate(user.last_used_at)}</time>
          <button className="icon-button" onClick={() => setSelectedUser(user)} aria-label="Открыть пользователя"><CaretRight size={16} /></button>
        </div>;
      })}
    </div>

    <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content user-dialog">
      <div className="dialog-head"><div><Dialog.Title>Новый пользователь</Dialog.Title><Dialog.Description>Имя и ключ доступа для приложения.</Dialog.Description></div><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></div>
      <div className="user-form"><label className="field"><span>Имя</span><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, Алексей" /></label><label className="field"><span>Срок действия, дней</span><Input inputMode="numeric" value={ttlDays} onChange={(event) => setTtlDays(event.target.value.replace(/\D/g, ""))} placeholder="Без срока" /></label><label className="field full"><span>Заметка</span><Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Необязательно" /></label></div>
      <div className="dialog-foot"><span>Ключ сгенерирует сервер</span><Button onClick={createUser} disabled={saving || !name.trim()}>{saving ? <CircleNotch className="spin" size={16} /> : <UserPlus size={16} />} Создать</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>

    <Dialog.Root open={Boolean(selectedUser)} onOpenChange={(open) => { if (!open) setSelectedUser(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />{selectedUser && <Dialog.Content className="dialog-content user-detail-dialog">
      <div className="dialog-head"><div><Dialog.Title>{selectedUser.label || "Пользователь"}</Dialog.Title><Dialog.Description>{selectedUser.user_code ? `ID ${selectedUser.user_code}` : "Ключ ещё не активирован"}</Dialog.Description></div><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></div>
      <div className="user-detail-key"><span>Ключ доступа</span><div><code>{visibleKeys.has(selectedUser.id) ? selectedUser.key : `••••••••••••••${selectedUser.key.slice(-4)}`}</code><button onClick={() => toggleKey(selectedUser.id)}>{visibleKeys.has(selectedUser.id) ? <EyeSlash size={17} /> : <Eye size={17} />}</button><button onClick={() => copyKey(selectedUser.key)}><Copy size={17} /></button></div></div>
      <div className="user-detail-grid"><div><span>Создан</span><strong>{formatAdminDate(selectedUser.created_at)}</strong></div><div><span>Последний вход</span><strong>{formatAdminDate(selectedUser.last_used_at)}</strong></div><div><span>Истекает</span><strong>{formatAdminDate(selectedUser.expires_at)}</strong></div><div><span>Устройство</span><strong>{selectedUser.system_fingerprint ? "Привязано" : "Не привязано"}</strong></div></div>
      {selectedUser.owner_note && <div className="user-note"><span>Заметка</span><p>{selectedUser.owner_note}</p></div>}
      <div className="dialog-foot user-detail-actions"><Button variant="outline" disabled={!selectedUser.system_fingerprint} onClick={() => updateUser(selectedUser, { reset_device: true })}>Сбросить устройство</Button><Button variant={selectedUser.revoked ? "default" : "danger"} onClick={() => updateUser(selectedUser, { revoked: !selectedUser.revoked })}>{selectedUser.revoked ? "Разблокировать" : "Заблокировать"}</Button></div>
    </Dialog.Content>}</Dialog.Portal></Dialog.Root>
  </div>;
}

function ConnectionDialog(props: { open: boolean; setOpen: (v: boolean) => void; step: SetupStep; setStep: (v: SetupStep) => void; source: ExchangeId; setSource: (v: ExchangeId) => void; target: ExchangeId; setTarget: (v: ExchangeId) => void; enabledExchanges: ExchangeId[]; setEnabledExchanges: (v: ExchangeId[]) => void; connecting: boolean; onConnect: () => void; credentials: Record<string, Record<string, string>>; setCredentials: React.Dispatch<React.SetStateAction<Record<string, Record<string, string>>>>; error: string }) {
  const { open, setOpen, step, setStep, source, setSource, target, setTarget, enabledExchanges, setEnabledExchanges, connecting, onConnect, credentials, setCredentials, error } = props;
  const configured = [source, target];
  const updatePair = (nextSource: ExchangeId, nextTarget: ExchangeId) => { setSource(nextSource); setTarget(nextTarget); };
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content">
    <div className="dialog-head"><div><Dialog.Title>{step === "exchanges" ? "Выберите пару бирж" : "Доступ к биржам"}</Dialog.Title><Dialog.Description>{step === "exchanges" ? "Сначала источник, затем цель для лимитного ордера." : "Нужны права чтения баланса и торговли фьючерсами."}</Dialog.Description></div><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></div>
    {step === "exchanges" ? <div className="exchange-picker">
      <ExchangeRow label="Исходная биржа" value={source} other={target} onChange={(id) => id === target ? updatePair(target, source) : updatePair(id, target)} />
      <div className="exchange-direction"><span /><ArrowsDownUp size={17} /><span /></div>
      <ExchangeRow label="Целевая биржа" value={target} other={source} onChange={(id) => id === source ? updatePair(target, source) : updatePair(source, id)} />
    </div> : <div className="credentials-grid">{configured.map((id) => { const exchange = exchanges.find((item) => item.id === id)!; return <CredentialForm key={id} exchange={exchange} role={id === source ? "Исходная" : "Целевая"} values={credentials[id] ?? {}} onChange={(field, value) => setCredentials(current => ({ ...current, [id]: { ...(current[id] ?? {}), [field]: value } }))} />; })}</div>}
    {error && <div className="connection-error"><Warning size={15} /><span>{error}</span></div>}
    <div className="dialog-footer"><div className="step-count"><span className={step === "exchanges" ? "active" : "done"} /><span className={step === "credentials" ? "active" : ""} /></div><div className="footer-actions">{step === "credentials" && <Button variant="ghost" onClick={() => setStep("exchanges")}>Назад</Button>}<Button onClick={() => step === "exchanges" ? setStep("credentials") : onConnect()} disabled={connecting}>{connecting ? <><CircleNotch className="spin" size={16} /> Проверяем {configured.length}</> : step === "exchanges" ? <>Продолжить <CaretRight size={15} /></> : <>Подключить {configured.length} <ArrowsLeftRight size={15} /></>}</Button></div></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function ExchangeEditorDialog({ exchangeId, setExchangeId, credentials, setCredentials, saving, error, onSave }: { exchangeId: ExchangeId | null; setExchangeId: (id: ExchangeId | null) => void; credentials: Record<string, Record<string, string>>; setCredentials: React.Dispatch<React.SetStateAction<Record<string, Record<string, string>>>>; saving: boolean; error: string; onSave: () => void }) {
  const exchange = exchanges.find((item) => item.id === exchangeId);
  return <Dialog.Root open={Boolean(exchange)} onOpenChange={(open) => { if (!open) setExchangeId(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />{exchange && <Dialog.Content className="dialog-content exchange-editor-dialog">
    <div className="dialog-head"><div><Dialog.Title>{exchange.name}</Dialog.Title><Dialog.Description>API, futures-доступ и отдельный сетевой маршрут.</Dialog.Description></div><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></div>
    <div className="single-credential"><CredentialForm exchange={exchange} role="Подключение" values={credentials[exchange.id] ?? {}} onChange={(field, value) => setCredentials((current) => ({ ...current, [exchange.id]: { ...(current[exchange.id] ?? {}), [field]: value } }))} /></div>
    {error && <div className="connection-error"><Warning size={15} /><span>{error}</span></div>}
    <div className="dialog-foot"><span>После сохранения проверим реальный futures-баланс</span><Button onClick={onSave} disabled={saving || !isExchangeConfigured(exchange.id, credentials[exchange.id])}>{saving ? <><CircleNotch className="spin" size={16} /> Проверяем</> : <><PlugsConnected size={16} /> Сохранить и подключить</>}</Button></div>
  </Dialog.Content>}</Dialog.Portal></Dialog.Root>;
}

function ExchangeRow({ label, value, other, onChange }: { label: string; value: ExchangeId; other: ExchangeId; onChange: (id: ExchangeId) => void }) {
  return <div className="exchange-row"><label>{label}</label><div className="exchange-options">{exchanges.map(ex => <Tooltip.Root key={ex.id}><Tooltip.Trigger asChild><button className={cn("exchange-option", value === ex.id && "selected", other === ex.id && "disabled")} onClick={() => onChange(ex.id)}><img src={ex.logo} alt={ex.name} />{other === ex.id && <span className="exchange-cross"><ArrowsDownUp size={15} weight="bold" /></span>}{value === ex.id && <span className="exchange-check"><Check size={11} weight="bold" /></span>}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={8}>{other === ex.id ? `Поменять местами · ${ex.name}` : ex.name}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>)}</div></div>;
}

function CredentialForm({ exchange, role, values, onChange }: { exchange: Exchange; role: string; values: Record<string, string>; onChange: (field: string, value: string) => void }) {
  const signatureMethod = values.signatureMethod || "HmacSHA256";
  const mexcMode = values.connectionMode || "official";
  const browserMode = isManualConnection(exchange.id, values);
  const fields = exchange.id === "mexc" && mexcMode === "sdk"
    ? [{ id: "authorization", label: "WEB Authorization token", hint: "Токен сессии futures.mexc.com для кастомного SDK." }]
    : exchange.fields;
  const proxyEnabled = values.proxyEnabled === "true";
  return <div className="credential-form"><div className="credential-title"><img src={exchange.logo} alt="" /><div><strong>{exchange.name}</strong><span>{role}</span></div></div>
    {exchange.id === 'lbank' && <div className="field mode-field"><span>Способ подключения</span><div className="signature-picker"><button type="button" aria-pressed={!browserMode} className={!browserMode ? 'active' : ''} onClick={() => onChange('connectionMode', 'official')}>API</button><button type="button" aria-pressed={browserMode} className={browserMode ? 'active' : ''} onClick={() => onChange('connectionMode', 'undetectable')}>Undetectable · CDP</button></div></div>}
    {browserMode ? <UndetectableFields values={values} onChange={onChange} /> : <>
    {exchange.id === "mexc" && <div className="field mode-field"><span>Способ подключения</span><div className="signature-picker"><button className={mexcMode === "official" ? "active" : ""} onClick={() => onChange("connectionMode", "official")}>Official API</button><button className={mexcMode === "sdk" ? "active" : ""} onClick={() => onChange("connectionMode", "sdk")}>Custom SDK</button></div></div>}
    <div className="form-stack">{fields.map(field => field.id === "signatureMethod" ? <div className="field" key={field.id}><span>{field.label}{field.hint && <Hint text={field.hint} />}</span><div className="signature-picker"><button className={signatureMethod === "HmacSHA256" ? "active" : ""} onClick={() => onChange(field.id, "HmacSHA256")}>HMAC SHA256</button><button className={signatureMethod === "RSA" ? "active" : ""} onClick={() => onChange(field.id, "RSA")}>RSA</button></div></div> : <label className="field" key={field.id}><span>{field.id === "secret" && exchange.id === "lbank" && signatureMethod === "RSA" ? "RSA Private Key" : field.label}{field.hint && <Hint text={field.hint} />}</span><Input type="password" placeholder={field.id === "secret" && exchange.id === "lbank" && signatureMethod === "RSA" ? "-----BEGIN PRIVATE KEY-----" : "Введите значение"} autoComplete="new-password" value={values[field.id] ?? ""} onChange={(event) => onChange(field.id, event.target.value)} /></label>)}</div>
    <div className="proxy-settings"><button className="proxy-toggle" type="button" onClick={() => onChange("proxyEnabled", proxyEnabled ? "false" : "true")}><span className={cn("toggle", proxyEnabled && "on")}><i /></span><span><strong>Прокси для {exchange.name}</strong><em>HTTP, HTTPS, SOCKS4 или SOCKS5</em></span></button>{proxyEnabled && <label className="field"><span>Адрес прокси</span><Input type="text" placeholder="socks5://user:pass@host:port" autoComplete="off" value={values.proxyUrl ?? ""} onChange={(event) => onChange("proxyUrl", event.target.value)} /></label>}</div>
    <p className="permission-note"><Info size={13} /> Ключи и прокси зашифрованы средствами системы</p></>}</div>;
}

function UndetectableFields({ values, onChange }: { values: Record<string, string>; onChange: (field: string, value: string) => void }) {
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    if (!window.hedgeDesktop?.listUndetectableProfiles) { setError('Подключение доступно в desktop-приложении'); return; }
    setLoading(true); setError('');
    try { setProfiles(await window.hedgeDesktop.listUndetectableProfiles()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  return <div className="form-stack undetectable-fields">
    <div className="field"><span>Профиль</span><ProfilePicker profiles={profiles} value={values.undetectableProfileId || ''} savedName={values.undetectableProfileName} loading={loading} onRefresh={refresh} onSelect={profile => { onChange('undetectableProfileId', profile.id); onChange('undetectableProfileName', profile.name); }} /></div>
    {error && <p role="alert" className="inline-error">{error}</p>}
  </div>;
}

function Hint({ text }: { text: string }) { return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" className="hint"><Question size={12} /></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip wide" sideOffset={7}>{text}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>; }

function Coin({ symbol, color, small = false, logo }: { symbol: string; color: string; small?: boolean; logo?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const underlying = symbol.replace(/^(?:1000000|1000)/, "");
  const source = coinLogos[symbol] || coinLogos[underlying] || logo || `https://assets.coincap.io/assets/icons/${underlying.toLowerCase()}@2x.png`;
  return <span className={cn("coin", small && "small")} style={{ "--coin": color } as React.CSSProperties}>
    {!imageFailed ? <img src={source} alt="" draggable={false} onError={() => setImageFailed(true)} /> : symbol.slice(0, 1)}
  </span>;
}

function SettingsView(props: {
  marginMode: "isolated" | "cross"; setMarginMode: (value: "isolated" | "cross") => void;
  maxLosses: number; setMaxLosses: (value: number) => void; tradingActive: boolean; resetLossLimit?: () => void;
  updateChannel: "beta" | "stable"; setUpdateChannel: (value: "beta" | "stable") => void;
  autoUpdate: boolean; setAutoUpdate: (value: boolean) => void;
  launchOnStartup: boolean; setLaunchOnStartup: (value: boolean) => void;
  soundsEnabled: boolean; setSoundsEnabled: (value: boolean) => void;
  serverUrl: string; setServerUrl: (value: string) => void;
  licenseKey: string; setLicenseKey: (value: string) => void;
  licenseStatus: { state: "idle" | "checking" | "valid" | "invalid"; message?: string; expiresAt?: string | null; userCode?: string | null };
  onVerifyLicense: () => void;
  profileName: string; setProfileName: (value: string) => void;
  updateStatus: UpdateStatus;
  onSave: () => void;
  onLogout: () => void;
  sendingLogs: boolean;
  onSendLogs: () => void;
  onOpenTelegram: () => void;
}) {
  const [recorder, setRecorder] = useState<LBankRecorderStatus>({ active: false, captureId: null, startedAt: null, eventCount: 0, filePath: null, fileName: null, directory: null, error: null });
  const [recorderMarker, setRecorderMarker] = useState('baseline');
  const [recorderPending, setRecorderPending] = useState(false);
  const [recorderError, setRecorderError] = useState('');
  useEffect(() => {
    let mounted = true;
    const refresh = () => window.hedgeDesktop?.getLBankRecorderStatus?.().then(value => { if (mounted) setRecorder(value); }).catch(() => {});
    refresh();
    if (!recorder.active) return () => { mounted = false; };
    const timer = window.setInterval(refresh, 1500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [recorder.active]);
  const toggleRecorder = async () => {
    if (!window.hedgeDesktop || recorderPending) return;
    setRecorderPending(true); setRecorderError('');
    try { setRecorder(recorder.active ? await window.hedgeDesktop.stopLBankRecorder() : await window.hedgeDesktop.startLBankRecorder()); }
    catch (error) { setRecorderError(error instanceof Error ? error.message : String(error)); }
    finally { setRecorderPending(false); }
  };
  const markRecorder = async () => {
    if (!window.hedgeDesktop || recorderPending || !recorder.active) return;
    setRecorderPending(true); setRecorderError('');
    try { setRecorder(await window.hedgeDesktop.markLBankRecorder(recorderMarker)); }
    catch (error) { setRecorderError(error instanceof Error ? error.message : String(error)); }
    finally { setRecorderPending(false); }
  };
  return <div className="settings-page">
    <div className="settings-titlebar"><div><h1>Настройки</h1><p>Приложение и обновления</p></div><div className="profile-chip"><span>{props.profileName.slice(0, 2).toUpperCase()}</span><div><strong>{props.profileName}</strong><em>{props.licenseStatus.userCode || "Аккаунт подключён"}</em></div><UserCircle size={20} /></div></div>
    <div className="settings-content settings-content-flat">
        <section id="hedge-settings" className="settings-section"><div className="section-heading"><ArrowsDownUp size={19} /><div><h2>Автоматический хедж</h2><p>Целевая — по направлению от начала UTC-дня, исходная — наоборот.</p></div></div><label className="field"><span>Маржа хеджа</span><select aria-label="Маржа хеджа" value={props.marginMode} disabled={props.tradingActive} onChange={e => props.setMarginMode(e.target.value === "cross" ? "cross" : "isolated")}><option value="isolated">Изолированная (по умолчанию)</option><option value="cross">Кросс</option></select><span className="permission-note">Применяется к новым хеджам на обеих биржах. Если режим не подтверждён, вход блокируется.</span></label><label className="field"><span>Лимит лузов за сессию <Hint text="Всего завершённых убыточных пар на целевой бирже, по всем монетам. Успех не обнуляет счётчик. 0 — без ограничения." /></span><Input type="number" min={0} step={1} aria-label="Лимит лузов" value={props.maxLosses} disabled={props.tradingActive} onChange={e => { const v = Number(e.target.value); if (Number.isSafeInteger(v) && v >= 0) props.setMaxLosses(v); }} /><span className="permission-note">0 — без ограничения · применяется к новой сессии</span></label>{props.resetLossLimit && <Button variant="outline" onClick={props.resetLossLimit}>Сбросить блокировку лузов</Button>}</section>
        <section className="settings-account"><div className="account-identity"><span>{props.profileName.slice(0, 2).toUpperCase()}</span><div><strong>{props.profileName}</strong><em>{props.licenseStatus.message || "Доступ активен"}</em></div></div><Button variant="ghost" onClick={props.onLogout}><SignOut size={15} /> Выйти</Button></section>
        <section id="updates" className="settings-section"><div className="section-heading"><RocketLaunch size={19} /><div><h2>Обновления</h2><p>Beta получает тестовые сборки, Stable только проверенные релизы.</p></div><span className="update-state">{updateLabel(props.updateStatus)}</span></div><div className="channel-picker"><button className={props.updateChannel === "beta" ? "active" : ""} onClick={() => props.setUpdateChannel("beta")}><span>BETA</span><strong>Ранний доступ</strong><em>Новые функции и частые сборки</em></button><button className={props.updateChannel === "stable" ? "active" : ""} onClick={() => props.setUpdateChannel("stable")}><span>STABLE</span><strong>Основной канал</strong><em>Только проверенные версии</em></button></div>{['downloading', 'ready', 'error'].includes(props.updateStatus.state) && <div className="settings-update-progress"><strong>{updateLabel(props.updateStatus)}{props.updateStatus.percent != null && props.updateStatus.phase !== 'preparing' ? ` · ${props.updateStatus.percent}%` : ''}</strong><UpdateProgressDetails status={props.updateStatus} /></div>}<SettingToggle icon={<DownloadSimple size={17} />} title="Устанавливать автоматически" description="Загрузка и установка после перезапуска" value={props.autoUpdate} onChange={props.setAutoUpdate} /></section>
        <section id="system" className="settings-section"><div className="section-heading"><Monitor size={19} /><div><h2>Система</h2><p>Поведение desktop-приложения.</p></div></div><SettingToggle icon={<Power size={17} />} title="Запускать вместе с системой" description="Открывать Hedge LBank после входа в аккаунт" value={props.launchOnStartup} onChange={props.setLaunchOnStartup} /><SettingToggle icon={<Bell size={17} />} title="Звуки приложения" description="Уведомления, предупреждения и фоновые ошибки" value={props.soundsEnabled} onChange={props.setSoundsEnabled} /></section>
        <section id="lbank-recorder" className="settings-section recorder-section"><div className="section-heading"><Eye size={19} /><div><h2>LBank Futures recorder</h2><p>Пассивно записывает сетевой протокол выбранной вкладки. Сам не выставляет и не закрывает ордера.</p></div><span className={cn('recorder-state', recorder.active && 'active')}><i />{recorder.active ? 'Запись' : 'Остановлен'}</span></div><div className="recorder-summary"><div><span>Событий</span><strong>{recorder.eventCount}</strong></div><div><span>Файл</span><strong title={recorder.fileName || undefined}>{recorder.fileName || 'Создастся при запуске'}</strong></div></div><div className="recorder-actions"><Button onClick={toggleRecorder} disabled={recorderPending}>{recorderPending ? <CircleNotch className="spin" size={16} /> : recorder.active ? <Stop size={16} weight="fill" /> : <Eye size={16} />} {recorder.active ? 'Остановить запись' : 'Начать запись'}</Button><label><span>Метка перед ручным действием</span><select aria-label="Метка действия LBank" value={recorderMarker} disabled={!recorder.active || recorderPending} onChange={event => setRecorderMarker(event.target.value)}><option value="baseline">Исходное состояние</option><option value="leverage">Изменение плеча</option><option value="margin_mode">Изолированная / кросс-маржа</option><option value="place_post_only">Выставление Post-Only</option><option value="cancel_order">Отмена ордера</option><option value="open_market">Открытие маркетом</option><option value="close_position">Закрытие позиции</option><option value="set_tp_sl">Установка TP/SL</option><option value="edit_tp_sl">Изменение TP/SL</option><option value="cancel_tp_sl">Отмена TP/SL</option><option value="trigger_tp_sl">Срабатывание TP/SL</option></select></label><Button variant="outline" onClick={markRecorder} disabled={!recorder.active || recorderPending}><Plus size={15} /> Поставить метку</Button>{recorder.filePath && <Button variant="ghost" onClick={() => window.hedgeDesktop?.showLBankRecorder()}><Monitor size={15} /> Показать файл</Button>}</div><div className="recorder-privacy"><ShieldCheck size={16} /><span>До записи удаляются cookies, authorization, подписи, ключи и токены; ID аккаунта и торгового маршрута заменяются стабильными хешами. OrderSysID, TriggerOrderID, цены и объёмы сохраняются для точного разбора.</span></div>{(recorderError || recorder.error) && <div className="recorder-error"><Warning size={15} /><span>{recorderError || recorder.error}</span></div>}</section>
        <section id="support" className="settings-section support-section"><div className="section-heading"><Lifebuoy size={19} /><div><h2>Поддержка</h2></div></div><div className="support-actions"><Button onClick={props.onSendLogs} disabled={props.sendingLogs}>{props.sendingLogs ? <CircleNotch className="spin" size={16} /> : <PaperPlaneTilt size={16} weight="bold" />} {props.sendingLogs ? "Отправляем…" : "Отправить логи"}</Button><Button variant="outline" onClick={props.onOpenTelegram}><TelegramLogo size={17} weight="fill" /> Написать</Button></div></section>
        <div className="settings-save"><span>Настройки сохраняются автоматически</span><Button onClick={props.onSave}>Сохранить изменения <Check size={15} weight="bold" /></Button></div>
    </div>
  </div>;
}

function SettingToggle({ icon, title, description, value, onChange }: { icon: React.ReactNode; title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button className="setting-toggle" onClick={() => onChange(!value)}><span className="setting-icon">{icon}</span><span className="setting-copy"><strong>{title}</strong><em>{description}</em></span><span className={cn("toggle", value && "on")}><i /></span></button>;
}
