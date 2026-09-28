const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const version = require('../package.json').version;
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const manifest = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
const file = `Hedge LBank Setup ${version}.exe`;
const installer = fs.readFileSync(path.join(release, file));
const blockmap = fs.readFileSync(path.join(release, file + '.blockmap'));
assert.equal(manifest.version, version);
assert.equal(manifest.path, file);
assert.equal(manifest.files.length, 1);
assert.equal(manifest.files[0].url, file);
assert.equal(manifest.files[0].size, installer.length);
assert.equal(manifest.sha512, hash(installer, 'sha512', 'base64'));
assert.equal(manifest.files[0].sha512, manifest.sha512);

const archive = path.join(release, 'win-unpacked', 'resources', 'app.asar');
const packed = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\//, ''));
const appPackage = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(appPackage.version, version);
assert.deepEqual(Object.keys(appPackage.dependencies).sort(), ['electron-updater', 'https-proxy-agent', 'socks-proxy-agent', 'ws']);
assert.ok(packed.includes('node_modules/ws/index.js'), 'Missing WebSocket runtime');
for (const dependency of ['next', 'react', 'react-dom', 'sharp', '@next', '@fontsource-variable', '@phosphor-icons']) {
  assert.equal(packed.some(name => name.startsWith(`node_modules/${dependency}/`)), false, `Build dependency in runtime: ${dependency}`);
}
const sourceFiles = packed.filter(name => name.startsWith('electron/') && name.endsWith('.cjs'));
assert.ok(sourceFiles.length > 20);
for (const name of sourceFiles) {
  assert.ok(!name.endsWith('.test.cjs') && !name.endsWith('/fixtures.cjs'), 'Test fixture in installer');
  assert.equal(hash(asar.extractFile(archive, path.normalize(name))), hash(fs.readFileSync(path.join(root, name))), `Stale bundled source: ${name}`);
}
const webFiles = packed.filter(name => name.startsWith('out/') && fs.existsSync(path.join(root, name)) && fs.statSync(path.join(root, name)).isFile());
assert.ok(webFiles.length > 10, 'Missing static application files');
for (const name of webFiles) {
  assert.equal(hash(asar.extractFile(archive, path.normalize(name))), hash(fs.readFileSync(path.join(root, name))), `Stale bundled interface: ${name}`);
}
assert.equal(packed.some(name => /^(output|scripts|server|\.git)\//.test(name)), false, 'Development directory in installer');
assert.equal(packed.some(name => /(^|\/)(credentials\.bin|settings\.ini|hedge-session\.json|device\.id|\.env)$/.test(name)), false, 'Private profile data in installer');
for (const name of ['electron/trading/pnl-target.cjs', 'electron/trading/continuous-session.cjs', 'electron/trading/adaptive-hedge-engine.cjs', 'electron/exchanges/lbank-browser.cjs', 'out/index.html', 'out/app-icon.png']) {
  assert.ok(packed.includes(name), `Missing runtime asset: ${name}`);
}
const hashes = { installerSha512: hash(installer, 'sha512'), manifestSha256: hash(fs.readFileSync(path.join(release, 'latest.yml'))), blockmapSha256: hash(blockmap) };
console.log(JSON.stringify({ local: 'verified', version, bytes: installer.length, runtimeFiles: sourceFiles.length, webFiles: webFiles.length, noFixturesOrCredentials: true, ...hashes }));

const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
async function verifyPublished(channel, fullDownload) {
  const base = `https://hedge.swallet.site/updates/${channel}/win32/x64/`;
  const response = await request(base + 'latest.yml?verify=' + Date.now());
  assert.equal(response.status, 200, `${channel}: manifest unavailable`);
  const published = yaml.load(await response.text());
  assert.equal(published.version, version);
  assert.equal(published.sha512, manifest.sha512);
  assert.deepEqual(published.files, manifest.files);
  const url = base + encodeURIComponent(file);
  const head = await request(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), installer.length);
  const range = await request(url, { headers: { Range: 'bytes=0-63' } });
  assert.equal(range.status, 206);
  assert.ok(Buffer.from(await range.arrayBuffer()).equals(installer.subarray(0, 64)));
  const map = await request(url + '.blockmap');
  assert.equal(map.status, 200);
  assert.equal(hash(Buffer.from(await map.arrayBuffer())), hashes.blockmapSha256);
  if (fullDownload) {
    const download = await request(url);
    assert.equal(download.status, 200);
    const digest = crypto.createHash('sha512'); let bytes = 0;
    for await (const chunk of download.body) { digest.update(chunk); bytes += chunk.length; }
    assert.equal(bytes, installer.length);
    assert.equal(digest.digest('base64'), manifest.sha512);
  }
  return { channel, version, available: true, rangeAndBlockmap: true, fullDownloadVerified: fullDownload, url };
}
if (process.argv.includes('--published')) {
  Promise.all([verifyPublished('stable', true), verifyPublished('beta', false)])
    .then(results => console.log(JSON.stringify({ published: results }, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
