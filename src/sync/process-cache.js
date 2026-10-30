'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
function matches(kind, p) {
  return new RegExp(`^${kind}(\\.exe)?$`, 'i').test(p.name)
    || new RegExp(`(?:^|\\s)["']?[^"'\\s]*[\\\\/]${kind}(?:\\.js)?["']?(?:\\s|$)`, 'i').test(p.command || '');
}
async function identity(kind, { platform = process.platform, pid = process.pid, run = promisify(execFile) } = {}) {
  try {
    let chain;
    if (platform === 'win32') {
      const { stdout } = await run('cscript.exe', ['//nologo', path.join(__dirname, 'process-tree.wsf'), String(pid)], { timeout: 1500, windowsHide: true });
      chain = JSON.parse(stdout);
    } else {
      const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args='], { timeout: 1500 });
      const processes = new Map();
      for (const line of stdout.trim().split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.*)$/);
        if (m) processes.set(+m[1], { pid: +m[1], parent: +m[2], start: m[3], name: path.basename(m[4]), command: m[5] });
      }
      chain = [];
      for (let n = 0; n < 16 && processes.has(pid); n++) { const p = processes.get(pid); chain.push(p); pid = p.parent; }
    }
    const cli = chain.find(p => matches(kind, p));
    return cli?.pid && cli.start ? `${cli.pid}:${cli.start}` : null;
  } catch {
    // Disabled WSH / inaccessible process metadata falls back to the full fail-closed probe.
    return null;
  }
}
async function decisions(root, now = Date.now()) {
  const file = path.join(root, 'decisions.json');
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  state ||= { entries: {}, cleanedAt: 0 };
  let changed = false;
  for (const [key, entry] of Object.entries(state.entries)) if (now - entry.at > 7 * 86400000) { delete state.entries[key]; changed = true; }
  if (now - state.cleanedAt > 86400000) {
    for (const name of await fs.readdir(root)) if (/^(claude|codex)-[a-f0-9]{64}\.decision\.json$/.test(name)) {
      const target = path.join(root, name), stat = await fs.lstat(target);
      if (now - stat.mtimeMs > 7 * 86400000) await fs.unlink(target);
    }
    state.cleanedAt = now; changed = true;
  }
  return { file, state, changed };
}
function remember(state, key, entry) {
  delete state.entries[key];
  state.entries[key] = { ...entry, at: Date.now() };
  const entries = Object.entries(state.entries).slice(-128);
  state.entries = Object.fromEntries(entries);
}
module.exports = { identity, matches, decisions, remember };
