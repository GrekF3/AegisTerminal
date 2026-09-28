const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function defaultRoot() {
  const appData = process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  if (!appData) throw new Error('Не удалось определить каталог общей блокировки торговли');
  return path.join(appData, 'Hedge LBank');
}

function resourceKey(resource = 'global') {
  const value = String(resource || 'global').trim();
  if (!value || value.length > 256) throw new Error('Некорректный ресурс блокировки торговли');
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function lockPath(root = defaultRoot(), resource = 'global') {
  return path.join(path.resolve(root), `live-trading-${resourceKey(resource)}.lock`);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function readLock(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { invalid: true };
  }
}

class LiveTradingLock {
  constructor(file, record) {
    this.file = file;
    this.record = record;
    this.released = false;
  }

  release() {
    if (this.released) return false;
    this.released = true;
    const current = readLock(this.file);
    if (!current || current.token !== this.record.token || current.pid !== process.pid) return false;
    try { fs.unlinkSync(this.file); return true; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; return false; }
  }
}

function acquireLiveTradingLock(owner, options = {}) {
  const safeOwner = String(owner || '').trim();
  if (!/^[A-Za-z0-9_. -]{1,80}$/.test(safeOwner)) throw new Error('Некорректный владелец блокировки торговли');
  const resource = String(options.resource || 'global').trim(), file = lockPath(options.root, resource);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { version: 1, owner: safeOwner, resourceKey: resourceKey(resource), pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8'); }
      finally { fs.closeSync(descriptor); }
      return new LiveTradingLock(file, record);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readLock(file);
      if (current && !current.invalid && processAlive(Number(current.pid))) {
        throw Object.assign(new Error(`Live-торговля уже занята процессом «${String(current.owner || 'unknown').slice(0, 80)}»`), {
          code: 'LIVE_TRADING_LOCKED', owner: current.owner, pid: current.pid,
        });
      }
      try { fs.unlinkSync(file); }
      catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw new Error('Не удалось очистить устаревшую блокировку Live-торговли'); }
    }
  }
  throw new Error('Не удалось получить блокировку Live-торговли');
}

module.exports = { acquireLiveTradingLock, LiveTradingLock, lockPath, processAlive, readLock, resourceKey };
