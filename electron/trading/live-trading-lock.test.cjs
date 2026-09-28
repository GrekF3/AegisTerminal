const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireLiveTradingLock, lockPath, readLock } = require('./live-trading-lock.cjs');

test('live trading lock is exclusive, owner-bound and recoverable after release', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-live-lock-'));
  try {
    const first = acquireLiveTradingLock('main-test', { root });
    assert.equal(readLock(lockPath(root)).owner, 'main-test');
    assert.throws(() => acquireLiveTradingLock('impulse-test', { root }), error => error.code === 'LIVE_TRADING_LOCKED');
    assert.equal(first.release(), true);
    const second = acquireLiveTradingLock('impulse-test', { root });
    assert.equal(second.release(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dead owner records are replaced but live foreign tokens are not released', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-live-lock-'));
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockPath(root), JSON.stringify({ version: 1, owner: 'dead', pid: 2147483647, token: 'old' }));
    const lock = acquireLiveTradingLock('new-owner', { root });
    fs.writeFileSync(lockPath(root), JSON.stringify({ version: 1, owner: 'other', pid: process.pid, token: 'other' }));
    assert.equal(lock.release(), false);
    assert.equal(readLock(lockPath(root)).owner, 'other');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('different LBank profiles have independent live locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-live-lock-'));
  try {
    const first = acquireLiveTradingLock('main', { root, resource: 'lbank:profile-a' });
    const second = acquireLiveTradingLock('impulse', { root, resource: 'lbank:profile-b' });
    assert.notEqual(first.file, second.file);
    assert.throws(() => acquireLiveTradingLock('other', { root, resource: 'lbank:profile-a' }), error => error.code === 'LIVE_TRADING_LOCKED');
    assert.equal(first.release(), true); assert.equal(second.release(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
