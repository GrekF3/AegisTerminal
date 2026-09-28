const crypto = require("crypto");
const { HedgeSession } = require("./hedge-session.cjs");
const { HedgeEngine } = require("./hedge-engine.cjs");
const { ContinuousHedgeSession } = require('./continuous-session.cjs');
const { allocation } = require('./hedge-plan.cjs');

function credentialFingerprint(credentials, source, target) {
  // Include signing secrets and connection mode, with stable ordering. Never persist raw credentials.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return crypto.createHash("sha256").update(JSON.stringify(canonical({ source, target, credentials: { [source]: credentials[source] || {}, [target]: credentials[target] || {} } }))).digest("hex");
}

function recoverSession(journal, credentials, getAdapter) {
  const value = journal.snapshot;
  if (!value?.active && !value?.requiresAttention) return null;
  const botStopped = value.botStopped === true;
  if (journal.fingerprint !== credentialFingerprint(credentials, value.source, value.target)) throw new Error("Есть незавершённый хедж с другими API-ключами. Восстановите исходные подключения.");
  const adapters = { sourceAdapter: getAdapter(value.source), targetAdapter: getAdapter(value.target) };
  if (!adapters.sourceAdapter || !adapters.targetAdapter || !Array.isArray(value.runs)) throw new Error("Не удалось восстановить журнал хеджа. Проверьте позиции перед новым запуском.");
  const session = value.strategy === 'continuous-intraday' ? new ContinuousHedgeSession(adapters) : new HedgeSession(adapters);
  const symbols=Array.isArray(value.symbols)&&value.symbols.length?value.symbols:value.runs.map(run=>run.symbol);
  const leverageBySymbol=Object.fromEntries(value.runs.map(run=>[run.symbol,Number(run.leverage)]));
  session.config = { source: value.source, target: value.target, symbols, totalMargin:Number(value.totalMargin), leverageBySymbol,
    marginMode:value.runs[0]?.marginMode||'isolated', maxLosses: value.maxLosses ?? 5, hedgePercent: value.hedgePercent ?? 98,
    sourceCredentials: credentials[value.source], targetCredentials: credentials[value.target],dryRun:false,liveConfirmation:'LIVE_TRADING_CONFIRMED',acceptImpact:false };
  session.engines = value.runs.map((run) => {
    const engine = new HedgeEngine(adapters);
    engine.run = run; engine.state = run.state;
    if (botStopped) {
      engine.botStopped = true; engine.stopRequested = true; engine.state = 'stopped';
      engine.run = { ...run, botStopped: true, state: 'stopped', active: false };
    }
    engine.config = { ...session.config, ...run };
    // Recovery closes must also persist intent before reaching the exchange.
    engine.on("state", (state) => session.publish({ state: state.state, currentSymbol: run.symbol }));
    return engine;
  });
  session.state = { ...value, state: "recovery_required", active: true, requiresAttention: true, error: "Приложение перезапускалось во время хеджа. Проверьте позиции и завершите предыдущий цикл; новые ордера не отправлены." };
  if (botStopped) {
    session.botStopped = true; session.stopRequested = true; session.blockEntries = true;
    session.appStoppedAt = value.appStoppedAt;
    const interrupted = ['closing', 'waiting_confirmation'].includes(value.closeStatus);
    session.state = { ...value, runs: session.engines.map(engine => engine.snapshot()), state: 'stopped', active: false, botStopped: true,
      requiresAttention: value.closeStatus === 'closed' ? Boolean(value.lossLimitReached) : true,
      closeStatus: interrupted ? 'failed' : value.closeStatus || 'not_requested',
      closeError: interrupted ? 'Закрытие не подтверждено: приложение перезапускалось. Можно повторить закрытие или оставить позиции под ручным управлением.' : value.closeError,
      error: undefined };
  } else if (value.lossLimitReached && !value.active) session.state = { ...value, state: 'loss_limit', active: false, requiresAttention: true };
  else if(value.strategy==='continuous-intraday' && value.active && value.runs.length>0
    && value.runs.every(run=>run.state==='running' && run.serverProtected===true && Array.isArray(run.protections)
      && run.protections.length===2 && run.protections.every(item=>item.orderId && String(item.status).toUpperCase()==='ACTIVE'))) {
    session.allocations=allocation(session.config);
    session.blockEntries=true;session.protectionRecoveryPending=true;
    session.state={...value,state:'recovering_protection',active:true,requiresAttention:false,error:undefined,
      notice:{code:'protection_recovery',level:'info',message:'Проверяем серверные TP/SL после перезапуска; новые входы временно заблокированы.'}};
    session.scheduleMonitor();
  }
  return session;
}

module.exports = { credentialFingerprint, recoverSession };
