const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJournal(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Не удалось прочитать журнал хеджа. Сохранённый файл оставлен без изменений.');
  }
}

function writeJournal(file, journal) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function manualStopSnapshot(snapshot = {}, now = Date.now()) {
  const stopped = {
    state: 'stopped', active: false, requiresAttention: Boolean(snapshot.lossLimitReached),
    stopMode: 'app-only', manualStop: true, manualManagement: true, botStopped: true,
    closeStatus: snapshot.closeStatus === 'closed' ? 'closed' : 'not_requested', closeError: undefined,
    appStoppedAt: snapshot.appStoppedAt ?? now, updatedAt: now,
    error: undefined, errorCode: undefined, notice: undefined, stopProgress: undefined,
  };
  return {
    ...snapshot, ...stopped,
    // Handing control to the user does not establish anything about exchange
    // orders or fills. Retain every original order object and its status.
    runs: (snapshot.runs || []).map(run => run.roundRecorded ? run : { ...run, ...stopped }),
  };
}

function pauseSnapshot(snapshot = {}, now = Date.now()) {
  if (snapshot.manualStop || snapshot.manualManagement) return { ...snapshot, state: 'stopped', active: false, botStopped: true,
    ...(snapshot.closeStatus === 'closed' ? { requiresAttention: Boolean(snapshot.lossLimitReached) } : {}), error: undefined };
  const stopped = {
    state: 'stopped', active: false, botStopped: true, requiresAttention: snapshot.closeStatus === 'closed' ? Boolean(snapshot.lossLimitReached) : true,
    stopMode: 'pause', manualStop: false, manualManagement: false,
    closeStatus: snapshot.closeStatus || 'not_requested', closeError: snapshot.closeError,
    appStoppedAt: snapshot.appStoppedAt ?? now, updatedAt: now,
    error: undefined, errorCode: undefined, notice: undefined,
  };
  return { ...snapshot, ...stopped, runs: (snapshot.runs || []).map(run => run.roundRecorded ? run : { ...run, ...stopped }) };
}

function archiveManualJournal(file, journal = readJournal(file), { beforeClose = false } = {}) {
  if (!journal?.snapshot?.manualManagement && !journal?.snapshot?.botStopped) return null;
  const directory = path.join(path.dirname(file), 'manual-stops');
  const identity = journal.snapshot.id || `${journal.fingerprint || ''}:${journal.snapshot.startedAt || ''}:${journal.snapshot.appStoppedAt}`;
  const name = crypto.createHash('sha256').update(String(identity)).digest('hex') + (beforeClose ? `.before-close-${Date.now()}-${crypto.randomBytes(4).toString('hex')}` : '') + '.json';
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, name);
  writeJournal(archive, journal);
  return archive;
}

function stopSavedJournal(file, mode = 'app-only', now = Date.now()) {
  if (typeof mode === 'number') { now = mode; mode = 'app-only'; }
  if (!['app-only', 'pause'].includes(mode)) throw new Error('Неизвестный способ локальной остановки');
  const snapshot = mode === 'pause' ? pauseSnapshot : manualStopSnapshot;
  const journal = readJournal(file);
  if (!journal?.snapshot) return { fingerprint: journal?.fingerprint ?? null, snapshot: snapshot({}, now) };
  const stopped = { ...journal, snapshot: snapshot(journal.snapshot, now) };
  writeJournal(file, stopped);
  archiveManualJournal(file, stopped);
  return stopped;
}

function closeOnlyJournal(journal) {
  const copy = JSON.parse(JSON.stringify(journal));
  const clearManual = value => ({ ...value, manualStop: false, manualManagement: false, botStopped: true, active: false,
    state: 'stopped', stopMode: 'market', closeStatus: value.closeStatus === 'closed' ? 'closed' : 'not_requested', closeError: undefined,
    requiresAttention: value.closeStatus === 'closed' ? Boolean(value.lossLimitReached) : true, error: undefined, errorCode: undefined });
  copy.snapshot = { ...clearManual(copy.snapshot), runs: (copy.snapshot.runs || []).map(clearManual) };
  return copy;
}

function sessionHasPendingWork(session) {
  return Boolean(session && ['entryPromise', 'tickPromise', 'reconcilePromise', 'stopPromise', 'runPending', 'monitorPending'].some(key => session[key]));
}

module.exports = { readJournal, writeJournal, manualStopSnapshot, pauseSnapshot, archiveManualJournal, stopSavedJournal, closeOnlyJournal, sessionHasPendingWork };
