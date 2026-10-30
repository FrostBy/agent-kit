'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
async function discover(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = await discover(file); if (found) return found; }
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const handle = await fs.open(file, 'r');
      try {
        const bytes = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1)) {
          const row = JSON.parse(line), value = row.type === 'session_meta' ? row.payload?.cli_version : row.version;
          if (typeof value === 'string' && value) return value;
        }
      } finally { await handle.close(); }
    }
  }
  return null;
}
async function version(kind, config, pair, { versions, run = promisify(execFile) } = {}) {
  if (versions?.[kind] || config.versions?.[kind]) return versions?.[kind] || config.versions[kind];
  const meta = pair[kind]?.meta;
  if (meta?.cli_version || meta?.version) return meta.cli_version || meta.version;
  const file = path.join(config.stateDir, 'versions.json');
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (cache[kind] && Date.now() - cache[kind].at < 86400000) return cache[kind].value;
  let value = await discover(kind === 'codex' ? config.codexSessionsDir : config.claudeProjectsDir);
  if (!value) {
    const { stdout } = await run(kind, ['--version'], { timeout: 2000, windowsHide: true });
    value = stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
    if (!value) throw Error(`Cannot determine ${kind} version`);
  }
  return { value, cache, file, kind };
}
module.exports = { version };
