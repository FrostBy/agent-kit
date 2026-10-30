#!/usr/bin/env node
'use strict';
// Close both clients before --apply. Default is a read-only plan; source transcripts are never changed.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { configuration } = require('../../src/sync');
const { acquire } = require('../../src/sync/lease');
const { connectProxy } = require('../../src/agents/codex-client');
const { plain } = require('../../src/agents/codex-path');

async function recreateManaged({ registryFile, root, before, registry, mapping, pairFile, pair, endpoint, source, env, log, connect, apply }) {
  // Older sync releases recorded managed/mirror but no createdBy marker. Keep that migration path.
  if (endpoint.mirror !== true || !/^[\w-]+$/.test(endpoint.id || '') || !source?.id || source.id === endpoint.id
    || (registry.version === 3 && (mapping.codex !== endpoint.id || mapping.claude !== source.id))
    || (endpoint.createdBy !== undefined && endpoint.createdBy !== 'agent-kit-session-sync')) throw Error('Managed mirror ownership/pair ID mismatch');
  log(`${apply ? 'Recreate' : 'Plan'}: delete managed Codex thread ${endpoint.id} (archive if delete is unavailable), then remove pair ${pair.id}.`);
  if (!apply) { log('Close both clients, then repeat with --apply. The next source hook creates the replacement.'); return; }
  const token = randomUUID(), backup = path.join(root, `recreate-${token}`), temporary = path.join(root, `pairs.${token}.tmp`);
  fs.mkdirSync(backup);
  fs.copyFileSync(registryFile, path.join(backup, 'pairs.json'), fs.constants.COPYFILE_EXCL);
  if (pairFile) fs.copyFileSync(pairFile, path.join(backup, 'pair.json'), fs.constants.COPYFILE_EXCL);
  const client = connect({ env, timeout: 5000 });
  let archived = false, deleted = false;
  try {
    await client.ready;
    await client.request('initialize', { clientInfo: { name: 'agent-kit-session-sync', version: '1' } }); client.notify('initialized', {});
    const result = await client.request('thread/read', { threadId: endpoint.id, includeTurns: false });
    if (result.thread?.id !== endpoint.id) throw Error('App-server thread ID does not match the managed pair');
    const file = plain(result.thread.path);
    if (file && fs.existsSync(file)) {
      const real = fs.realpathSync(file), config = configuration(endpoint.cwd, env);
      const inside = [config.codexSessionsDir, path.join(config.codexHome, 'archived_sessions')].some(dir => {
        if (!fs.existsSync(dir)) return false;
        const relative = path.relative(fs.realpathSync(dir), real);
        return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });
      if (!inside) throw Error('Managed rollout outside CODEX_HOME; refusing destructive action');
      fs.copyFileSync(real, path.join(backup, 'rollout.jsonl'), fs.constants.COPYFILE_EXCL);
    }
    if (fs.readFileSync(registryFile, 'utf8') !== before) throw Error('Registry changed concurrently');
    registry.pairs = registry.pairs.filter(entry => entry.id !== pair.id);
    fs.writeFileSync(temporary, JSON.stringify(registry), { flag: 'wx', mode: 0o600 });
    try { await client.request('thread/delete', { threadId: endpoint.id }); deleted = true; }
    catch (error) {
      if (error.code !== -32601 && !/(?:method.*(?:not found|unsupported)|unknown method)/i.test(error.message || '')) throw error;
      if (!/[\\/]archived_sessions[\\/]/.test(file || '')) { await client.request('thread/archive', { threadId: endpoint.id }); archived = true; }
    }
    fs.renameSync(temporary, registryFile);
    log(`Managed mirror ${deleted ? 'deleted' : 'archived'} through app-server; backups: ${backup}`);
  } catch (error) {
    if (archived) await client.request('thread/unarchive', { threadId: endpoint.id }).catch(() => {});
    if (deleted) throw Error(`Mirror deleted but registry replacement failed; backups: ${backup}. ${error.message}`);
    throw error;
  } finally { client.close(); fs.rmSync(temporary, { force: true }); }
}

async function recreate(registryPath, pairId, { apply = false, env = process.env, log = console.log, connect = connectProxy } = {}) {
  if (!registryPath || !/^[\w-]+$/.test(pairId || '')) throw Error('Usage: node scripts/agents/recreate-mirror.js <pairs.json> <pair-id> [--apply] (close both clients first)');
  const registryFile = fs.realpathSync(registryPath), root = path.dirname(registryFile);
  const release = apply ? acquire(root) : () => {};
  if (!release) throw Error('Sync is busy; close both clients and retry');
  try {
    const before = fs.readFileSync(registryFile, 'utf8'), registry = JSON.parse(before);
    if (![2, 3].includes(registry.version) || !Array.isArray(registry.pairs)) throw Error('Invalid pair registry');
    const mapping = registry.pairs.find(pair => pair.id === pairId);
    if (!mapping) throw Error('Pair not found');
    const pairFile = registry.version === 3 ? path.join(root, `${pairId}.json`) : null;
    const pair = pairFile ? JSON.parse(fs.readFileSync(pairFile, 'utf8')) : mapping;
    if (pair.id !== pairId) throw Error('Pair ID mismatch');
    const targets = ['claude', 'codex'].filter(kind => pair[kind]?.mirror);
    if (targets.length !== 1) throw Error('Expected exactly one mirror; refusing ambiguous reset');
    const kind = targets[0], endpoint = pair[kind], source = pair[kind === 'claude' ? 'codex' : 'claude'];
    if (kind === 'codex' && endpoint.managed === 'app-server') {
      await recreateManaged({ registryFile, root, before, registry, mapping, pairFile, pair, endpoint, source, env, log, connect, apply });
      return;
    }
    const config = configuration(endpoint.cwd, env);
    const allowed = fs.realpathSync(kind === 'codex' ? config.codexSessionsDir : config.claudeProjectsDir);
    const mirror = fs.realpathSync(plain(endpoint.file)), relative = path.relative(allowed, mirror);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Mirror outside configured session directory; set the correct CLAUDE_CONFIG_DIR / CODEX_HOME');
    if (mirror === fs.realpathSync(plain(source.file))) throw Error('Mirror and source are the same file');
    const handle = fs.openSync(mirror, 'r'), bytes = Buffer.alloc(64 * 1024);
    let first;
    try {
      const n = fs.readSync(handle, bytes, 0, bytes.length, 0), end = bytes.subarray(0, n).indexOf(10);
      if (end < 0) throw Error('Missing mirror metadata line');
      first = JSON.parse(bytes.subarray(0, end).toString('utf8'));
    } finally { fs.closeSync(handle); }
    const valid = kind === 'codex'
      ? first.type === 'session_meta' && first.payload?.id === endpoint.id && first.payload.session_sync?.mirror && first.payload.session_sync.pair === pairId
      : first.type === 'session-sync-mirror' && first.sessionId === endpoint.id && first.pairId === pairId;
    if (!valid) throw Error('Mirror metadata mismatch; refusing to move a native session');
    log(`${apply ? 'Recreate' : 'Plan'}: remove ${kind} mirror ${endpoint.id} and pair ${pairId}; keep source and event archive.`);
    if (!apply) { log('Close both clients, then repeat with --apply. The next source hook will create a new pair and mirror.'); return; }
    const token = randomUUID(), backup = path.join(root, `recreate-${token}`);
    fs.mkdirSync(backup);
    fs.copyFileSync(registryFile, path.join(backup, 'pairs.json'), fs.constants.COPYFILE_EXCL);
    if (pairFile) fs.copyFileSync(pairFile, path.join(backup, 'pair.json'), fs.constants.COPYFILE_EXCL);
    const savedMirror = `${mirror}.bak-recreate-${token}`, temporary = path.join(root, `pairs.${token}.tmp`);
    registry.pairs = registry.pairs.filter(pair => pair.id !== pairId);
    fs.writeFileSync(temporary, JSON.stringify(registry), { flag: 'wx', mode: 0o600 });
    let moved = false;
    try {
      if (fs.readFileSync(registryFile, 'utf8') !== before) throw Error('Registry changed concurrently');
      fs.renameSync(mirror, savedMirror); moved = true;
      fs.renameSync(temporary, registryFile);
    } catch (error) {
      if (moved) fs.renameSync(savedMirror, mirror);
      throw error;
    } finally { fs.rmSync(temporary, { force: true }); }
    // The old v3 checkpoint/archive remain as recovery data; only the registry controls active pairs.
    log(`Backups: ${backup}; ${savedMirror}`);
  } finally { release(); }
}

if (require.main === module) {
  const [registry, pair, flag, ...extra] = process.argv.slice(2);
  try {
    if ((flag && flag !== '--apply') || extra.length) throw Error('Unknown arguments');
    recreate(registry, pair, { apply: flag === '--apply' }).catch(error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { recreate };
