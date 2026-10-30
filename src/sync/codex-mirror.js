'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectProxy } = require('../agents/codex-client');
const { visible, writePresentation } = require('./presentation');
const { plain } = require('../agents/codex-path');
const hash = text => createHash('sha256').update(text).digest('hex');
async function createCodexMirror(endpoint, title, entries, config, { checkpoint, confined, cutoff, compactKey,
  deadline = Date.now() + 27000, env = process.env, connect = connectProxy } = {}) {
  let client;
  const open = async () => {
    client = connect({ env: { ...env, CODEX_HOME: config.codexHome, CLAUDE_CONFIG_DIR: config.claudeHome }, timeout: 5000 });
    await client.ready;
    await request('initialize', { clientInfo: { name: 'agent-kit-session-sync', version: '1' } }); client.notify('initialized', {});
  };
  const request = (method, params) => {
    const left = deadline - Date.now();
    if (left <= 0) throw Error('Mirror creation deadline reached');
    const cap = method === 'thread/inject_items' ? 20000 : 5000;
    return client.request(method, params, Math.max(1, Math.min(cap, left)));
  };
  try {
    await open();
    if (!endpoint.presentationStage) {
      if (endpoint.managed !== 'app-server') {
        // No permissions overrides: thread/start uses the user's project/default configuration.
        const result = await request('thread/start', { cwd: endpoint.cwd, ephemeral: false });
        if (!/^[\w-]+$/.test(result.thread?.id || '')) throw Error('Invalid thread/start ID');
        endpoint.id = result.thread.id; endpoint.file = plain(result.thread.path) || null;
        endpoint.managed = 'app-server'; endpoint.createdBy = 'agent-kit-session-sync';
        endpoint.injected = false; await checkpoint();
      } else {
        const resumed = await request('thread/resume', { threadId: endpoint.id });
        if (plain(resumed.thread?.path)) { endpoint.file = plain(resumed.thread.path); await checkpoint(); }
      }
      const content = endpoint.seedItems || entries.map(entry => ({ type: 'message', id: `msg_sync_${hash(entry.key)}`,
        role: entry.role, ...(entry.role === 'assistant' ? { phase: 'final_answer' } : {}),
        content: [{ type: entry.role === 'user' ? 'input_text' : 'output_text', text: `[session-sync:v2:${entry.key}]\n${entry.text}` }] }));
      if (!content.length) content.push({ type: 'message', id: 'msg_sync_empty', role: 'user', content: [{ type: 'input_text', text: `[session-sync:v2:seed]\n${title}` }] });
      if (!endpoint.injected) {
        if (!endpoint.seedItems) {
          endpoint.seedItems = content; endpoint.seedDisplay = visible(entries.length ? entries : [{ role: 'user', text: title, key: 'seed' }], endpoint.cwd);
          endpoint.seedState = { cutoff, compactKey }; await checkpoint();
        }
        const present = new Set();
        if (endpoint.file) {
          await confined(endpoint.file);
          try {
            for (const line of (await fs.readFile(endpoint.file, 'utf8')).split('\n').slice(0, -1)) {
              const row = JSON.parse(line); if (row.type === 'response_item' && row.payload?.id) present.add(row.payload.id);
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const count = content.filter(item => present.has(item.id)).length;
        if (count && count !== content.length) throw Error('Partial mirror injection; refusing duplicate history, recreate this mirror');
        if (!count) await request('thread/inject_items', { threadId: endpoint.id, items: content });
        endpoint.injected = true; delete endpoint.seedItems; await checkpoint();
      }
      await request('thread/name/set', { threadId: endpoint.id, name: title });
      let result = await request('thread/read', { threadId: endpoint.id, includeTurns: false });
      if (plain(result.thread?.path)) endpoint.file = plain(result.thread.path);
      if (!endpoint.file) throw Error('App-server did not return a rollout path');
      await confined(endpoint.file);
      if (!result.thread.preview || endpoint.previewGoal) {
        const existing = await request('thread/goal/get', { threadId: endpoint.id });
        if (existing.goal && existing.goal.objective !== (endpoint.previewObjective || title)) throw Error('Mirror acquired a user goal; refusing to replace it');
        endpoint.previewGoal = true; endpoint.previewObjective ||= title; await checkpoint();
        if (!existing.goal) await request('thread/goal/set', { threadId: endpoint.id, objective: endpoint.previewObjective, status: 'paused' });
        await request('thread/goal/clear', { threadId: endpoint.id });
        endpoint.previewGoal = false; await checkpoint();
      }
      endpoint.presentationStage = 'archive'; await checkpoint();
    }
    if (endpoint.presentationStage === 'archive') {
      let result = await request('thread/read', { threadId: endpoint.id, includeTurns: false });
      if (!/[\\/]archived_sessions[\\/]/.test(plain(result.thread?.path) || '')) {
        // archive waits for thread shutdown and closes its writer; unsubscribe alone does not.
        await request('thread/archive', { threadId: endpoint.id });
        result = await request('thread/read', { threadId: endpoint.id, includeTurns: false });
      }
      endpoint.file = plain(result.thread?.path);
      const real = await confined(endpoint.file), archiveRoot = await fs.realpath(path.join(config.codexHome, 'archived_sessions'));
      const relative = path.relative(archiveRoot, real);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Expected an archived mirror rollout');
      const loaded = await request('thread/loaded/list', {});
      if (!Array.isArray(loaded.data) || loaded.data.includes(endpoint.id)) throw Error('Mirror is still loaded; refusing presentation write');
      endpoint.presentationStage = 'append'; await checkpoint();
    }
    if (endpoint.presentationStage === 'append') {
      const loaded = await request('thread/loaded/list', {});
      if (!Array.isArray(loaded.data) || loaded.data.includes(endpoint.id)) throw Error('Mirror is still loaded');
      client.close();
      await writePresentation(await confined(endpoint.file), endpoint.seedDisplay || [], endpoint.id);
      endpoint.presentationStage = 'unarchive'; await checkpoint(); await open();
    }
    if (endpoint.presentationStage === 'unarchive') {
      const current = await request('thread/read', { threadId: endpoint.id, includeTurns: false });
      if (/[\\/]archived_sessions[\\/]/.test(plain(current.thread?.path) || '')) {
        const restored = await request('thread/unarchive', { threadId: endpoint.id });
        if (plain(restored.thread?.path)) endpoint.file = plain(restored.thread.path);
      }
      const result = await request('thread/read', { threadId: endpoint.id, includeTurns: false });
      if (!result.thread?.preview) throw Error('Mirror preview missing');
      endpoint.file = plain(result.thread.path) || endpoint.file; await confined(endpoint.file);
      endpoint.pending = endpoint.pending.filter(ref => ref.offset >= endpoint.seedState.cutoff);
      endpoint.seeded = true; delete endpoint.seedDisplay; delete endpoint.presentationStage;
    }
  } finally { client?.close(); }
}
module.exports = { createCodexMirror };
