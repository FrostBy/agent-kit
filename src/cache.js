'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { CACHE_DIR, readJson, writeJson } = require('./util');

const file = (name) => path.join(CACHE_DIR, `${name}.json`);
const RETRY_MS = 30_000;

const read = (name) => readJson(file(name));
const write = (name, data) => writeJson(file(name), { fetchedAt: Date.now(), data });
const writeRaw = (name, obj) => { try { writeJson(file(name), obj); } catch { /* render must not fail on a cache write */ } };

function spawnWorker(worker, args = []) {
  try {
    spawn(process.execPath, [path.join(__dirname, '..', 'statusline.js'), `--refresh=${worker}`, ...args],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* a failed refresh must not break the render */ }
}

// Stale-while-revalidate: render returns cached data immediately and refreshes in a detached process,
// because Claude Code cancels a status line command that is still running when the next update arrives.
function getStale(name, ttlMs, now, worker = name) {
  const c = read(name);
  const fresh = c?.fetchedAt && now - c.fetchedAt < ttlMs;
  if (!fresh && !(c?.attemptAt && now - c.attemptAt < RETRY_MS)) {
    try { writeJson(file(name), { ...c, attemptAt: now }); } catch { /* render must not fail on a cache write */ }
    spawnWorker(worker);
  }
  return c?.data ?? null;
}

module.exports = { read, write, writeRaw, getStale, spawnWorker, file };
