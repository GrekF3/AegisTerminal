// Serialized into the selected document. Strong references survive CDP's weak
// Promise handles; receipts contain only the SDK's normalized result, no auth data.
function retainFuturesCommand(execute, operation, args, identity, context, requestId) {
  const registry = self[Symbol.for('hedge.lbank.receipts.v1')] ||= new Map();
  const key = JSON.stringify([context.scope, requestId]);
  const signature = JSON.stringify([operation, args, identity]);
  const previous = registry.get(key);
  if (previous) {
    if (previous.signature !== signature) return { ok: false, error: 'LBank: ID запроса уже использован с другими параметрами' };
    return previous.promise;
  }
  // Never evict unresolved commands or acknowledged writes: their outcome may
  // still need reconciliation. Bound memory by refusing new work, not resending.
  if (registry.size >= 128) for (const [id, entry] of registry) {
    if (!entry.write && entry.done) registry.delete(id);
  }
  if (registry.size >= 4096) return { ok: false, definitive: true, error: 'LBank: журнал вкладки заполнен. Завершите текущую сессию перед переподключением.' };
  const entry = { signature, identity, write: ['place', 'cancel', 'leverage', 'protect', 'cancelProtection'].includes(operation), done: false, response: null, promise: null };
  registry.set(key, entry);
  let execution;
  try { execution = execute(operation, args, identity, context); }
  catch { execution = { ok: false, error: 'LBank: выполнение команды во вкладке прервано; результат требует сверки' }; }
  entry.promise = Promise.resolve(execution).catch(() => ({
    ok: false, error: 'LBank: выполнение команды во вкладке прервано; результат требует сверки',
  })).then(response => {
    entry.response = response; entry.done = true;
    return response;
  });
  return entry.promise;
}

// Read-only lookup. In particular, a missing receipt NEVER executes a command.
function peekFuturesReceipt(scope, requestId, identity) {
  const entry = self[Symbol.for('hedge.lbank.receipts.v1')]?.get(JSON.stringify([scope, requestId]));
  if (!entry) return { state: 'missing' };
  if (entry.identity !== identity) return { state: 'mismatch' };
  return entry.done ? { state: 'done', response: entry.response } : { state: 'pending' };
}
module.exports = { retainFuturesCommand, peekFuturesReceipt };
