#!/usr/bin/env node
'use strict';
const { connectProxy } = require('../../src/agents/codex-client');
async function resetSettings(threadId, { apply = false, connect = connectProxy, env = process.env, log = console.log } = {}) {
  if (!/^[\w-]+$/.test(threadId || '')) throw Error('Usage: reset-mirror-settings.js <thread-id> [--apply] (close the mirror first)');
  if (!apply) { log(`Plan: restore ${threadId} permissions/approval from a temporary ephemeral thread using the user defaults. Repeat with --apply.`); return; }
  const client = connect({ env, timeout: 5000 });
  let probe;
  try {
    await client.ready;
    await client.request('initialize', { clientInfo: { name: 'agent-kit-session-sync', version: '1' }, capabilities: { experimentalApi: true } }); client.notify('initialized', {});
    const stored = await client.request('thread/read', { threadId, includeTurns: false });
    if (!stored.thread?.cwd) throw Error('Thread cwd is missing');
    probe = await client.request('thread/start', { cwd: stored.thread.cwd, ephemeral: true });
    if (!probe.sandbox || probe.approvalPolicy === undefined) throw Error('App-server did not return default sandbox/approval');
    await client.request('thread/resume', { threadId });
    await client.request('thread/settings/update', { threadId, sandboxPolicy: probe.sandbox, approvalPolicy: probe.approvalPolicy });
    log(`Restored user-default settings for ${threadId}.`);
  } finally {
    if (probe?.thread?.id) await client.request('thread/unsubscribe', { threadId: probe.thread.id }).catch(() => {});
    client.close();
  }
}
if (require.main === module) {
  const [id, flag, ...extra] = process.argv.slice(2);
  if ((flag && flag !== '--apply') || extra.length) { console.error('Unknown arguments'); process.exitCode = 1; }
  else resetSettings(id, { apply: flag === '--apply' }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { resetSettings };
