const test = require('node:test');
const assert = require('node:assert/strict');
const { IdempotentDispatcher } = require('./protocol.cjs');

const errorView = error => ({ message: error.message });

test('concurrent and completed duplicate request IDs execute exactly once', async () => {
  let calls = 0, release;
  const dispatcher = new IdempotentDispatcher(async () => { calls++; await new Promise(resolve => { release = resolve; }); return { orderId: '1' }; }, errorView);
  const request = { v: 1, requestId: 'same-id', command: 'flatten', params: {} };
  const first = dispatcher.dispatch(request), second = dispatcher.dispatch(request);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release();
  assert.deepEqual(await first, await second); assert.deepEqual(await dispatcher.dispatch(request), await first); assert.equal(calls, 1);
});

test('protocol rejects unknown versions and malformed IDs before execution', async () => {
  let calls = 0; const dispatcher = new IdempotentDispatcher(async () => { calls++; }, errorView);
  assert.equal((await dispatcher.dispatch({ v: 2, requestId: 'id', command: 'start' })).ok, false);
  assert.equal((await dispatcher.dispatch({ v: 1, requestId: 'bad id', command: 'start' })).ok, false);
  assert.equal(calls, 0);
});
