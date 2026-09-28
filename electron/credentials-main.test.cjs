const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual main-process reader and IPC handlers without opening Electron,
// decrypting a real profile or accessing an exchange.
const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const reader = main.slice(main.indexOf('function loadEncryptedCredentials()'), main.indexOf('ipcMain.handle("window:action"'));
const handlers = main.slice(main.indexOf('ipcMain.handle("credentials:load"'), main.indexOf('ipcMain.handle("market:exchange"'));
function fixture(initial = {}) {
  let saved = JSON.stringify(initial), reads = 0, disconnects = 0;
  const ipc = new Map();
  const disk = {
    readFileSync: () => { reads++; return saved; },
    writeFileSync: (_file, value) => { saved = value; },
    mkdirSync: () => {},
  };
  const context = vm.createContext({
    fs: disk, path, credentialsPath: () => '/test/credentials.bin',
    safeStorage: { isEncryptionAvailable: () => true, decryptString: value => value, encryptString: value => value },
    ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
    rememberSensitiveValues: () => {}, restoreTradingSession: () => {}, tradingSession: null,
    logEvent: () => {}, feeRateCache: { clear: () => {} },
    require: name => { assert.equal(name, './exchanges/lbank-browser.cjs'); return { browser: { disconnect: () => { disconnects++; } } }; },
  });
  vm.runInContext(reader + handlers, context);
  return { context, disk, load: () => ipc.get('credentials:load')(), save: value => ipc.get('credentials:save')(null, value), reads: () => reads, disconnects: () => disconnects };
}

test('main credentials reader decrypts once without recursion or disconnecting LBank', () => {
  const f = fixture({ lbank: { connectionMode: 'undetectable', profileId: 'test-profile' } });
  assert.equal(f.load().lbank.profileId, 'test-profile');
  assert.equal(f.reads(), 1);
  assert.equal(f.disconnects(), 0);
});

test('missing credentials are empty; corrupt credentials are not overwritten', () => {
  const f = fixture();
  f.disk.readFileSync = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.equal(Object.keys(f.load()).length, 0);
  f.disk.readFileSync = () => 'invalid encrypted contents';
  assert.equal(f.load(), null);
  assert.throws(() => f.save({}), /прочитать сохранённые ключи/);
});

test('saving credentials disconnects LBank only after a successful change', () => {
  const initial = { lbank: { profileId: 'first' } };
  const f = fixture(initial);
  f.save({ ...initial, bybit: { apiKey: 'test' } });
  assert.equal(f.disconnects(), 0);
  f.save({ lbank: { profileId: 'second' } });
  assert.equal(f.disconnects(), 1);
  f.disk.writeFileSync = () => { throw new Error('disk full'); };
  assert.throws(() => f.save({ lbank: { profileId: 'third' } }), /disk full/);
  assert.equal(f.disconnects(), 1);
});
