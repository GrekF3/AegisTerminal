"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, ArrowsLeftRight, ArrowClockwise, WarningCircle, Stop } from "@phosphor-icons/react";
import type { PortfolioSnapshot, TradeSnapshot } from "@/types/desktop";
import { RollingNumber } from "./rolling-number";
import { Button } from "./ui/button";
import { TradeNotice } from './trade-notice';
import { botIsStopped, canManageStoppedTrade, tradeFeedback } from '@/lib/trade-feedback';

export type ExchangeBadge = { id: string; name: string; logo: string };
export const formatValue = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits === 2 ? 2 : 0 });
export const tradingLabel = (state: string) => ({ idle: "Готов к запуску", preparing: "Проверка аккаунтов", configuring_leverage: "Настройка плеча", placing_target: "Размещение лимитки", waiting_target: "Ожидание исполнения", hedging_source: "Исполнение маркет-ноги", placing_source: 'Лимитка на источнике', waiting_source: 'Ожидание исполнения источника', repricing_source: 'Перестановка по bid/ask', placing_target_maker: 'Post-Only на целевой', waiting_target_maker: 'Ожидание maker · до 1,5 с', hedging_target_market: 'Остаток на целевой маркетом', running: "Хедж открыт", monitoring: "Сессия работает", recovering_protection: 'Проверка серверных TP/SL', waiting_retry: "Автоматический повтор входа", waiting_exchange: "Ожидание данных биржи", reconciling_entry: "Сверка исполнения входа", waiting_pnl: 'Синхронизация PnL', loss_limit: "Достигнут лимит лузов", monitoring_stale: "Нужна проверка", recovery_required: "Восстановление сессии", stopping: "Закрытие позиций", stopped: "Остановлен", completed: "Цель достигнута", error: "Запуск прерван", emergency: "Требуется внимание" }[state] || state);

export function AccountStatus({ source, target, exchanges, portfolio, trade, onExchangeClick, onRefresh, onStop, onHedge }: { source: string; target: string; exchanges: ExchangeBadge[]; portfolio: PortfolioSnapshot; trade: TradeSnapshot; onExchangeClick: (id: string) => void; onRefresh: () => void; onStop: () => void; onHedge: () => void }) {
  const feedback=tradeFeedback(trade);
  const [section, setSection] = useState<"positions" | "orders" | "executions">("positions");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const entries = Object.values(portfolio.exchanges);
  const positions = entries.flatMap((s) => s.positions || []);
  const orders = entries.flatMap((s) => s.orders || []);
  const executions = (trade.runs || []).flatMap((r) => [...(r.targetOrders || [r.targetOrder]), ...r.sourceOrders, ...(r.closeOrders || [])].filter((o) => o != null));
  const stale = entries.some((s) => s.status !== "live" || now - (s.accountUpdatedAt || 0) > 5000);
  const missingPositions = !entries.length || entries.some((s) => !s.positionsUpdatedAt || s.errors?.positions || now - s.positionsUpdatedAt > 5000);
  const missingOrders = !entries.length || entries.some((s) => !s.ordersUpdatedAt || s.errors?.orders || now - s.ordersUpdatedAt > (s.exchange === "binance" ? 15_000 : 5000));
  const totalPnl = missingPositions || positions.some((p) => p.unrealizedPnl == null) ? null : positions.reduce((sum, p) => sum + p.unrealizedPnl!, 0);
  const ids = [...new Set([source, target, ...entries.map((s) => s.exchange)])];
  const name = (id: string) => exchanges.find((e) => e.id === id)?.name || id;
  const transferProgress=trade.targetGoal!=null?` · Целевая +${formatValue(trade.realizedNet?.target||0)} / +${formatValue(trade.targetGoal)} USDT`:'';
  return <div className="live-status layout-stack">
    <div className="view-header"><div><h1>Статус</h1><p>Аккаунты и открытые позиции</p></div><button className="icon-button" aria-label="Обновить аккаунты" onClick={onRefresh}><ArrowClockwise size={20} /></button></div>
    <div className="account-balances">{ids.map((id) => {
      const ex = exchanges.find((e) => e.id === id); const data = portfolio.exchanges[id];
      if (!ex) return null;
      const fresh = data?.accountUpdatedAt && now - data.accountUpdatedAt < 5000 && !data.errors?.account;
      return <button className="account-balance" key={id} onClick={() => onExchangeClick(id)}>
        <span className="account-balance-heading"><img src={ex.logo} alt="" /><strong>{ex.name}</strong><small>{id === source ? "Исходная" : id === target ? "Целевая" : "Подключена"}</small><ArrowUpRight size={16} /></span>
        <span className="account-balance-amount"><RollingNumber value={data?.account?.total} /><small>{data?.account?.balanceKind === 'wallet' ? 'USDT · кошелёк' : 'USDT'}</small></span>
        <span className="account-balance-foot"><span>Доступно <b>{formatValue(data?.account?.available)}</b></span><span className={fresh ? "feed-live" : "feed-stale"}>{fresh ? "● Live" : data?.account ? "● Данные устарели" : "● Нет данных"}</span></span>
      </button>;
    })}</div>
    {(trade.active || trade.state !== "idle") && <div className="hedge-session-bar"><ArrowsLeftRight size={21} /><div><strong>{botIsStopped(trade)?'Бот остановлен':tradingLabel(trade.state)}{trade.dryRun ? " · Симуляция" : ""}</strong><span>{trade.maxLosses != null ? `${trade.completedRounds || 0} циклов · Лузы ${trade.lossCount || 0} / ${trade.maxLosses || '∞'}` : `${trade.completedOrders || 0} / ${trade.totalOrders || 0} пар`} · {name(trade.source || source)} → {name(trade.target || target)}{transferProgress}</span></div>{trade.active ? <Button variant="danger" onClick={onStop}><Stop size={16} />Стоп</Button> : canManageStoppedTrade(trade) ? <Button variant="outline" onClick={onStop}>{trade.closeStatus==='closing'?'Закрытие позиций':'Позиции и заявки'}</Button> : <Button variant="outline" onClick={onHedge}>Настроить хедж</Button>}</div>}
    {feedback.error && <div className="live-error" role="status"><WarningCircle size={18} /><span>{feedback.error}</span></div>}
    {feedback.closeError && <div className="live-error" role="status"><WarningCircle size={18} /><span>Закрытие не подтверждено. {feedback.closeError}</span></div>}
    <TradeNotice trade={trade}/>
    {(trade.currentPnl || trade.result) && <dl className="hedge-pnl-summary" aria-label="Результат хеджа">
      <div><dt>{name(trade.source || source)} · {trade.result ? "PnL перед закрытием" : "PnL хеджа"}</dt><dd>{formatValue(trade.result?.sourcePnl ?? trade.currentPnl?.source)} <small>USDT</small></dd></div>
      <div><dt>{name(trade.target || target)} · {trade.result ? "PnL перед закрытием" : trade.targetProfit != null ? "PnL / цель" : "PnL хеджа"}</dt><dd>{formatValue(trade.result?.targetProfit ?? trade.currentPnl?.target)}{!trade.result && trade.targetProfit != null && <small> / {formatValue(trade.targetProfit)}</small>} <small>USDT</small></dd></div>
      {trade.result && <div><dt>Подтверждённый оборот</dt><dd>{formatValue(trade.result.tradingVolume)} <small>USDT</small></dd></div>}
    </dl>}
    {trade.result?.provisional && <span className="hedge-result-note">Результат предварительный: оценка комиссий учтена, но funding и фактические комиссии бирж ещё не сверены.</span>}
    <div className="positions-toolbar"><div className="data-tabs" role="tablist" aria-label="Данные аккаунтов">{([['positions', 'Позиции', positions.length], ['orders', 'Ордера', orders.length], ['executions', 'Хедж', executions.length]] as const).map(([id, label, count]) => <button role="tab" aria-selected={section === id} className={section === id ? "active" : ""} onClick={() => setSection(id)} key={id}>{label}<span>{count}</span></button>)}</div><div className="total-pnl"><span>Плавающий PnL</span><strong className={totalPnl == null ? "" : totalPnl >= 0 ? "positive" : "negative"}>{totalPnl != null && totalPnl > 0 ? "+" : ""}{formatValue(totalPnl)}<small> USDT</small></strong></div></div>
    <div className="live-table-scroll" role="region" aria-label="Таблица сделок" tabIndex={0}>
      <table className="live-table"><thead><tr><th>Монета / биржа</th><th>Сторона</th><th>Объём</th><th>{section === "positions" ? "Вход / марк" : "Цена"}</th><th>{section === "positions" ? "PnL, USDT" : "Состояние"}</th><th>{section === "positions" ? "Ликвидация" : "Тип"}</th></tr></thead><tbody>
        {section === "positions" && positions.map((p) => <tr key={p.id} className={portfolio.exchanges[p.exchange]?.errors?.positions ? "stale-row" : ""}><td><strong>{p.symbol.replace(/USDT$/, "")}</strong><small>{name(p.exchange)}</small></td><td><span className={`side-label ${p.side}`}>{p.side.toUpperCase()}</span><small>{p.leverage ? `${p.leverage}x` : "—"}{p.marginMode ? ` · ${p.marginMode}` : ""}</small></td><td>{formatValue(p.quantity, 8)}<small>Маржа {formatValue(p.margin)}</small></td><td>{formatValue(p.entryPrice, 6)}<small>{formatValue(p.markPrice, 6)}</small></td><td className={p.unrealizedPnl == null ? "" : p.unrealizedPnl >= 0 ? "positive" : "negative"}>{p.unrealizedPnl != null && p.unrealizedPnl > 0 ? "+" : ""}{formatValue(p.unrealizedPnl)}</td><td>{formatValue(p.liquidationPrice && p.liquidationPrice > 0 ? p.liquidationPrice : null, 6)}</td></tr>)}
        {section === "orders" && orders.map((o) => <tr key={o.id}><td><strong>{o.symbol.replace(/USDT$/, "")}</strong><small>{name(o.exchange)}</small></td><td className={o.side === "buy" ? "positive" : "negative"}>{o.side.toUpperCase()}</td><td>{formatValue(o.quantity, 8)}</td><td>{formatValue(o.price, 6)}</td><td>{o.status}</td><td>{o.type}</td></tr>)}
        {section === "executions" && executions.map((o, i) => <tr key={o.clientOrderId || `${o.leg}-${i}`}><td><strong>{o.symbol?.replace(/USDT$/, "")}</strong><small>{name((o.leg === "source" ? trade.source : trade.target) || "")}</small></td><td className={o.side === "BUY" ? "positive" : "negative"}>{o.side}</td><td>{formatValue(o.executedQuantity, 8)}<small>из {formatValue(o.quantity, 8)}</small></td><td>{formatValue(o.averagePrice ?? o.price, 6)}</td><td>{o.status}</td><td>{o.reduceOnly ? "Закрытие" : o.postOnly ? 'POST-ONLY' : o.type}</td></tr>)}
      </tbody></table>
      {(section === "positions" ? positions.length === 0 : section === "orders" ? orders.length === 0 : executions.length === 0) && <div className="live-table-empty">{section === "positions" && missingPositions ? "Ожидаем позиции от бирж" : section === "positions" ? "Открытых позиций нет" : section === "orders" && missingOrders ? "Ожидаем ордера от бирж" : section === "orders" ? "Нет ожидающих ордеров" : "Исполнения появятся после запуска хеджа"}</div>}
    </div>
    <div className="account-feed-foot"><span className={stale ? "feed-stale" : "feed-live"}>● {stale ? "Есть задержка синхронизации" : "Синхронизация каждую секунду"}</span><span>USDT perpetual · PnL до финального расчёта комиссий</span></div>
    {entries.flatMap((s) => Object.entries(s.errors || {}).map(([field, error]) => <div className="live-error" key={`${s.exchange}-${field}`}><WarningCircle size={16} /><span>{name(s.exchange)}: {error}</span></div>))}
  </div>;
}
