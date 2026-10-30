'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const TIMEOUT = 30000;
const absent = error => error.code === 'ENOENT';
function acquire(root, now = Date.now()) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'lock'), guard = file + '.reclaim';
  const token = randomUUID();
  function create() {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, token })); } finally { fs.closeSync(fd); }
    return () => {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); }
      catch (e) { if (!absent(e)) throw e; }
    };
  }
  try { return create(); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  // Serialize stale-lock replacement: a second reaper cannot rename a newly acquired lease.
  try { fs.mkdirSync(guard); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (now - fs.statSync(guard).mtimeMs > TIMEOUT) {
        const stale = guard + '.' + token;
        fs.renameSync(guard, stale); fs.rmdirSync(stale);
      }
    } catch (error) { if (!absent(error)) throw error; }
    return null;
  }
  try {
    let stat;
    try { stat = fs.statSync(file); } catch (e) { if (!absent(e)) throw e; }
    if (stat && now - stat.mtimeMs <= TIMEOUT) return null;
    if (stat) {
      const stale = file + '.' + token;
      fs.renameSync(file, stale); fs.unlinkSync(stale);
    }
    try { return create(); } catch (e) { if (e.code !== 'EEXIST') throw e; return null; }
  } finally { fs.rmdirSync(guard); }
}
module.exports = { acquire, TIMEOUT };
