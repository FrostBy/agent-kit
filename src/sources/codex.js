'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { CODEX_DIR } = require('../util');
const cache = require('../cache');
const broker = require('./broker');

const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const samePath = (a, b) => {
  const norm = (s) => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s);
  const rel = path.relative(norm(a), norm(b));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

function* sessionFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sessionFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function readMeta(file) {
  return cache.parsedFile(file, () => readMetaUncached(file));
}

function readMetaUncached(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024), chunks = [];
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const end = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, end < 0 ? n : end)));
      if (end >= 0) break;
    }
    const row = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return row.type === 'session_meta' ? row.payload : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function findSession({ home = CODEX_DIR, root = process.cwd(), session, threadId = process.env.CODEX_THREAD_ID, execOnly = false } = {}) {
  if (session && fs.existsSync(session)) {
    if (!fs.statSync(session).isFile() || !readMeta(session)) throw new Error('not a Codex session JSONL file');
    return path.resolve(session);
  }
  const files = [...sessionFiles(path.join(home, 'sessions'))];
  const id = session || threadId;
  if (id) {
    const file = files.find((p) => path.basename(p).includes(id));
    if (file) {
      const meta = readMeta(file);
      if (typeof meta?.cwd === 'string' && (session || samePath(root, meta.cwd))) return file;
    }
    if (session) throw new Error(`Codex session not found: ${clean(session)}`);
  }
  return files.find((p) => {
    const m = readMeta(p);
    if (typeof m?.cwd !== 'string' || !samePath(root, m.cwd)) return false;
    if (execOnly && m.source !== 'exec') return false;
    return !(m.parent_thread_id || (typeof m.source === 'object' && m.source && 'subagent' in m.source));
  }) || null;
}

function state() {
  return { meta: {}, context: {}, info: null, limits: new Map(), pending: new Map(), agents: new Map(), todos: null, running: false, usageAt: null };
}

function apply(text, s = state()) {
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row?.payload;
    if (!p || typeof p !== 'object') continue;
    if (['event_msg', 'response_item', 'turn_context'].includes(row.type)) {
      const at = Date.parse(row.timestamp);
      if (Number.isFinite(at)) s.updatedAt = at;
      s.done = row.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_aborted'].includes(p.type);
    }
    if (row.type === 'session_meta') s.meta = p;
    if (row.type === 'turn_context') s.context = p;
    if (row.type === 'event_msg') {
      if (p.type === 'token_count') {
        if (p.info) { s.info = p.info; s.usageAt = row.timestamp; }
        if (p.rate_limits) s.limits.set(p.rate_limits.limit_id || 'codex', p.rate_limits);
      }
      if (p.type === 'task_started') { s.running = true; s.pending.clear(); }
      if (['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) { s.running = false; s.pending.clear(); }
      if (p.type === 'collab_agent_spawn_end' && p.new_agent_id) s.agents.set(p.new_agent_id, 'running');
      if (p.type === 'collab_waiting_end' && p.agent_statuses) {
        for (const [id, status] of Object.entries(p.agent_statuses)) s.agents.set(id, typeof status === 'string' ? status : Object.keys(status || {})[0]);
      }
    }
    if (row.type !== 'response_item') continue;
    if (['function_call', 'custom_tool_call'].includes(p.type) && p.call_id && p.name) {
      const name = clean(p.name).split('.').pop();
      let args = {};
      try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || {}; } catch { /* A malformed tool call must not blank the panel. */ }
      s.pending.set(p.call_id, { name, detail: typeof args?.file_path === 'string' ? clean(path.basename(args.file_path)) : '' });
      if (name === 'update_plan' && Array.isArray(args?.plan)) {
        s.todos = { done: args.plan.filter((x) => x?.status === 'completed').length, total: args.plan.length };
      }
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) s.pending.delete(p.call_id);
  }
  return s;
}

function windowLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function snapshot(s, root, now = Date.now()) {
  const info = s.info, last = info?.last_token_usage;
  const size = info?.model_context_window;
  const used = last?.total_tokens ?? ((last?.input_tokens || 0) + (last?.output_tokens || 0));
  const quota = [];
  for (const [id, limit] of s.limits) {
    for (const w of [limit.primary, limit.secondary]) {
      if (!w || !Number.isFinite(w.used_percent) || !(w.window_minutes > 0)) continue;
      quota.push({
        label: `${id === 'codex' ? '' : `${clean(limit.limit_name || id)} `}${windowLabel(w.window_minutes)}`,
        used_percentage: w.used_percent, resets_at: w.resets_at, window_seconds: w.window_minutes * 60,
      });
    }
  }
  const plan = [...s.limits.values()].find((l) => l.plan_type)?.plan_type;
  const started = Date.parse(s.meta.timestamp);
  return {
    input: {
      harness: 'codex',
      session_id: s.meta.id || s.meta.session_id,
      model: { display_name: clean(s.context.model || '') },
      effort: { level: clean(s.context.effort || '') },
      version: clean(s.meta.cli_version || ''),
      workspace: { project_dir: root, current_dir: s.context.cwd || s.meta.cwd || root },
      cost: { total_duration_ms: Number.isFinite(started) ? Math.max(0, now - started) : 0 },
      context_window: size > 0 && last ? {
        context_window_size: size, used_tokens: used, used_percentage: used / size * 100,
        current_usage: {
          input_tokens: Math.max(0, (last.input_tokens || 0) - (last.cached_input_tokens || 0) - (last.cache_write_input_tokens || 0)),
          cache_read_input_tokens: last.cached_input_tokens || 0,
          cache_creation_input_tokens: last.cache_write_input_tokens || 0,
        },
      } : null,
      token_usage: info?.total_token_usage,
      quota_windows: quota,
    },
    plan: typeof plan === 'string' ? { label: clean(plan.charAt(0).toUpperCase() + plan.slice(1)), api: false } : null,
    activity: {
      tool: [...s.pending.values()].pop() || (s.running ? { name: 'working', detail: '' } : { name: 'idle', detail: '' }),
      todos: s.todos,
      agents: [...s.agents.values()].filter((v) => ['running', 'pending_init'].includes(v)).length,
    },
    usageAt: s.usageAt,
  };
}

class Reader {
  constructor(file) { this.file = file; this.reset(); }
  reset() { this.offset = 0; this.carry = ''; this.decoder = new StringDecoder('utf8'); this.state = state(); }
  read() {
    const fd = fs.openSync(this.file, 'r');
    try {
      const st = fs.fstatSync(fd);
      const identity = `${st.dev}:${st.ino}`;
      if (st.size < this.offset || (this.identity && this.identity !== identity)) this.reset();
      this.identity = identity;
      const buf = Buffer.alloc(256 * 1024);
      while (this.offset < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - this.offset), this.offset);
        if (!n) break;
        this.offset += n;
        this.carry += this.decoder.write(buf.subarray(0, n));
        const end = this.carry.lastIndexOf('\n');
        if (end >= 0) { apply(this.carry.slice(0, end), this.state); this.carry = this.carry.slice(end + 1); }
      }
      return this.state;
    } finally { fs.closeSync(fd); }
  }
}

module.exports = { findSession, readMeta, apply, state, snapshot, Reader, clean, samePath, load };

function modelDisplayName(slug, home) {
  if (!slug) return slug;
  const file = path.join(home, 'models_cache.json');
  const parsed = cache.parsedFile(file, () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  });
  const name = parsed?.models?.find((m) => m?.slug === slug)?.display_name;
  return clean(name) || slug;
}

function load(root, now = Date.now(), home = CODEX_DIR, accepts = () => true, scratchpad) {
  const selected = broker.agents(scratchpad, 'codex');
  if (selected.length) {
    const files = [...sessionFiles(path.join(home, 'sessions'))];
    const agents = broker.select(selected.map((agent) => {
      const file = files.find((p) => path.basename(p).endsWith(`-${agent.id}.jsonl`));
      return file ? loadFile(root, now, home, file, agent) : null;
    }), accepts);
    if (agents.length) return { agents };
  }
  try {
    const file = findSession({ home, root, threadId: '', execOnly: true });
    if (!file) return null;
    const result = loadFile(root, now, home, file);
    return result && Number.isFinite(result.updatedAt) && accepts(result.updatedAt) ? result : null;
  } catch { return null; }
}

function loadFile(root, now, home, file, agent) {
  try {
    const data = cache.incremental(file, () => ({ ...state(), limits: [], pending: [], agents: [] }), (text, data) => {
      for (const key of ['limits', 'pending', 'agents']) data[key] = new Map(data[key]);
      apply(text, data);
      for (const key of ['limits', 'pending', 'agents']) data[key] = [...data[key]];
      return data;
    }, 1);
    for (const key of ['limits', 'pending', 'agents']) data[key] = new Map(data[key]);
    const out = snapshot(data, root, now);
    out.input.model.display_name = clean(modelDisplayName(out.input.model.display_name || agent?.model, home));
    return { input: out.input, updatedAt: data.updatedAt, done: data.done, name: agent ? clean(agent.name) : undefined };
  } catch { return null; }
}
