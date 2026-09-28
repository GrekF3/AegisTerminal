// Capabilities describe verified wire mappings, not just support for LIMIT orders.
function executionPolicy(sourceAdapter, targetAdapter, input = {}) {
  const supports = (adapter, credentials) => typeof adapter?.supportsPostOnly === 'function'
    ? adapter.supportsPostOnly(credentials) === true : adapter?.supportsPostOnly === true;
  const prefersImmediate = (adapter, credentials) => typeof adapter?.preferImmediateHedge === 'function'
    ? adapter.preferImmediateHedge(credentials) === true : adapter?.preferImmediateHedge === true;
  const sourcePostOnly = supports(sourceAdapter, input.sourceCredentials);
  const immediateTarget = prefersImmediate(targetAdapter, input.targetCredentials);
  const targetPostOnly = !immediateTarget && sourcePostOnly && supports(targetAdapter, input.targetCredentials);
  return {
    version: 3,
    firstLeg: 'source',
    sourcePostOnly,
    targetPostOnly,
    immediateTarget,
    targetMarketAttempts: immediateTarget ? 3 : 1,
    makerWaitMs: 1500,
    repriceMs: 1000,
  };
}
module.exports = { executionPolicy };
