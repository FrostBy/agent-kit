#!/usr/bin/env node
'use strict';
// Opt-in real model/daemon smoke test. Only its fresh thread is closed/archived; SQL is read-only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn: defaultSpawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function sqliteReader() {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { throw Error('Live smoke SQLite verification requires Node.js 22.13+; the broker still supports Node 20.'); }
  return (home, threadId) => {
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT archived FROM threads WHERE id = ?').get(threadId)?.archived ?? null; }
    finally { db.close(); }
  };
}
async function smoke({ live = false, timeoutMs = 120000, env = process.env, spawn = defaultSpawn, readArchived, pollMs = 250, closeMs = 10000, log = console.log } = {}) {
  if (!live) { log('No live actions. Run: node scripts/agents/smoke-live.js --live [--timeout-ms 120000]'); return { skipped: true }; }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid --timeout-ms');
  readArchived ||= sqliteReader(); // Preflight before creating a real thread or requesting a model reply.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-smoke-')), project = path.join(root, 'project'); fs.mkdirSync(project);
  const prompt = path.join(root, 'prompt.txt'), stateFile = path.join(root, 'ping.state.json'), inbox = path.join(root, 'ping.inbox');
  fs.writeFileSync(prompt, 'Reply with exactly: pong');
  const home = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const child = spawn(process.execPath, [path.resolve(__dirname, 'broker.js'), '--agent', 'codex', '--name', 'ping', '--state', root, '--prompt', prompt, '--cwd', project, '--sandbox', 'read-only'], { env: { ...env, CODEX_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false, spawnError, stderr = '', cancelled = false;
  child.on('error', error => { spawnError = error; exited = true; }); child.on('exit', () => { exited = true; });
  child.stdout?.on('data', () => {}); child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return {}; throw e; } };
  const stop = () => { cancelled = true; }; process.on('SIGINT', stop);
  const wait = async (predicate, ms, closing = false) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (!closing && cancelled) throw Error('Smoke interrupted');
      if (spawnError) throw spawnError;
      if (Date.now() >= end) throw Error(closing ? 'Broker exit timed out' : 'Pong reply timed out');
      await delay(pollMs);
    }
  };
  const result = { ok: false, reply: false, stateArchived: false, sqliteArchived: null, artifacts: root };
  try {
    log(`Live smoke artifacts: ${root}`);
    await wait(() => {
      const s = state();
      if (exited && !s.turns) throw Error(`Broker exited before reply: ${stderr.slice(-400)}`);
      let errors = ''; try { errors = fs.readFileSync(path.join(root, 'ping.log'), 'utf8').slice(-4000); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (/Access is denied|Permission denied|EACCES|EPERM|Could not find home directory|failed to connect to socket|failed to initialize sqlite state runtime/i.test(errors)) throw Error('Daemon/proxy is unavailable or access was denied; see ping.log');
      return s.turns >= 1;
    }, timeoutMs);
    const reply = fs.readFileSync(path.join(root, 'ping.out.md'), 'utf8').trim();
    result.reply = reply === 'pong';
    if (!result.reply) result.error = `Expected exactly pong; turn status: ${state().lastTurnStatus || state().status}`;
  } catch (error) { result.error = error.message; }
  finally {
    try {
      if (!exited) {
        if (!state().threadId && result.error) child.kill();
        else {
          fs.mkdirSync(inbox, { recursive: true }); fs.writeFileSync(path.join(inbox, '999999-smoke-exit'), '/exit');
          await wait(() => exited, closeMs, true);
        }
      }
    } catch (error) { result.error ||= error.message; child.kill(); result.forcedKill = true; }
    finally { process.off('SIGINT', stop); }
    const finalState = state(); result.threadId = finalState.threadId; result.stateArchived = finalState.archived === true;
    if (result.threadId) {
      try { result.sqliteArchived = readArchived(home, result.threadId); } catch (error) { result.error ||= `Read-only SQLite check: ${error.message}`; }
    }
    result.ok = result.reply && result.stateArchived && result.sqliteArchived === 1 && !result.forcedKill;
  }
  log(JSON.stringify(result, null, 2));
  return result;
}
async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '--live') options.live = true;
    else if (args[n] === '--timeout-ms') options.timeoutMs = Number(args[++n]);
    else throw Error('Usage: smoke-live.js [--live] [--timeout-ms 120000]');
  }
  const result = await smoke(options); if (!result.skipped && !result.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { smoke };
