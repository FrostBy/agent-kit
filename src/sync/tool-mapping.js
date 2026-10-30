'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { todoInput } = require('./tool-summary');
const cap = (text, n = 16000) => String(text || '').slice(0, n);
function unified(oldText, newText, file) {
  const lines = text => text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const before = lines(oldText), after = lines(newText);
  return `--- a/${file}\n+++ b/${file}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n`
    + before.map(line => '-' + line + '\n').join('') + after.map(line => '+' + line + '\n').join('');
}
function patchChanges(tool) {
  const input = tool.input || {}, file = input.file_path || input.notebook_path;
  if (typeof file !== 'string' || !file) return null;
  if (tool.name === 'Write' && typeof input.content === 'string') {
    return { [file]: /created/i.test(tool.output || '') ? { type: 'add', content: input.content }
      : { type: 'update', unified_diff: unified('', input.content, file), move_path: null } };
  }
  const edits = tool.name === 'MultiEdit' ? input.edits : tool.name === 'NotebookEdit'
    ? [{ old_string: input.old_source || '', new_string: input.new_source }] : [input];
  if (!Array.isArray(edits) || !edits.length || edits.some(e => typeof e.old_string !== 'string' || typeof e.new_string !== 'string')) return null;
  // Claude supplies fragments, not whole-file line offsets; hunk positions are fragment-relative.
  const diff = edits.map(e => unified(e.old_string, e.new_string, file)).join('');
  return { [file]: { type: 'update', unified_diff: diff, move_path: null } };
}
function codexItem(tool, key, cwd) {
  const input = tool.input || {}, id = `sync-ui-${key}`, failed = tool.isError === true || (Number.isInteger(tool.exitCode) && tool.exitCode !== 0);
  if (!failed && tool.name === 'TodoWrite' && Array.isArray(input.todos) && input.todos.length) return {
    type: 'Plan', id, text: input.todos.slice(0, 30).map(todo => `${todo.status === 'completed' ? '- [x]' : '- [ ]'} ${String(todo.content || '').replace(/\s+/g, ' ').slice(0, 180)}`).join('\n'),
  };
  if (!failed && tool.name === 'WebSearch' && typeof input.query === 'string') return { type: 'WebSearch', id, query: cap(input.query, 400), action: { type: 'search', query: cap(input.query, 400) } };
  if (!failed && tool.name === 'WebFetch' && typeof input.url === 'string') return { type: 'WebSearch', id, query: cap(input.url, 400), action: { type: 'open_page', url: cap(input.url, 400) } };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) {
    const changes = patchChanges(tool); if (!changes) return null;
    return { type: 'FileChange', id, changes, status: failed ? 'failed' : 'completed', stdout: failed ? '' : cap(tool.output), stderr: failed ? cap(tool.output) : '' };
  }
  let command, parsed;
  if (tool.name === 'Bash' && typeof input.command === 'string') {
    command = ['bash', '-lc', input.command]; parsed = [{ type: 'unknown', cmd: input.command }];
  } else if (['Read', 'Grep', 'Glob', 'LS'].includes(tool.name)) {
    const file = String(input.file_path || input.path || '.');
    const cmd = `${tool.name} ${input.pattern || ''} ${file}`.replace(/\s+/g, ' ').trim();
    command = [tool.name, ...(input.pattern ? [String(input.pattern)] : []), String(file)];
    parsed = tool.name === 'Read' ? [{ type: 'read', cmd, name: path.basename(file), path: path.resolve(cwd, file) }]
      : tool.name === 'Grep' ? [{ type: 'search', cmd, query: input.pattern == null ? null : String(input.pattern), path: input.path == null ? null : String(input.path) }]
        : [{ type: 'list_files', cmd, path: input.path || input.pattern ? String(input.path || input.pattern) : null }];
  } else return null;
  const ms = tool.durationMs;
  return { type: 'CommandExecution', id, command, cwd: pathToFileURL(cwd).href, parsed_cmd: parsed, source: tool.userShell ? 'user_shell' : 'agent',
    status: failed ? 'failed' : 'completed', aggregated_output: cap(tool.output), exit_code: Number.isInteger(tool.exitCode) ? tool.exitCode : null,
    ...(Number.isFinite(ms) && ms >= 0 ? { duration: { secs: Math.floor(ms / 1000), nanos: Math.round((ms % 1000) * 1000000) } } : {}) };
}
function parsePatch(text) {
  if (typeof text !== 'string' || !text.startsWith('*** Begin Patch')) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n'), calls = [];
  let i = 1;
  while (i < lines.length && lines[i] !== '*** End Patch') {
    const m = lines[i++].match(/^\*\*\* (Add|Update) File: (.+)$/); if (!m) return null;
    const file = m[2];
    if (m[1] === 'Add') {
      const added = []; while (i < lines.length && !lines[i].startsWith('*** ')) { if (!lines[i].startsWith('+')) return null; added.push(lines[i++].slice(1)); }
      calls.push({ name: 'Write', input: { file_path: file, content: added.length ? added.join('\n') + '\n' : '' } });
    } else {
      let old = [], next = [];
      const flush = () => { if (!old.length) return false; calls.push({ name: 'Edit', input: { file_path: file, old_string: old.join('\n'), new_string: next.join('\n'), replace_all: false } }); old = []; next = []; return true; };
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const line = lines[i++];
        if (line.startsWith('@@')) { if (old.length && !flush()) return null; continue; }
        if (line.startsWith(' ')) { old.push(line.slice(1)); next.push(line.slice(1)); }
        else if (line.startsWith('-')) old.push(line.slice(1));
        else if (line.startsWith('+')) next.push(line.slice(1));
        else return null;
      }
      if (!flush()) return null;
      if (lines[i] === '*** End of File') i++;
    }
  }
  return lines[i] === '*** End Patch' && calls.length ? calls : null;
}
function claudeCalls(tool) {
  const input = tool.input || {}, name = tool.name.split('__').at(-1);
  if (tool.isIncomplete || /^mcp__/i.test(tool.name)) return null;
  if (name === 'update_plan') { const plan = todoInput(input); return plan ? [{ name: 'TodoWrite', input: plan }] : null; }
  if (['web_search', 'web_search_call'].includes(name)) {
    const query = input.query || input.action?.query;
    return typeof query === 'string' && query ? [{ name: 'WebSearch', input: { query: cap(query, 400) } }] : null;
  }
  if (['exec', 'exec_command', 'shell', 'shell_command', 'local_shell_call'].includes(name)) {
    let command = input.cmd || input.command;
    if (Array.isArray(command)) command = command.length === 3 && /(?:^|[\\/])(?:bash|sh)$/.test(command[0]) && ['-c', '-lc'].includes(command[1])
      ? command[2] : command.map(value => "'" + String(value).replaceAll("'", "'\\''") + "'").join(' ');
    return typeof command === 'string' ? [{ name: 'Bash', input: { command } }] : null;
  }
  if (name === 'apply_patch') return parsePatch(input.input || input.patch || (typeof input === 'string' ? input : ''));
  return null;
}
module.exports = { codexItem, claudeCalls, unified, parsePatch };
