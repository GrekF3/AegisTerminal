const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { attachUpdateStatus, updateFeed, artifactName } = require('./update-status.cjs');

test('feed uses single ranges and keeps channels isolated', () => {
  assert.deepEqual(updateFeed('https://example.test/', 'beta', 'win32', 'x64'), { provider: 'generic', url: 'https://example.test/updates/beta/win32/x64', useMultipleRangeRequest: false });
  assert.match(updateFeed('https://example.test', 'invalid', 'win32', 'x64').url, /\/stable\//);
});

test('status preserves artifact/version and exact transfer bytes; fallback resets delta progress', () => {
  const updater = new EventEmitter();
  const reporter = attachUpdateStatus(updater, { platform: 'win32' });
  updater.emit('update-available', { version: '1.0.1', files: [{ url: 'Hedge%20Setup%201.0.1.exe', size: 1000 }] });
  reporter.beginDownload();
  updater.logger.info('Download block maps (old: "https://e.test/Hedge%20Setup%201.0.0.exe.blockmap", new: https://e.test/Hedge%20Setup%201.0.1.exe.blockmap)');
  assert.deepEqual(reporter.getStatus().files, ['Hedge Setup 1.0.0.exe.blockmap', 'Hedge Setup 1.0.1.exe.blockmap']);
  updater.logger.info('Differential download: https://e.test/Hedge%20Setup%201.0.1.exe');
  updater.emit('download-progress', { transferred: 125, total: 250, bytesPerSecond: 62.5, percent: 50 });
  assert.equal(reporter.getStatus().fileName, 'Hedge Setup 1.0.1.exe');
  assert.equal(reporter.getStatus().version, '1.0.1');
  assert.equal(reporter.getStatus().reusedBytes, 750);
  assert.equal(reporter.getStatus().percent, 50);
  updater.logger.error('Cannot download differentially, fallback to full download: Error: corrupt cache');
  assert.equal(reporter.getStatus().total, 1000);
  assert.equal(reporter.getStatus().transferred, 0);
  assert.equal(reporter.getStatus().downloadMode, 'full');
  assert.equal(reporter.getStatus().reusedBytes, 0);
  updater.emit('download-progress', { transferred: 1000, total: 1000, bytesPerSecond: Infinity, percent: 100 });
  assert.equal(reporter.getStatus().phase, 'verifying');
  assert.equal(reporter.getStatus().state, 'downloading', '100% bytes is not proof of verified completion');
  assert.equal(reporter.getStatus().bytesPerSecond, undefined);
  updater.emit('error', new Error('Checksum failed'));
  assert.equal(reporter.getStatus().state, 'error');
  updater.emit('checking-for-update');
  assert.deepEqual(reporter.getStatus(), { state: 'checking' });
});

test('artifact labels contain filenames only, without URL secrets or control characters', () => {
  assert.equal(artifactName('https://user:password@example.test/dir/Hedge%20Setup.exe?token=secret'), 'Hedge Setup.exe');
  assert.equal(artifactName('https://example.test/dir/bad%0Aname.exe'), 'badname.exe');
  assert.equal(artifactName('https://example.test/bad%XX.exe'), undefined);
});

// Exercise the installed electron-updater implementation, including blockmap
// parsing, actual Range requests, cache reuse, assembly and SHA-512 validation.
// This executor replaces Electron's transport with loopback HTTP only; no updater
// install/quit method is called and every cache is in a fresh temporary directory.
class LoopbackExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) { return http.request(options, callback); }
  addRedirectHandlers() {}
}

async function fixture(t, { cache = 'valid', corruptDownload = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hedge-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const size = 65536;
  const oldBytes = Buffer.concat(['a', 'b', 'c', 'd'].map(value => Buffer.alloc(size, value)));
  const newBytes = Buffer.concat(['a', 'x', 'c', 'y'].map(value => Buffer.alloc(size, value)));
  const map = checksums => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums, sizes: Array(4).fill(size) }] }));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range });
    if (req.url.endsWith('.blockmap')) { res.end(req.url.includes('1.0.0') ? map(['a', 'b', 'c', 'd']) : map(['a', 'x', 'c', 'y'])); return; }
    const data = corruptDownload ? Buffer.alloc(newBytes.length, 'z') : newBytes;
    const range = req.headers.range;
    if (range?.includes(',')) {
      // Mirrors the production server bug: multipart type in the wrong header.
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'multipart/byteranges; boundary=broken' }); res.end('malformed multipart response'); return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    if (match) {
      const start = Number(match[1]), end = Number(match[2]);
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1)); return;
    }
    res.writeHead(200, { 'Content-Length': data.length }); res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const updater = new NsisUpdater(null, { version: '1.0.0', baseCachePath: directory });
  updater.configOnDisk = { value: Promise.resolve({ updaterCacheDirName: 'cache' }) };
  updater.httpExecutor = new LoopbackExecutor();
  updater.autoInstallOnAppQuit = false;
  const states = [];
  const reporter = attachUpdateStatus(updater, { platform: 'win32', publish: state => states.push(state) });
  updater.setFeedURL(updateFeed(`http://127.0.0.1:${server.address().port}`, 'stable', 'win32', 'x64'));
  const provider = await updater.clientPromise;
  assert.equal(provider.isUseMultipleRangeRequest, false);
  const info = { version: '1.0.1', files: [{ url: 'Hedge Setup 1.0.1.exe', size: newBytes.length, sha512: crypto.createHash('sha512').update(newBytes).digest('base64') }] };
  updater.updateInfoAndProvider = { info, provider };
  updater.emit('update-available', info);
  const helper = await updater.getOrCreateDownloadHelper();
  await fs.mkdir(helper.cacheDir, { recursive: true });
  if (cache !== 'missing') await fs.writeFile(path.join(helper.cacheDir, 'installer.exe'), cache === 'corrupt' ? Buffer.alloc(oldBytes.length, 'z') : oldBytes);
  return { updater, reporter, states, requests, newBytes };
}

test('real NSIS delta downloads only changed ranges and validates the assembled installer', async t => {
  const f = await fixture(t);
  const [downloaded] = await f.updater.downloadUpdate();
  assert.deepEqual(await fs.readFile(downloaded), f.newBytes);
  const installerRequests = f.requests.filter(request => !request.path.endsWith('.blockmap'));
  assert.deepEqual(installerRequests.map(request => request.range), ['bytes=65536-131071', 'bytes=196608-262143']);
  assert.ok(f.states.some(state => state.total === 131072 && state.reusedBytes === 131072));
  assert.equal(f.reporter.getStatus().state, 'ready');
  const count = f.requests.length;
  await f.updater.downloadUpdate();
  assert.equal(f.requests.length, count, 'a verified pending update is reused without a network download');
});

for (const cache of ['missing', 'corrupt']) test(`real NSIS ${cache} cache safely falls back to one verified full download`, async t => {
  const f = await fixture(t, { cache });
  const [downloaded] = await f.updater.downloadUpdate();
  assert.deepEqual(await fs.readFile(downloaded), f.newBytes);
  assert.equal(f.requests.filter(request => !request.path.endsWith('.blockmap') && !request.range).length, 1);
  assert.ok(f.states.some(state => state.downloadMode === 'full' && state.fallbackReason));
  assert.equal(f.reporter.getStatus().state, 'ready');
});

test('real NSIS never marks a corrupt download ready', async t => {
  const f = await fixture(t, { corruptDownload: true });
  await assert.rejects(f.updater.downloadUpdate(), /checksum mismatch/i);
  assert.equal(f.states.some(state => state.state === 'ready'), false);
  assert.equal(f.reporter.getStatus().state, 'error');
});
