"use client";

import { useEffect, useState } from "react";
import { ArrowClockwise, CaretLeft, CaretRight, ClockCounterClockwise, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import type { HistoryHedge, HistoryOrder, TradingHistory } from "@/types/desktop";
import { formatValue, tradingLabel, type ExchangeBadge } from "./account-status";
import { Button } from "./ui/button";

const dateLabel = (value?: number) => value ? new Date(value).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const orderLabel = (state: string) => ({ UNKNOWN: "Не подтверждён", NEW: "Открыт", PARTIALLY_FILLED: "Частично исполнен", FILLED: "Исполнен", CANCELED: "Отменён", REJECTED: "Отклонён", EXPIRED: "Истёк" }[state] || state);

export function TradingHistoryView({ exchanges }: { exchanges: ExchangeBadge[] }) {
  const [kind, setKind] = useState<"hedges" | "orders">("hedges");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<TradingHistory | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const name = (id: string) => exchanges.find((exchange) => exchange.id === id)?.name || id;
  useEffect(() => {
    let active = true;
    let loading = false;
    setPending(true); setData(null); setError("");
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        if (!window.hedgeDesktop?.getTradingHistory) throw new Error("История доступна в новой desktop-сборке приложения.");
        const result = await window.hedgeDesktop.getTradingHistory({ kind, query, page });
        if (active) { setData(result); setError(""); }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { loading = false; if (active) setPending(false); }
    };
    const debounce = setTimeout(load, query ? 250 : 0);
    const interval = setInterval(load, 5000);
    return () => { active = false; clearTimeout(debounce); clearInterval(interval); };
  }, [kind, query, page, refresh]);
  const orderRows = (orders: HistoryOrder[]) => orders.map((order) => <tr key={`${order.hedgeId}-${order.clientOrderId || order.orderId}-${order.leg}`}>
    <td><time>{dateLabel(order.createdAt)}</time><small>{order.reduceOnly ? "Закрытие" : "Открытие"}{order.dryRun ? " · Симуляция" : ""}</small></td>
    <td><strong>{order.symbol}</strong><small>{name(order.exchange)}</small></td>
    <td className={order.side === "BUY" ? "positive" : "negative"}>{order.side}</td>
    <td>{formatValue(order.executedQuantity, 8)}<small>из {formatValue(order.quantity, 8)}</small></td>
    <td>{formatValue(order.averagePrice ?? order.price, 6)}<small>{order.postOnly ? 'POST-ONLY' : order.type || "—"}</small></td>
    <td>{orderLabel(order.status)}<small className="history-id" title={order.orderId || order.clientOrderId}>{order.orderId || order.clientOrderId || "—"}</small></td>
  </tr>);
  const orderHead = <tr><th>Время</th><th>Монета / биржа</th><th>Сторона</th><th>Исполнено</th><th>Средняя цена</th><th>Статус / ID</th></tr>;
  return <div className="live-status history-page layout-stack">
    <div className="view-header"><div><h1>История</h1><p>Ордера и хеджи этого приложения</p></div><button className="icon-button" aria-label="Обновить историю" onClick={() => setRefresh((value) => value + 1)} disabled={pending}><ArrowClockwise className={pending ? "spin" : ""} size={20} /></button></div>
    <div className="history-toolbar"><div className="data-tabs" role="tablist" aria-label="Раздел истории">{([['hedges', 'Хеджи'], ['orders', 'Ордера']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={kind === value} className={kind === value ? "active" : ""} onClick={() => { setKind(value); setPage(0); setExpanded(null); }}>{label}</button>)}</div><label className="history-search"><MagnifyingGlass size={17} /><input aria-label="Поиск в истории" placeholder="Монета, биржа или ID" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); setExpanded(null); }} /></label></div>
    {error && <div className="live-error" role="alert"><WarningCircle size={18} /><span>{error}</span></div>}
    {!!data?.unreadable && <div className="live-error" role="status"><WarningCircle size={18} /><span>Не удалось прочитать записей: {data.unreadable}. Файлы сохранены без изменений.</span></div>}
    <div className="live-table-scroll" role="region" aria-label="История торговли" tabIndex={0} aria-busy={pending}>
      <table className="live-table history-table"><thead>{kind === "orders" ? orderHead : <tr><th>Время</th><th>Биржи / монеты</th><th>Маржа</th><th>Результат</th><th>Состояние</th><th /></tr>}</thead><tbody>
        {kind === "orders" ? orderRows((data?.rows || []) as HistoryOrder[]) : ((data?.rows || []) as HistoryHedge[]).map((hedge) => <HistoryRows key={hedge.id} hedge={hedge} expanded={expanded === hedge.id} onToggle={() => setExpanded(expanded === hedge.id ? null : hedge.id)} name={name} orderHead={orderHead} orderRows={orderRows} />)}
      </tbody></table>
      {!data?.rows.length && <div className="live-table-empty"><ClockCounterClockwise size={20} />{pending ? "Загружаем историю…" : error ? "История недоступна" : query ? "Ничего не найдено" : "Записи появятся после запуска хеджа"}</div>}
    </div>
    <div className="history-pagination"><span>{data ? `${data.total} записей · ${data.page + 1} / ${data.pages}` : "—"}</span><div><Button variant="outline" aria-label="Предыдущая страница истории" disabled={pending || !data || data.page === 0} onClick={() => setPage(Math.max(0, (data?.page || 0) - 1))}><CaretLeft size={17} /></Button><Button variant="outline" aria-label="Следующая страница истории" disabled={pending || !data || data.page + 1 >= data.pages} onClick={() => setPage((data?.page || 0) + 1)}><CaretRight size={17} /></Button></div></div>
    <span className="hedge-result-note">История сохраняется локально с этой версии. Предварительный PnL не учитывает окончательные комиссии и funding.</span>
  </div>;
}

function HistoryRows({ hedge, expanded, onToggle, name, orderHead, orderRows }: { hedge: HistoryHedge; expanded: boolean; onToggle: () => void; name: (id: string) => string; orderHead: React.ReactNode; orderRows: (orders: HistoryOrder[]) => React.ReactNode }) {
  return <><tr>
    <td><time>{dateLabel(hedge.startedAt)}</time><small className="history-id" title={hedge.id}>{hedge.id}</small></td>
    <td><strong>{name(hedge.source)} → {name(hedge.target)}</strong><small className="history-symbols">{hedge.symbols.join(" · ") || "—"}</small></td>
    <td>{formatValue(hedge.totalMargin)}<small>USDT на биржу</small></td>
    <td>{formatValue(hedge.result?.netPnl)}<small>{hedge.result ? hedge.result.provisional ? "Предварительный PnL" : "Итоговый PnL" : "Не рассчитан"}</small></td>
    <td>{tradingLabel(hedge.state)}{hedge.dryRun && <small>Симуляция</small>}</td>
    <td><button className="icon-button" aria-label={`Показать хедж ${hedge.id}`} aria-expanded={expanded} onClick={onToggle}><CaretRight size={17} style={{ transform: expanded ? "rotate(90deg)" : undefined }} /></button></td>
  </tr>{expanded && <tr className="history-detail"><td colSpan={6}><div className="layout-stack"><strong>Ордера хеджа · {hedge.orders.length}</strong>{hedge.error && <div className="live-error"><WarningCircle size={17} /><span>{hedge.error}</span></div>}{hedge.orders.length ? <table className="live-table"><thead>{orderHead}</thead><tbody>{orderRows(hedge.orders)}</tbody></table> : <span>Ордеров не отправлено</span>}</div></td></tr>}</>;
}
