const path = require('node:path');

// Keep the generic feed on single byte ranges. The deployment's static-file server
// returns malformed multipart headers, which makes electron-updater discard the
// delta and download the entire installer. Single ranges also report exact totals.
function updateFeed(serverUrl, channel, platform = process.platform, arch = process.arch) {
  return { provider: 'generic', url: `${serverUrl.replace(/\/$/, '')}/updates/${channel === 'beta' ? 'beta' : 'stable'}/${platform}/${arch}`, useMultipleRangeRequest: false };
}

function artifactName(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const name = path.posix.basename(decodeURIComponent(new URL(value, 'https://update.invalid/').pathname).replace(/\\/g, '/'));
    return name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || undefined;
  } catch { return undefined; }
}
function finiteBytes(value) { return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined; }

function attachUpdateStatus(updater, { publish, log = () => {}, platform = process.platform } = {}) {
  let status = { state: 'idle' };
  let artifact = {};
  const emit = (value) => { status = { ...value }; publish?.({ ...status }); return { ...status }; };
  const transfer = (value) => emit({ ...status, ...artifact, state: 'downloading', ...value });
  const beginDownload = () => transfer({ phase: 'preparing', files: artifact.fileName ? [artifact.fileName] : [], percent: undefined, transferred: undefined, total: undefined, bytesPerSecond: undefined, downloadMode: undefined, fallbackReason: undefined, reusedBytes: undefined });
  const onLog = (level, input) => {
    const message = String(input?.message || input || '');
    // These messages are diagnostic signals only: never use them to decide whether
    // a file is valid or ready. electron-updater retains its SHA-512/cache checks.
    if (message.startsWith('Download block maps ')) {
      const files = [...message.matchAll(/https?:\/\/[^\s"),]+/g)].map(match => artifactName(match[0])).filter(Boolean);
      transfer({ phase: 'preparing', files: [...new Set(files)], percent: undefined, transferred: undefined, total: undefined, bytesPerSecond: undefined });
    } else if (message.startsWith('Differential download:')) {
      transfer({ phase: 'downloading', downloadMode: 'differential', files: artifact.fileName ? [artifact.fileName] : [], percent: 0 });
    } else if (message.includes('fallback to full download:') || message.includes('falling back to full download')) {
      const missingCache = /ENOENT|previous update\.zip/.test(message);
      transfer({ phase: 'downloading', downloadMode: 'full', files: artifact.fileName ? [artifact.fileName] : [], percent: 0, transferred: 0, total: artifact.artifactSize, bytesPerSecond: undefined, reusedBytes: 0,
        fallbackReason: missingCache ? 'Нет сохранённой копии для сравнения; загружаем полный пакет.' : 'Загрузка изменений недоступна; загружаем полный пакет.' });
    } else if (/Update has already been downloaded/.test(message)) {
      transfer({ phase: 'verifying', downloadMode: 'cached', files: artifact.fileName ? [artifact.fileName] : [], percent: undefined });
    }
    // Per-block debug logs are huge. Keep diagnostics and fallback errors in the
    // existing rotating support log, without logging every downloaded range.
    if (level !== 'debug') log(level, message);
  };
  updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => onLog(level, message)]));
  updater.disableDifferentialDownload = false;
  updater.disableWebInstaller = true;
  updater.on('checking-for-update', () => { artifact = {}; emit({ state: 'checking' }); });
  updater.on('update-available', info => {
    const extension = platform === 'darwin' ? '.zip' : platform === 'win32' ? '.exe' : '.AppImage';
    const file = info.files?.find(item => artifactName(item.url)?.toLowerCase().endsWith(extension.toLowerCase())) || info.files?.[0];
    const fileName = artifactName(file?.url || info.path);
    artifact = { version: info.version, fileName, artifactSize: finiteBytes(file?.size) };
    emit({ state: 'available', ...artifact, files: fileName ? [fileName] : [] });
  });
  updater.on('update-not-available', () => emit({ state: 'current' }));
  updater.on('download-progress', progress => {
    const total = finiteBytes(progress.total);
    const transferred = finiteBytes(progress.transferred);
    const percent = total > 0 && transferred !== undefined ? Math.min(100, Math.round(transferred / total * 100)) : Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : undefined;
    const downloadMode = status.downloadMode || (total !== undefined && artifact.artifactSize !== undefined && total < artifact.artifactSize ? 'differential' : 'full');
    transfer({ phase: percent === 100 ? 'verifying' : 'downloading', files: artifact.fileName ? [artifact.fileName] : [], percent, transferred, total, bytesPerSecond: finiteBytes(progress.bytesPerSecond), downloadMode,
      reusedBytes: downloadMode === 'differential' && total !== undefined && artifact.artifactSize !== undefined ? Math.max(0, artifact.artifactSize - total) : 0 });
  });
  updater.on('update-downloaded', info => emit({ ...status, ...artifact, state: 'ready', phase: undefined, version: info.version, files: artifact.fileName ? [artifact.fileName] : [] }));
  updater.on('update-cancelled', () => emit({ ...artifact, state: 'available' }));
  updater.on('error', error => emit({ ...status, state: 'error', phase: undefined, message: error.message }));
  return { getStatus: () => ({ ...status }), publish: emit, beginDownload };
}

module.exports = { attachUpdateStatus, updateFeed, artifactName };
