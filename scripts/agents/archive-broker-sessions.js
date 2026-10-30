#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { connectProxy } = require('../../src/agents/codex-client');
function* files(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
  }
}
async function inspect(file) {
  const before = fs.statSync(file), stream = fs.createReadStream(file), lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let meta, at = before.mtimeMs, running = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line), p = row.payload;
      if (row.type === 'session_meta') {
        meta = p;
        if (p.originator !== 'claude-agent-broker') return null;
      }
      const time = Date.parse(row.timestamp); if (Number.isFinite(time)) at = Math.max(at, time);
      if (row.type === 'event_msg') {
        if (['task_started', 'turn_started'].includes(p?.type)) running = true;
        if (['task_complete', 'task_completed', 'turn_complete', 'turn_completed', 'turn_aborted'].includes(p?.type)) running = false;
      }
    }
    const after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    return meta?.originator === 'claude-agent-broker' && /^[\w-]+$/.test(meta.id) ? { id: meta.id, at, running, file } : null;
  } catch { return null; }
  finally { lines.close(); stream.destroy(); }
}
function protectedThreads(stateDirs) {
  const ids = new Set();
  for (const dir of stateDirs) {
    const walk = root => {
      let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith('.state.json')) try {
          const s = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (s.agent !== 'codex' || !s.threadId) continue;
          let live = false;
          if (Number.isInteger(s.pid) && s.pid > 0) { try { process.kill(s.pid, 0); live = true; } catch (e) { live = e.code !== 'ESRCH'; } }
          if (live || s.status === 'running') ids.add(s.threadId);
        } catch {}
      }
    }; walk(dir);
  }
  return ids;
}
async function archiveSessions({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), minutes = 60, apply = false, stateDirs = [], env = process.env, connect = connectProxy, log = console.log, now = Date.now() } = {}) {
  if (!Number.isFinite(minutes) || minutes <= 0) throw Error('--minutes must be positive');
  const protectedIds = protectedThreads(stateDirs), rows = new Map();
  for (const file of files(path.join(home, 'sessions'))) {
    const row = await inspect(file); if (!row) continue;
    const old = rows.get(row.id);
    if (old) { old.at = Math.max(old.at, row.at); old.running ||= row.running; old.files.push(file); }
    else rows.set(row.id, { ...row, files: [file] });
  }
  const candidates = [...rows.values()].filter(row => !row.running && !protectedIds.has(row.id) && now - row.at > minutes * 60000);
  for (const row of candidates) log(`${apply ? 'Candidate' : 'Dry-run'}: ${row.id} idle ${Math.floor((now - row.at) / 60000)} min`);
  log(`${candidates.length} candidate(s); ${apply ? 'apply' : 'dry-run, no app-server connection'}.`);
  if (!apply || !candidates.length) return { candidates: candidates.length, archived: 0, failed: 0 };
  const client = connect({ env: { ...env, CODEX_HOME: path.resolve(home) }, timeout: 5000, log });
  let archived = 0, failed = 0;
  try {
    await client.ready;
    await client.request('initialize', { clientInfo: { name: 'agent-kit-archive-broker-sessions', version: '1' } });
    client.notify('initialized', {});
    for (const row of candidates) {
      try {
        const current = await Promise.all(row.files.map(inspect));
        if (protectedThreads(stateDirs).has(row.id) || current.some(s => !s || s.running || Date.now() - s.at <= minutes * 60000)) continue;
        const live = await client.request('thread/read', { threadId: row.id, includeTurns: false });
        if (live.thread?.status?.type === 'active') continue;
        await client.request('thread/archive', { threadId: row.id }); archived++;
        log(`Archived: ${row.id}`);
      } catch (error) { failed++; log(`Archive failed ${row.id}: ${error.message || JSON.stringify(error)}`); }
    }
  } finally { client.close(); }
  return { candidates: candidates.length, archived, failed };
}
async function main(args = process.argv.slice(2)) {
  const options = { stateDirs: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--minutes') options.minutes = Number(args[++i]);
    else if (args[i] === '--state') { if (!args[i + 1]) throw Error('Missing --state directory'); options.stateDirs.push(args[++i]); }
    else throw Error('Usage: archive-broker-sessions.js [--minutes 60] [--state DIR] [--apply]');
  }
  const result = await archiveSessions(options); if (result.failed) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { archiveSessions, inspect };
