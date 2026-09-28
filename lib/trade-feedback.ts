import type { TradeSnapshot } from '@/types/desktop';

export function botIsStopped(trade: TradeSnapshot) {
  return trade.botStopped === true || (trade.state === 'stopped' && !trade.active);
}

export function canManageStoppedTrade(trade: TradeSnapshot) {
  const unresolved = trade.runs?.some(run => {
    const entries = [...(run.sourceOrders || []), ...(run.targetOrders || [run.targetOrder])].filter(order => order != null);
    const closes = run.closeOrders || [];
    return [...entries,...closes].some(order => !['FILLED','CANCELED','REJECTED','EXPIRED'].includes(order.status)) || ['source','target'].some(leg => entries.filter(order => order.leg === leg).reduce((sum,order) => sum + order.executedQuantity,0) > closes.filter(order => order.leg === leg).reduce((sum,order) => sum + order.executedQuantity,0) + 1e-12);
  });
  return !trade.active && Boolean(trade.requiresAttention || trade.closeStatus === 'closing' || trade.closeStatus === 'waiting_confirmation' || trade.closeStatus === 'failed' || (botIsStopped(trade) && ((!trade.manualManagement && trade.closeStatus === 'not_requested') || unresolved)));
}

export function tradeFeedback(trade: TradeSnapshot) {
  if (botIsStopped(trade)) {
    const closing = trade.closeStatus === 'closing';
    const closeError = trade.closeError || (trade.closeStatus === 'failed' || trade.closeStatus === 'waiting_confirmation' ? trade.error : undefined);
    return {
      error: undefined,
      closeError,
      notice: !trade.manualManagement && trade.closeStatus === 'waiting_confirmation' && !closeError && trade.notice ? trade.notice : {
        code: closing ? 'close_pending' : 'bot_stopped',
        level: 'info' as const,
        message: closing ? 'Бот остановлен. Выполняется запрошенное закрытие позиций.' : trade.manualManagement ? 'Бот остановлен. Позиции и заявки переданы вам для самостоятельного управления.' : trade.closeStatus === 'closed' ? 'Бот остановлен. Закрытие позиций подтверждено.' : 'Бот остановлен. Позиции и заявки могут оставаться на биржах.',
      },
    };
  }
  // A renderer update can arrive before the next safe restart of Electron.
  const legacyPending=trade.state==='waiting_exchange' && !trade.requiresAttention && /: ожидаем актуальный PnL$/.test(trade.error || '');
  const retrying = !trade.requiresAttention && ['waiting_retry', 'waiting_exchange', 'waiting_pnl'].includes(trade.state);
  return {
    error: retrying || legacyPending ? undefined : trade.error,
    closeError: trade.closeError,
    notice: trade.notice || (legacyPending ? {code:'pnl_pending',level:'info' as const,message:'Синхронизация PnL…'} : retrying ? {code:'automatic_retry',level:'info' as const,message:'Обновляем данные биржи. Проверка продолжится автоматически…'} : undefined),
  };
}
