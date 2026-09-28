# Adaptive hedge entry (execution version 3)

Normal **Start** in `ContinuousHedgeSession` now uses `AdaptiveHedgeEngine`.
The target remains the trend-following venue; the source is always opposite.
Their account/PnL roles do not depend on which order is submitted first.

1. Preflight reads both accounts, positions, open orders, contract rules, both
   books and the target's current UTC-day open. Quantity is a common base-asset
   step, not a shared number of contracts. The source and target can have different
   contract multipliers.
2. Place the **source** limit at its own best bid (BUY) / ask (SELL). Use Post-Only
   if that connection has a verified mapping. Check the book every 1 second,
   without canceling unchanged prices. Source fill status is polled every 500 ms.
3. To reprice: cancel the exact previous ID, confirm its final status and cumulative
   fill, hedge any late fills, then submit only the remaining amount at a fresh
   price. Never overlap replacements. Quote age before dispatch is capped at 3 s.
   Repricing may reduce quantity to the common step to stay inside the original
   per-coin margin × leverage allocation; it never increases that budget.
4. When a source fill is observed, freeze its remaining limit before sending the
   target leg. LBank in Undetectable mode is always hedged with **immediate MARKET**:
   there is no target maker wait or cancel cycle. Other verified connections may
   attempt the target maker at their own bid/ask when both legs support Post-Only.
5. The user's **1500 ms** maker deadline starts at observed source fill and includes
   source cancellation, quote and target preparation. Slow preparation skips the
   maker attempt. There is no second 1500 ms window after partial fills. At expiry,
   cancel and confirm the target limit, then MARKET only the unmatched amount.
   Network response/cancellation latency can extend real time beyond this deadline:
   an unconfirmed cancellation must never trigger a duplicate market order.
6. After 60 s without completing a round, cancel/reconcile and settle any known
   exposure. The continuous supervisor replans/retries automatically. Unknown
   order outcomes stop new entries and require reconciliation, not blind retries.

For an immediate LBank target, the source order is allowed only when the smallest
possible source fill is an exact valid LBank quantity and meets its minimum. The
target book is read again before every source placement. A terminal partial LBank
MARKET/FAK fill is topped up at most twice, each time with a new persisted intent;
an UNKNOWN or non-terminal order is never duplicated. LBank placement also uses
one fresh account-owner binding immediately before dispatch instead of two
identical bindings separated by the one-request-per-second limiter.

Price equality across venues and two maker fills are **not guaranteed**. Post-Only
enforces maker execution for the order that fills, not a guaranteed fill. Entry
impact estimates reserve for target MARKET fallback. Fees/funding/closing costs
are separate. A partial amount below the other venue's minimum/step is not rounded
away and called hedged: the entry is unwound, or marked emergency if closure cannot
be confirmed.

## Verified mappings

| Connection | Wire field |
| --- | --- |
| LBank Undetectable Futures | `OrderPriceType="0"`, `OrderType="3"` (`ONLY_MAKER`) |
| OKX swap | `ordType="post_only"` |
| Binance USDT futures | `timeInForce="GTX"` |
| Bybit linear | `timeInForce="PostOnly"` |
| Gate USDT futures | `tif="poc"` |
| Bitget USDT futures | `force="post_only"` |

LBank API mode and MEXC are not advertised as maker-capable by this change. No
unsupported Post-Only enum is silently invented for those connection modes.

Sources checked 2026-09-07: [OKX](https://www.okx.com/docs-v5/),
[Binance](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order),
[Bybit](https://bybit-exchange.github.io/docs/v5/order/create-order),
[Gate SDK](https://github.com/gateio/gateapi-nodejs/blob/master/model/futuresOrder.ts),
[Bitget](https://www.bitget.com/api-doc/classic/contract/trade/Place-Order),
[LBank order types](https://www.lbank.com/support/articles/21425396248089).
LBank's public Futures client confirmed `InstructType.ONLY_MAKER="3"` in
`_app-a3f5c98f085101a6.js` and its actual `SendOrderInsert` payload selection in
`52606-7837217d770f8b42.js`; inspected using `output/inspect-lbank-web.cjs` without
loading a signed-in browser.

## Journal and compatibility

Version-2 runs retain all `targetOrders`, `sourceOrders`, `closeOrders`, limit prices
and Post-Only flags. Intent is persisted before each request. History, live UI,
PnL accounting and recovery include every replacement and fallback exactly once.
Legacy `targetOrder` journals remain readable; recovery never starts new entries.
UI preserves the old routing labels for an active legacy session until it stops.

The installed release/update feed is unchanged. After the user's development
session reached `stopped` with `active=false` and `requiresAttention=false`, only
the local development Electron process was restarted to load this code. No active
hedge was interrupted. LBank Undetectable must be attached manually again.
Local fixtures and isolated browser QA do not prove live fills, network timing or
actual charged fees.
