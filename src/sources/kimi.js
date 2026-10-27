'use strict';
const fs = require('fs');
const path = require('path');
const { HOME, readJson } = require('../util');
const { samePath, clean } = require('./codex');
const cache = require('../cache');
const broker = require('./broker');

function contextSize(home, alias) {
  let section = '', size, displayName;
  for (const line of fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split('\n')) {
    const header = line.match(/^\s*\[models\.("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\]\s*(?:#.*)?$/);
    if (header) {
      try { section = header[1].startsWith('"') ? JSON.parse(header[1]) : header[1].replace(/^'|'$/g, ''); } catch { section = ''; }
    } else if (/^\s*\[/.test(line)) section = '';
    const value = line.match(/^\s*max_context_size\s*=\s*([\d_]+)\s*(?:#.*)?$/);
    if (section === alias && value) size = Number(value[1].replace(/_/g, ''));
    const name = line.match(/^\s*display_name\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (section === alias && name) {
      try { displayName = JSON.parse(`"${name[1]}"`); } catch { displayName = undefined; }
    }
  }
  return size == null && displayName == null ? null : { size, display_name: displayName };
}

function load(root, now = Date.now(), home = path.join(HOME, '.kimi-code'), accepts = () => true, scratchpad) {
  try {
    const sessions = path.join(home, 'sessions');
    const workspaces = fs.readdirSync(sessions, { withFileTypes: true }).filter((w) => w.isDirectory());
    const agents = broker.agents(scratchpad, 'kimi', accepts).map((agent) => {
      const dir = workspaces.map((w) => path.join(sessions, w.name, agent.id)).find((p) => fs.existsSync(p));
      return dir ? loadSession({ dir, ...agent }, now, home) : null;
    }).filter(Boolean);
    if (agents.length) return { agents };
    let selected = null;
    for (const workspace of workspaces) {
      const dir = path.join(sessions, workspace.name);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue;
        const sessionDir = path.join(dir, entry.name);
        const stateFile = path.join(sessionDir, 'state.json');
        const state = cache.parsedFile(stateFile, () => readJson(stateFile));
        const updatedAt = typeof state?.updatedAt === 'number' ? state.updatedAt : Date.parse(state?.updatedAt);
        if (typeof state?.cwd !== 'string' || !samePath(root, state.cwd) || !Number.isFinite(updatedAt)) continue;
        if (!selected || updatedAt > selected.updatedAt) selected = { dir: sessionDir, updatedAt };
      }
    }
    if (!selected || !accepts(selected.updatedAt)) return null;
    return loadSession(selected, now, home);
  } catch { return null; }
}

function loadSession(selected, now, home) {
  try {
    const file = path.join(selected.dir, 'agents', 'main', 'wire.jsonl');
    const parsed = cache.incremental(file, () => ({ limitedAt: 0, usage: null }), (text, previous) => {
    let { model, effort, used, limitedAt, limitWindow, usage } = previous;
    for (const line of text.split('\n')) {
      if (!/profile\.bind|llm\.request|usage\.record|token_counting\.measured|rate_limited|APIProviderQuotaExhaustedError/.test(line)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      if (['profile.bind', 'llm.request'].includes(row.type)) {
        if (typeof row.modelAlias === 'string') model = row.modelAlias;
        if (typeof row.thinkingEffort === 'string') effort = row.thinkingEffort;
      }
      if (row.type === 'usage.record' && row.usage) {
        usage ||= { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
        for (const [key, target] of Object.entries({ inputOther: 'input_tokens', output: 'output_tokens', inputCacheRead: 'cached_input_tokens' })) {
          const value = row.usage[key];
          if (Number.isFinite(value) && value >= 0) usage[target] += value;
        }
      }
      if (row.type === 'token_counting.measured' && Number.isFinite(row.tokens) && row.tokens >= 0) used = row.tokens;
      const exhausted = row.error?.name === 'APIProviderQuotaExhaustedError'
        || row.error?.details?.statusCode === 429
        || /rate_limited/.test(String(row.type) + ' ' + String(row.code ?? ''));
      if (exhausted && Number.isFinite(row.time) && row.time >= limitedAt) {
        limitedAt = row.time;
        const message = typeof row.error?.message === 'string' ? row.error.message.toLowerCase() : '';
        limitWindow = message.includes('5-hour') ? '5h' : message.includes('month') ? 'month' : '';
      }
    }
    return { model, effort, used, limitedAt, limitWindow, usage };
    });
    const { effort, used, limitedAt, limitWindow, usage } = parsed;
    const model = parsed.model || selected.model;
    let config;
    try { config = contextSize(home, model); } catch { /* Missing config only hides context percent. */ }
    const size = config?.size;
    const modelName = clean(config?.display_name) || clean(model?.split('/').pop());
    return { name: selected.name ? clean(selected.name) : undefined, updatedAt: selected.updatedAt, limitWindow, limited: limitedAt > 0 && now >= limitedAt && now - limitedAt <= (limitWindow === '5h' ? 5 * 3600000 : 30 * 86400000),
      input: { model: { display_name: modelName }, effort: { level: clean(effort) }, token_usage: usage,
        context_window: size > 0 && used != null ? { context_window_size: size, used_tokens: used, used_percentage: used / size * 100 } : null } };
  } catch { return null; }
}
module.exports = { load, contextSize };
