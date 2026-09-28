"use client";

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Slider from "@radix-ui/react-slider";
import { ArrowsLeftRight, Check, CircleNotch, MagnifyingGlass, Minus, Plus, SlidersHorizontal, Stop, WarningCircle, X, ArrowRight } from "@phosphor-icons/react";
import type { HedgeOptions, HedgePlan, TradeSnapshot } from "@/types/desktop";
import { Button } from "./ui/button";
import { ExchangeBadge, formatValue, tradingLabel } from "./account-status";
import { executionLabel } from '@/lib/execution-label';
import { TradeNotice } from './trade-notice';
import { botIsStopped, canManageStoppedTrade, tradeFeedback } from '@/lib/trade-feedback';

type Market = { symbol: string; lastPrice: number; makerFee: number | null; takerFee: number | null; combinedTurnover: number; logoUrl?: string | null };
type Props = { source: string; target: string; exchanges: ExchangeBadge[]; connected: boolean; configured: boolean; available: number; markets: Market[]; selected: string[]; setSelected: (value: string[]) => void; margin: number; setMargin: (value: number) => void; leverages: Record<string, number>; setLeverages: (value: Record<string, number>) => void; defaultLeverage: number; hedgePercent: number; setHedgePercent: (value: number) => void; live: boolean; trade: TradeSnapshot; pending: boolean; error: string; onRun: (acceptImpact: boolean) => void; onStop: () => void; onPair: () => void; onStatus: () => void; renderCoin: (symbol: string, logo?: string | null) => React.ReactNode };
const top = ["BTC", "ETH", "BNB", "XRP", "SOL", "TRX", "HYPE", "ZEC", "DOGE", "LINK", "LEO", "XMR", "ADA", "XLM", "BCH", "TON", "LTC", "HBAR", "SUI", "AVAX", "SHIB"];
const base = (symbol: string) => symbol.replace(/USDT$/, "");

export function AutomatedHedge(p: Props) {
  const feedback = tradeFeedback(p.trade);
  const manageStopped = canManageStoppedTrade(p.trade);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<HedgePlan | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewPending, setPreviewPending] = useState(false);
  const [acceptImpact, setAcceptImpact] = useState(false);
  const [revision, setRevision] = useState(0);
  const locked = p.trade.active || p.pending;
  const maxLeverage=p.source==='lbank'||p.target==='lbank'?20:125;
  const execution = p.trade.active ? p.trade.execution : preview?.execution;
  const options = useMemo<HedgeOptions>(() => ({ source: p.source, target: p.target, symbols: p.selected.map((s) => `${s}USDT`), totalMargin: p.margin, leverageBySymbol: Object.fromEntries(p.selected.map((s) => [`${s}USDT`, Math.min(maxLeverage,p.leverages[s] ?? p.defaultLeverage)])), hedgePercent: p.hedgePercent }), [p.source, p.target, p.selected, p.margin, p.leverages, p.defaultLeverage, p.hedgePercent,maxLeverage]);
  useEffect(() => {
    setPreview(null); setPreviewError(""); setAcceptImpact(false);
    if (locked || manageStopped || !p.connected || !p.selected.length || !(p.margin > 0) || !p.live) { setPreviewPending(false); return; }
    let active = true;
    setPreviewPending(true);
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!active) return;
      setPreviewPending(true);
      try {
        const result = await window.hedgeDesktop?.previewHedge(options);
        if (!active) return;
        if (result?.ok && result.plan) { setPreview(result.plan); setPreviewError(""); }
        else {
          setPreviewError(result?.error || "Проверка доступна в desktop-приложении");
          // Read-only retry after the exchange cooldown; never starts trading.
          if (result?.httpStatus === 429) timer = setTimeout(refresh, Math.max(1000, result.retryAfterMs || 5000));
        }
      } catch (error) { if (active) setPreviewError(error instanceof Error ? error.message : String(error)); }
      finally { if (active) setPreviewPending(false); }
    };
    timer = setTimeout(refresh, 700);
    return () => { active = false; clearTimeout(timer); };
  }, [options, p.connected, p.live, locked, manageStopped, revision]);
  useEffect(()=>{
    if(locked||maxLeverage===125||!Object.values(p.leverages).some(value=>value>maxLeverage))return;
    p.setLeverages(Object.fromEntries(Object.entries(p.leverages).map(([symbol,value])=>[symbol,Math.min(value,maxLeverage)])));
  },[locked,maxLeverage,p.leverages,p.setLeverages]);
  const selectedSet = new Set(p.selected);
  const markets = [...p.markets].sort((a, b) => {
    const rank = (symbol: string) => { const value = top.indexOf(base(symbol)); return value < 0 ? 999 : value; };
    return rank(a.symbol) - rank(b.symbol) || b.combinedTurnover - a.combinedTurnover;
  }).filter((m) => m.symbol.toLowerCase().includes(query.toLowerCase().trim()));
  const perCoin = p.selected.length ? p.margin / p.selected.length : 0;
  const percent = p.trade.active ? p.trade.hedgePercent ?? p.hedgePercent : p.hedgePercent;
  const targetGoal=p.trade.active?Number(p.trade.targetGoal||p.margin*percent/100):p.margin*percent/100;
  const targetProgress=Number(p.trade.realizedNet?.target||0);
  const thresholdLabel=p.trade.active?`+${formatValue(targetProgress)} / +${formatValue(targetGoal)} USDT`:`≈ +${formatValue(targetGoal)} USDT на ЦЕЛЕВОЙ`;
  const totalNotional = p.selected.reduce((sum, s) => sum + perCoin * Math.min(maxLeverage,p.leverages[s] ?? p.defaultLeverage), 0);
  const impactWarning = preview?.legs.some((l) => (l.impact.impactPercent ?? 0) > 0.01) || false;
  // Preview is informative: the supervisor retries transient checks after Start.
  const canRun = p.configured && p.selected.length > 0 && p.margin > 0 && !p.trade.requiresAttention;
  const leverage = (symbol: string, value: number) => p.setLeverages({ ...p.leverages, [symbol]: Math.max(1, Math.min(maxLeverage, Math.round(value || 1))) });
  return <div className="auto-hedge layout-stack">
    <div className="view-header"><div><h1>Хедж</h1><p>{execution?.targetPostOnly ? 'Post-Only → Post-Only · через 1,5 с остаток маркетом' : execution ? 'Лимит на источнике → маркет на целевой' : 'Две биржи. Одна стратегия.'}</p></div><span className={`mode-pill ${p.live ? "live" : ""}`}>{p.live ? "Реальная торговля" : "Симуляция"}</span></div>
    <button className="hedge-route-editor" onClick={p.onPair} disabled={locked} aria-label="Выбрать пару бирж">{[p.source, p.target].map((id, i) => { const ex = p.exchanges.find((e) => e.id === id)!; return <span className="hedge-route-item" key={id}><img src={ex.logo} alt="" /><span><small>{executionLabel(i === 0 ? 'source' : 'target', execution, p.trade.active)}</small><strong>{ex.name}</strong></span>{i === 0 ? <ArrowsLeftRight className="route-separator" size={19} /> : <SlidersHorizontal size={19} />}</span>; })}</button>
    <div className="allocation-summary"><label className="margin-control"><span>Общая маржа на биржу</span><span className="margin-input-wrap"><input aria-label="Общая маржа" type="number" min="0" step="0.01" value={p.margin || ""} disabled={locked} onChange={(e) => p.setMargin(Number(e.target.value))} /><span>USDT</span></span></label><div><span>На одну монету</span><strong>{formatValue(perCoin)} <small>USDT</small></strong></div><div><span>Доступно на меньшем счёте</span><strong>{p.connected ? formatValue(p.available) : "—"} <small>USDT</small></strong></div></div>
    <div className="selected-coins-toolbar"><div><h2>Монеты <span>{p.selected.length}</span></h2><p>Маржа поровну, плечо индивидуально</p></div><Button variant="outline" onClick={() => setPickerOpen(true)} disabled={locked}><Plus size={17} />Выбрать монеты</Button></div>
    <div className="allocation-list">{p.selected.map((symbol) => {
      const m = p.markets.find((m) => m.symbol === `${symbol}USDT`); const x = p.leverages[symbol] ?? p.defaultLeverage;
      const leg = preview?.legs.find((l) => l.symbol === `${symbol}USDT`);
      return <div className="allocation-row" key={symbol}>
        <div className="allocation-coin">{p.renderCoin(symbol, m?.logoUrl)}<div><strong>{symbol}</strong><small>{m ? `$${formatValue(m.lastPrice, 6)}` : "Нет общего рынка"}</small></div></div>
        <div className="allocation-leverage"><div className="leverage-input"><button aria-label={`Уменьшить плечо ${symbol}`} disabled={locked || x <= 1} onClick={() => leverage(symbol, x - 1)}><Minus size={15} /></button><label><input aria-label={`Плечо ${symbol}`} type="number" min={1} max={maxLeverage} value={Math.min(x,maxLeverage)} disabled={locked} onChange={(e) => leverage(symbol, Number(e.target.value))} /><span>x</span></label><button aria-label={`Увеличить плечо ${symbol}`} disabled={locked || x >= maxLeverage} onClick={() => leverage(symbol, x + 1)}><Plus size={15} /></button></div><Slider.Root className="leverage-track" aria-label={`Плечо ${symbol}, ползунок`} min={1} max={maxLeverage} step={1} value={[Math.min(x,maxLeverage)]} disabled={locked} onValueChange={([v]) => leverage(symbol, v)}><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumb /></Slider.Root></div>
        <div className="allocation-notional"><strong>{formatValue(perCoin * x)} <small>USDT</small></strong><span>Объём на каждой бирже</span>{leg && <small>{formatValue(leg.quantity, 8)} {symbol}</small>}</div>
        <button className="icon-button" aria-label={`Убрать ${symbol}`} onClick={() => p.setSelected(p.selected.filter((s) => s !== symbol))} disabled={locked}><X size={16} /></button>
      </div>;
    })}{!p.selected.length && <button className="select-assets-empty" onClick={() => setPickerOpen(true)} disabled={locked}><Plus size={28} /><strong>Выберите монеты для хеджа</strong><span>Только общие USDT-фьючерсы двух бирж</span></button>}</div>
    <div className="hedge-target-row"><label>Цель переноса <input type="number" aria-label="Цель PnL" min={1} max={100} value={percent} disabled={locked} onChange={(e) => p.setHedgePercent(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} /> % от общей маржи</label><strong title="Маржа делится поровну между монетами. Для каждого цикла приложение само снижает опасный порог, учитывает комиссии и подтверждает серверные TP/SL на обеих биржах.">{thresholdLabel}</strong></div>
    {preview && <div className="preflight-summary"><div><Check size={16} /><span>Пара проверена · объёмы согласованы</span><button onClick={() => setRevision((r) => r + 1)}>Пересчитать</button></div><div className="depth-estimates">{preview.legs.map((leg) => <div key={leg.symbol}><strong>{base(leg.symbol)}</strong><span>Стакан ±0.1% <b>{formatValue(Math.min(leg.impact.buyDepth, leg.impact.sellDepth), 0)} USDT</b></span><span>Потери входа ≈ <b>{formatValue(leg.impact.estimatedLoss, 4)} USDT</b></span></div>)}</div></div>}
    {impactWarning && <label className="impact-warning"><input type="checkbox" checked={acceptImpact} onChange={(e) => setAcceptImpact(e.target.checked)} /><WarningCircle size={20} /><span>Оценка потерь по стакану выше 0.01%. Учесть спред и продолжить. Комиссии оплачиваются отдельно.</span></label>}
    {previewPending && <div className="preflight-pending"><CircleNotch size={17} className="spin" />Проверяем балансы, позиции и объёмы…</div>}
    {(p.error || previewError) && <div className="live-error" role="alert"><WarningCircle size={18} /><span>{p.error || previewError}</span></div>}
    {feedback.closeError && <div className="live-error" role="status"><WarningCircle size={18} /><span>Закрытие не подтверждено. {feedback.closeError}</span></div>}
    <TradeNotice trade={p.trade}/>
    <div className="hedge-run-footer"><div><span>{botIsStopped(p.trade)?'Бот остановлен':p.trade.active ? `${tradingLabel(p.trade.state)} · Лузы ${p.trade.lossCount ?? 0}/${p.trade.maxLosses || "∞"}` : "Работа до Стоп или лимита сессии"}</span><strong>{formatValue(totalNotional)} <small>USDT</small></strong></div>{p.trade.active ? <><Button variant="outline" onClick={p.onStatus}>Позиции<ArrowRight size={16} /></Button><Button variant="danger" onClick={p.onStop}><Stop size={18} />Остановить</Button></> : <>{manageStopped&&<Button variant="outline" onClick={p.onStop}>{p.trade.closeStatus==='closing'?'Закрытие позиций':'Позиции и заявки'}</Button>}{(!manageStopped||p.trade.manualManagement)&&<Button onClick={() => p.onRun(acceptImpact)} disabled={!canRun || p.pending}>{p.pending ? <CircleNotch className="spin" size={18} /> : <ArrowsLeftRight size={18} />}{p.pending ? "Запускаем…" : p.live ? "Запустить хедж" : "Запустить симуляцию"}</Button>}</>}</div>
    <Dialog.Root open={pickerOpen} onOpenChange={setPickerOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content coin-picker-dialog"><div className="dialog-head"><div><Dialog.Title>Выберите монеты</Dialog.Title><Dialog.Description>Общие USDT-фьючерсы · максимум 20 монет</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="Закрыть выбор монет"><X size={18} /></button></Dialog.Close></div><div className="coin-picker-tools"><label><MagnifyingGlass size={18} /><input placeholder="Поиск по монетам" aria-label="Поиск по монетам" value={query} onChange={(e) => setQuery(e.target.value)} /></label><button disabled={!p.selected.length} onClick={() => p.setSelected([])}>Отключить все</button></div><div className="coin-picker-list">{markets.map((m) => { const symbol = base(m.symbol); const checked = selectedSet.has(symbol); return <button role="checkbox" aria-checked={checked} className={checked ? "selected" : ""} key={m.symbol} disabled={!checked && selectedSet.size >= 20} onClick={() => p.setSelected(checked ? p.selected.filter((s) => s !== symbol) : [...p.selected, symbol])}>{p.renderCoin(symbol, m.logoUrl)}<span><strong>{symbol}</strong><small>{m.symbol}</small></span><span className="picker-price">${formatValue(m.lastPrice, 6)}</span><span className="coin-check">{checked && <Check size={15} weight="bold" />}</span></button>; })}{!markets.length && <div className="live-table-empty">{p.markets.length ? "Монета не найдена" : "Общие рынки пока не загружены"}</div>}</div><div className="dialog-foot"><span>Выбрано: {p.selected.length}</span><Dialog.Close asChild><Button>Готово<Check size={17} /></Button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
