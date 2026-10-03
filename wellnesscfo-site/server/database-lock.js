'use strict';

const fs = require('node:fs');
const path = require('node:path');

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireDatabaseLock(dbPath) {
  if (dbPath === ':memory:') return () => {};

  const absolutePath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const lockPath = `${absolutePath}.lock`;
  let descriptor;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.fsyncSync(descriptor);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try {
        lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        throw new Error(`The local database lock is unreadable (${lockPath}). Verify no WellnessCFO process is running, then remove the stale lock file.`);
      }
      if (processIsRunning(Number(lock.pid))) {
        throw new Error(`The WellnessCFO database is already open by process ${lock.pid}. Close the other server before starting or restoring it.`);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  if (descriptor === undefined) throw new Error('Could not acquire the local database lock.');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.closeSync(descriptor); } catch {}
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number(current.pid) === process.pid) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

module.exports = { acquireDatabaseLock };
