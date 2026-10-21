'use strict';
const fs = require('fs');
const path = require('path');

const AGENT_TOOLS = new Set(['Agent', 'Task']);

// Transcripts grow to tens of MB; only the tail matters for "what is happening now".
function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}

function detail(name, input = {}) {
  if (name === 'Bash') return input.description || (input.command || '').slice(0, 40);
  if (input.file_path) return path.basename(input.file_path);
  if (input.pattern) return input.pattern.slice(0, 30);
  if (input.url) { try { return new URL(input.url).host; } catch { return ''; } }
  if (input.description) return input.description.slice(0, 40);
  return '';
}

function parse(text) {
  const pending = new Map();
  let permissionMode = null, todoList = null, created = 0;
  const tasks = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'permission-mode') permissionMode = o.permissionMode;
    if (o.isSidechain) continue;
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use') {
        pending.set(c.id, { name: c.name, input: c.input || {} });
        if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) todoList = c.input.todos;
        if (c.name === 'TaskCreate') created++;
        if (c.name === 'TaskUpdate' && c.input?.taskId) tasks.set(String(c.input.taskId), c.input.status || 'pending');
      } else if (c.type === 'tool_result') {
        pending.delete(c.tool_use_id);
      }
    }
  }
  const running = [...pending.values()];
  const tool = running.filter((t) => !AGENT_TOOLS.has(t.name)).pop();
  let todos = null;
  if (todoList) todos = { done: todoList.filter((t) => t.status === 'completed').length, total: todoList.length };
  else if (created || tasks.size) todos = { done: [...tasks.values()].filter((s) => s === 'completed').length, total: Math.max(created, tasks.size) };
  return {
    tool: tool ? { name: tool.name, detail: detail(tool.name, tool.input) } : null,
    agents: running.filter((t) => AGENT_TOOLS.has(t.name)).length,
    todos,
    permissionMode,
  };
}

function load(transcriptPath, bytes = 512 * 1024) {
  if (!transcriptPath) return null;
  try { return parse(tail(transcriptPath, bytes)); } catch { return null; }
}

module.exports = { load, parse, tail };
