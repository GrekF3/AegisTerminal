"use client";
import { Check, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import type { TradeSnapshot } from '@/types/desktop';
import { tradeFeedback } from '@/lib/trade-feedback';

export function TradeNotice({trade}: {trade: TradeSnapshot}) {
  const {notice}=tradeFeedback(trade);
  if(!notice) return null;
  return <div className={`trade-notice ${notice.level}`} role="status" aria-live="polite">
    {notice.code==='bot_stopped'?<Check size={17}/>:notice.level==='info'?<CircleNotch className="spin" size={17}/>:<WarningCircle size={17}/>}
    <span>{notice.message}{notice.exchanges?.length?<small>{notice.exchanges.join(' · ').toUpperCase()}</small>:null}</span>
  </div>;
}
