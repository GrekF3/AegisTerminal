"use client";
import * as Dialog from '@radix-ui/react-dialog';
import { Check, CircleNotch, Clock, WarningCircle } from '@phosphor-icons/react';
import type { ExecutionOrder, StopMode, TradeSnapshot } from '@/types/desktop';
import { botIsStopped } from '@/lib/trade-feedback';
import type { ExchangeBadge } from './account-status';
import { formatValue } from './account-status';
import { Button } from './ui/button';

const terminal=new Set(['FILLED','CANCELED','REJECTED','EXPIRED']);
export function StopDialog({open,setOpen,onStop,onPause,pendingMode,error,trade,exchanges}:{
  open:boolean;setOpen:(open:boolean)=>void;onStop:(market:boolean)=>void;onPause:()=>void;pendingMode:StopMode|null;error:string;trade:TradeSnapshot;exchanges:ExchangeBadge[];
}) {
  const stopped=botIsStopped(trade);
  const manualPending=pendingMode==='app-only';
  const closeError=trade.closeError || (stopped && (trade.closeStatus==='failed'||trade.closeStatus==='waiting_confirmation') ? error || trade.error : undefined);
  const closing=pendingMode==='market'||trade.closeStatus==='closing';
  const progress=closing||Boolean(closeError)||trade.closeStatus==='waiting_confirmation'||trade.closeStatus==='failed'||trade.closeStatus==='closed';
  const busy=Boolean(pendingMode)||closing;
  const rows=(trade.runs||[]).flatMap(run=>(['source','target'] as const).map(leg=>{
    const orders=(leg==='source'?run.sourceOrders||[]:run.targetOrders||[run.targetOrder]).filter((o):o is ExecutionOrder=>Boolean(o));
    const opened=orders.reduce((sum,o)=>sum+o.executedQuantity,0);
    const closes=(run.closeOrders||[]).filter(o=>o.leg===leg);
    const closed=closes.reduce((sum,o)=>sum+o.executedQuantity,0);
    const reconciled=orders.every(o=>terminal.has(o.status));
    const done=reconciled&&closed>=opened-1e-12&&closes.every(o=>terminal.has(o.status));
    const current=run.stopProgress?.leg===leg?run.stopProgress:undefined;
    const exchange=exchanges.find(e=>e.id===trade[leg]);
    const label=done?(opened>0?'Закрыто':'Нет позиции')
      :!reconciled?(closing?'Отмена и сверка заявки':'Нужна сверка заявки')
      :current?.phase==='confirming'?(closing?'Подтверждение исполнения':'Исполнение не подтверждено')
      :current?.phase==='closing'||closes.length?'Закрытие маркетом':'Ожидает закрытия';
    return {key:`${run.id}:${leg}`,symbol:run.symbol.replace(/USDT$/,''),exchange,done,label,opened,closed,orderId:current?.orderId||closes.at(-1)?.orderId};
  }));
  const done=rows.filter(row=>row.done).length;
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/>
    <Dialog.Content className="dialog-content stop-dialog stop-progress-dialog">
      <div className={`stop-progress-icon ${closing?'active':''}`}>{stopped?<Check size={28}/>:pendingMode?<CircleNotch className="spin" size={28}/>:<WarningCircle size={28}/>}</div>
      <div className="stop-progress-heading"><Dialog.Title>{stopped?'Бот остановлен':'Остановка бота'}</Dialog.Title><Dialog.Description>{!stopped?'Останавливаем автоматическую торговлю в приложении. Подключение к бирже для этого не требуется.':manualPending?'Передаём оставшиеся позиции и заявки вам. После этого приложение не будет управлять ими.':closing?'Новые входы отключены. Выполняется запрошенное закрытие позиций. Вы можете прекратить закрытие и управлять остатком самостоятельно.':trade.closeStatus==='waiting_confirmation'&&trade.notice?.code==='close_rate_limit'?trade.notice.message:trade.closeStatus==='closed'?'Закрытие позиций подтверждено. Автоматическая торговля остановлена.':'Новые входы отключены. Позиции и заявки могут оставаться на биржах. Выберите, закрыть их через приложение или управлять ими самостоятельно.'}{stopped&&trade.closeStatus!=='closed'&&' Закрытие через приложение касается только сохранённого объёма этого бота.'}</Dialog.Description></div>
      {progress&&<div className="stop-progress-body">
        <div className="stop-progress-total"><span>{closing?'Закрытие позиций':'Подтверждено закрытие'}</span><strong>{done} / {rows.length||'—'}</strong></div>
        {rows.length>0&&<progress className="stop-progress-meter" aria-label="Прогресс закрытия позиций" max={rows.length} value={done}/>}
        <div className="stop-progress-rows">{rows.map(row=><div className={`stop-progress-row ${row.done?'done':''}`} key={row.key}>
          {row.exchange&&<img src={row.exchange.logo} alt=""/>}<div><strong>{row.exchange?.name} <span>{row.symbol}</span></strong><small>{row.label}</small>{row.orderId&&<small className="stop-order-id" title={row.orderId}>#{row.orderId}</small>}</div>
          <div className="stop-progress-quantity">{row.done?<Check size={17}/>:row.orderId?<CircleNotch size={17} className={closing?'spin':''}/>:<Clock size={17}/>}{row.opened>0&&<small>{formatValue(Math.min(row.closed,row.opened),8)} / {formatValue(row.opened,8)}</small>}</div>
        </div>)}</div>
        {!rows.length&&closing&&<div className="trade-notice info"><CircleNotch className="spin" size={17}/>Проверяем оставшиеся заявки…</div>}
      </div>}
      {(closeError||error)&&<div className="live-error" role="alert"><WarningCircle size={18}/><span>{progress?'Закрытие не подтверждено. ':''}{closeError||error}</span></div>}
      <div className="stop-actions">
        {!stopped&&<Button variant="danger" disabled={Boolean(pendingMode)} onClick={onPause}>{pendingMode==='pause'?<><CircleNotch className="spin" size={17}/>Останавливаем…</>:'Повторить Стоп'}</Button>}
        {trade.closeStatus!=='closed'&&<Button variant="danger" disabled={!stopped||busy} onClick={()=>onStop(true)}>{closing?<><CircleNotch className="spin" size={17}/>Закрываем позиции…</>:progress?'Повторить сверку и закрытие':'Закрыть позиции'}</Button>}
        {trade.closeStatus!=='closed'&&<Button variant="outline" disabled={manualPending} onClick={()=>onStop(false)}>{manualPending?<><CircleNotch className="spin" size={17}/>Передаём управление…</>:'Оставить позиции и заявки мне'}</Button>}
        <Dialog.Close asChild><Button variant="ghost">Вернуться в приложение</Button></Dialog.Close>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
