'use strict';
const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
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

const keyFor = (kind, filename) => `${kind}-${createHash('sha256').update(path.resolve(filename)).digest('hex')}`;

function parsedFile(filename, parse) {
  if (!fs.existsSync(filename)) return parse();
  const st = fs.statSync(filename), key = keyFor('parsed', filename);
  const old = read(key);
  if (old?.size === st.size && old.mtime === st.mtimeMs && old.ino === st.ino) return old.data;
  const data = parse();
  writeRaw(key, { size: st.size, mtime: st.mtimeMs, ino: st.ino, data });
  return data;
}

function incremental(filename, initial, reduce, version) {
  const st = fs.statSync(filename), key = keyFor('log', filename);
  let c = read(key);
  if (version !== undefined && c?.version !== version) c = null;
  if (c?.size === st.size && c.mtime === st.mtimeMs && c.ino === st.ino) return c.data;
  if (!c || c.ino !== st.ino || st.size < c.size || (st.size === c.size && st.mtimeMs !== c.mtime)) c = { offset: 0, data: initial() };
  const fd = fs.openSync(filename, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    let pending = Buffer.alloc(0), position = c.offset;
    while (position < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - position), position);
      if (!n) break;
      position += n;
      pending = Buffer.concat([pending, buf.subarray(0, n)]);
      const end = pending.lastIndexOf(10);
      if (end >= 0) {
        c.data = reduce(pending.subarray(0, end).toString('utf8'), c.data);
        c.offset += end + 1;
        pending = pending.subarray(end + 1);
      }
    }
  } finally { fs.closeSync(fd); }
  writeRaw(key, { ...c, version, size: st.size, mtime: st.mtimeMs, ino: st.ino });
  return c.data;
}

module.exports = { read, write, writeRaw, getStale, spawnWorker, file, parsedFile, incremental };
