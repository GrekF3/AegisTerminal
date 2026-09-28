#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { browser } = require('../../electron/exchanges/lbank-browser.cjs');
const { ImpulseEngine, safeError } = require('./engine.cjs');
const { IdempotentDispatcher } = require('./protocol.cjs');
const { PortfolioAnalyzer } = require('./portfolio-analyzer.cjs');
const { PortfolioSupervisor } = require('./portfolio-supervisor.cjs');

const engine = new ImpulseEngine({ browser });
const analyzer = new PortfolioAnalyzer();
const portfolio = new PortfolioSupervisor({ engine, analyzer });
let outputOpen = true;
const send = value => {
  if (!outputOpen || process.stdout.destroyed) return false;
  try { return process.stdout.write(`${JSON.stringify(value)}\n`); }
  catch { outputOpen = false; return false; }
};
process.stdout.on('error', () => { outputOpen = false; });
engine.on('event', value => { portfolio.onEngineEvent(value); send(value); });
analyzer.on('event', send);
portfolio.on('event', send);

async function execute(command, params) {
  if (command === 'profiles') return engine.listProfiles();
  if (command === 'symbols') return engine.listSymbols();
  if (command === 'save_settings') return engine.saveDraft(params);
  if (command === 'connect') {
    const result = await engine.connect(params?.profileId);
    try { analyzer.setFeeRows(await browser.getFeeRates(engine.credentials)); } catch {}
    return result;
  }
  if (command === 'configure') return engine.configure(params);
  if (command === 'start') {
    if (engine.config?.mode === 'live') {
      const cooldown = portfolio.cooldownRemainingMs();
      if (cooldown > 0) throw new Error(`Глобальный cooldown: следующий Live-вход через ${Math.ceil(cooldown / 1000)} сек`);
      const gate = analyzer.store.canTrade(engine.config.symbol);
      if (!gate.allowed) throw new Error(`${engine.config.symbol}: Live-вход заблокирован правилом ${gate.reason}`);
    }
    return engine.start();
  }
  if (command === 'pause') return engine.pause();
  if (command === 'portfolio_start') return portfolio.start();
  if (command === 'portfolio_pause') return portfolio.pause();
  if (command === 'portfolio_snapshot') return portfolio.publicState();
  if (command === 'flatten') { await portfolio.pause({ touchEngine: false }); return engine.flatten('manual_flatten'); }
  if (command === 'snapshot') return engine.publicState();
  if (command === 'analyzer_start') return analyzer.start();
  if (command === 'analyzer_pause') return analyzer.pause();
  if (command === 'analyzer_snapshot') return analyzer.publicState();
  if (command === 'shutdown') {
    const [result] = await shutdown();
    setTimeout(() => process.exit(0), 20).unref?.(); return result || { ok: true };
  }
  throw new Error('Неизвестная команда sidecar');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const dispatcher = new IdempotentDispatcher(execute, safeError);
input.on('line', async line => {
  let request;
  try { request = JSON.parse(line); }
  catch { return send({ v: 1, type: 'response', requestId: null, ok: false, error: { message: 'Некорректный JSONL-запрос' } }); }
  send(await dispatcher.dispatch(request));
});

send({ v: 1, type: 'hello', at: Date.now(), protocol: 1, state: engine.publicState() });
setImmediate(() => void analyzer.start());
let shutdownPromise = null;
function shutdown() {
  if (!shutdownPromise) shutdownPromise = portfolio.shutdown().then(() => Promise.all([engine.shutdown(), analyzer.shutdown()]));
  return shutdownPromise;
}
input.on('close', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
process.on('uncaughtException', error => { send({ v: 1, type: 'error', at: Date.now(), error: safeError(error), fatal: true }); });
process.on('unhandledRejection', error => { send({ v: 1, type: 'error', at: Date.now(), error: safeError(error), fatal: true }); });
