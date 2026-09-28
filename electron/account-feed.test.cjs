const test = require("node:test");
const assert = require("node:assert/strict");
const { AccountFeed } = require("./account-feed.cjs");

test('snapshot invalidation preserves positions, retries quickly and does not become an error', async () => {
  let time=1000, pending=false, calls=0;
  const positions=[{symbol:'ETHUSDT',quantity:.08}];
  const feed=new AccountFeed({now:()=>time,getAdapter:()=>({getAccount:async()=>({total:100,available:100}),getOpenOrders:async()=>[],getPositions:async()=>{
    calls++;if(pending)throw Object.assign(new Error('refresh'),{code:'SNAPSHOT_REFRESH_PENDING',retryAfterMs:250});return positions;
  }})});
  try {
    feed.configure(['lbank'],{lbank:{}});await feed.refresh();
    pending=true;await feed.refresh(true);
    assert.deepEqual(feed.snapshot().exchanges.lbank.positions,positions);
    assert.deepEqual(feed.snapshot().exchanges.lbank.errors,{});
    assert.equal(feed.snapshot().exchanges.lbank.status,'syncing');
    time+=249;await feed.refresh();assert.equal(calls,2);
    pending=false;time++;await feed.refresh();assert.equal(calls,3);
    assert.equal(feed.snapshot().exchanges.lbank.status,'live');
  } finally {feed.dispose();}
});

test('LBank keeps one-second balances but polls the three order lists only every five seconds', async () => {
  let time=1000, balances=0, orders=0;
  const feed=new AccountFeed({now:()=>time,getAdapter:()=>({getAccount:async()=>{balances++;return {total:100,available:100};},getPositions:async()=>[],getOpenOrders:async()=>{orders++;return [];}})});
  try {
    feed.configure(['lbank'],{lbank:{}});await feed.refresh();
    time+=1000;await feed.refresh();
    assert.equal(balances,2);assert.equal(orders,1);
    time+=5000;await feed.refresh();assert.equal(orders,2);
  } finally {feed.dispose();}
});

test('account feed respects the exchange cooldown instead of retrying in two seconds', async () => {
  let time=1000,calls=0;
  const feed=new AccountFeed({now:()=>time,getAdapter:()=>({getAccount:async()=>{calls++;throw Object.assign(new Error('rate limit'),{retryAfterMs:12000});},getPositions:async()=>[],getOpenOrders:async()=>[]})});
  try {
    feed.configure(['lbank'],{lbank:{}});await feed.refresh();
    time+=3000;await feed.refresh();assert.equal(calls,1);
    time+=9000;await feed.refresh();assert.equal(calls,2);
  } finally {feed.dispose();}
});

test("expensive Binance order snapshots are throttled without slowing balance polling", async () => {
  let time = 1000, balances = 0, orders = 0;
  const feed = new AccountFeed({ now: () => time, getAdapter: () => ({ getAccount: async () => { balances++; return { total: 100, available: 100 }; }, getPositions: async () => [], getOpenOrders: async () => { orders++; return []; } }) });
  try {
    feed.configure(["binance"], { binance: {} }); await feed.refresh();
    time += 1000; await feed.refresh();
    assert.equal(balances, 2); assert.equal(orders, 1);
    time += 10_000; await feed.refresh();
    assert.equal(balances, 3); assert.equal(orders, 2);
  } finally { feed.dispose(); }
});

test("slow orders do not delay later balance updates", async () => {
  let release; let balance = 100, calls = 0;
  const feed = new AccountFeed({ getAdapter: () => ({ getAccount: async () => ({ total: balance, available: balance }), getPositions: async () => [], getOpenOrders: () => { calls++; return new Promise((r) => { release = r; }); } }) });
  try {
    feed.configure(["a"], { a: {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(feed.snapshot().exchanges.a.account.total, 100);
    balance = 101; const refresh = feed.refresh(true);
    await new Promise((r) => setImmediate(r));
    assert.equal(feed.snapshot().exchanges.a.account.total, 101);
    assert.equal(calls, 1);
    release([]); await refresh;
  } finally { feed.dispose(); }
});

test("feed preserves last balance and marks stale on failure; successful empty positions clear old ones", async () => {
  let fail = false; let positions = [{ symbol: "BTCUSDT" }];
  const feed = new AccountFeed({ getAdapter: () => ({ getAccount: async () => { if (fail) throw new Error("timeout"); return { total: 123, available: 100 }; }, getPositions: async () => positions, getOpenOrders: async () => [] }) });
  try {
    feed.configure(["a"], { a: {} }); await feed.refresh();
    fail = true; positions = []; await feed.refresh(true);
    assert.equal(feed.snapshot().exchanges.a.account.total, 123);
    assert.equal(feed.snapshot().exchanges.a.status, "stale");
    assert.deepEqual(feed.snapshot().exchanges.a.positions, []);
  } finally { feed.dispose(); }
});
test("polls do not overlap and late result cannot revive a disconnected exchange", async () => {
  let resolve; let calls = 0;
  const feed = new AccountFeed({ getAdapter: () => ({ getAccount: () => { calls++; return new Promise((r) => { resolve = r; }); }, getPositions: async () => [], getOpenOrders: async () => [] }) });
  try {
    feed.configure(["a"], { a: {} }); const one = feed.refresh(true), two = feed.refresh(true);
    await new Promise((r) => setImmediate(r)); assert.equal(calls, 1);
    feed.configure([], {}); resolve({ total: 0, available: 0 }); await Promise.all([one, two]);
    assert.deepEqual(feed.snapshot().exchanges, {});
  } finally { feed.dispose(); }
});
