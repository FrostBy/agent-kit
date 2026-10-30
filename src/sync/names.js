'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { userText } = require('./messages');
const { connectProxy } = require('../agents/codex-client');
const short = value => [...String(value || '').replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
function observe(endpoint, kind, records, reset) {
  if (reset || !endpoint.naming) endpoint.naming = {};
  const n = endpoint.naming;
  for (const row of records) {
    if (kind === 'claude') {
      if (row.type === 'custom-title' && typeof row.customTitle === 'string') n.custom = row.customTitle.trim();
      if (row.type === 'summary' && typeof row.summary === 'string') n.summary = row.summary.trim();
    }
    if (!n.first && !row.isMeta && !row.isSidechain && !row.isCompactSummary) {
      const message = kind === 'claude' ? row.message : row.type === 'response_item' ? row.payload : null;
      if (message?.role === 'user') {
        const text = userText(kind, row, message);
        if (text && !text.includes('[session-sync:v2:')) n.first = short(text);
      }
    }
  }
}
async function sourceName(endpoint, config, { connect = config.connectCodex || connectProxy, env = process.env, refresh = false } = {}) {
  endpoint.naming ||= {};
  const n = endpoint.naming;
  if (endpoint.name || endpoint.threadName) n.name = endpoint.name || endpoint.threadName;
  const index = path.join(config.codexHome, 'session_index.jsonl');
  let stamp = '';
  for (const file of [index, path.join(config.codexHome, 'state_5.sqlite'), path.join(config.codexHome, 'state_5.sqlite-wal')]) {
    try { const s = await fs.stat(file); stamp += `${s.mtimeMs}:${s.size};`; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (n.stamp === stamp && !refresh) return;
  // Index deltas are read only when their metadata changes; the thread API is authoritative.
  try {
    const text = await fs.readFile(index, 'utf8');
    for (const line of text.split('\n').filter(Boolean)) { const row = JSON.parse(line); if (row.id === endpoint.id && typeof row.thread_name === 'string') n.name = row.thread_name; }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  n.stamp = stamp;
  const client = connect({ env: { ...env, CODEX_HOME: config.codexHome }, timeout: 2000 });
  try {
    await client.ready;
    await client.request('initialize', { clientInfo: { name: 'agent-kit-session-sync', version: '1' } }); client.notify('initialized', {});
    const result = await client.request('thread/read', { threadId: endpoint.id, includeTurns: false });
    if (typeof result.thread?.name === 'string' && result.thread.name.trim()) n.name = result.thread.name.trim();
  } catch { /* Keep the index/first-user fallback when the daemon is unavailable. */ }
  finally { client.close(); }
}
function title(endpoint, kind) {
  const n = endpoint.naming || {};
  return `${(kind === 'claude' ? n.custom || n.summary : n.name) || n.first || 'Conversation'} · ${kind === 'claude' ? 'Claude' : 'Codex'}`;
}
async function renameCodex(endpoint, name, config, { connect = config.connectCodex || connectProxy, env = process.env } = {}) {
  const client = connect({ env: { ...env, CODEX_HOME: config.codexHome }, timeout: 2000 });
  try {
    await client.ready;
    await client.request('initialize', { clientInfo: { name: 'agent-kit-session-sync', version: '1' } }); client.notify('initialized', {});
    await client.request('thread/name/set', { threadId: endpoint.id, name });
  } finally { client.close(); }
}
module.exports = { observe, sourceName, title, renameCodex };
