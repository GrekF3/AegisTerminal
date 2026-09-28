const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const output = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../lib/trading-notifications.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exportsObject = {};
vm.runInNewContext(output, { exports: exportsObject });
const { createTradingNotifications } = exportsObject;

test('startup retries and prolonged automatic reconciliation never interrupt the user', () => {
  const notify = createTradingNotifications();
  for (let i = 0; i < 1000; i++) {
    assert.equal(notify({id:'session',state:'waiting_retry',error:`retry ${i}`}), null);
    assert.equal(notify({id:'session',state:'waiting_exchange',error:`snapshot ${i}`}), null);
    assert.equal(notify({id:'session',state:'waiting_pnl',notice:{code:'pnl_pending',level:'warning',message:`loading ${i}`}}), null);
    assert.equal(notify({id:'session',state:'stopped',requiresAttention:true,notice:{code:'order_reconciliation',level:'warning',message:`checking ${i}`}}), null);
  }
});
test('critical failure interrupts once even across recovery status updates; new session can alert', () => {
  const notify = createTradingNotifications();
  const failure = {id:'one',state:'emergency',requiresAttention:true,error:'Unhedged exposure'};
  assert.equal(notify(failure).message, failure.error);
  assert.equal(notify(failure), null);
  notify({id:'one',state:'waiting_exchange'});
  assert.equal(notify(failure), null);
  assert.equal(notify({...failure,id:'two'}).message, failure.error);
  assert.equal(notify({...failure,id:'two',error:'Different critical problem'}).kind, 'error');
});
test('failed closure and loss limit still alert', () => {
  const notify = createTradingNotifications();
  assert.equal(notify({state:'stopped',requiresAttention:true,closeError:'Closure failed'}).kind,'error');
  assert.equal(notify({state:'stopped',notice:{code:'loss_limit',level:'warning',message:'Loss limit reached'}}).kind,'warning');
});
