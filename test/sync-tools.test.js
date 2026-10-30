'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexItem, claudeCalls, parsePatch } = require('../src/sync/tool-mapping');
const { visible } = require('../src/sync/presentation');
const { extract } = require('../src/sync');
const cwd = process.cwd();

test('Claude Bash becomes completed/failed Codex command with bounded output and observed metadata', () => {
  const item = codexItem({ name: 'Bash', input: { command: 'echo hello' }, output: 'x'.repeat(20000), exitCode: 2, isError: true, durationMs: 1500 }, 'key', cwd);
  assert.equal(item.type, 'CommandExecution'); assert.equal(item.status, 'failed'); assert.equal(item.exit_code, 2);
  assert.deepEqual(item.command, ['bash', '-lc', 'echo hello']); assert.equal(item.parsed_cmd[0].cmd, 'echo hello');
  assert.deepEqual(item.duration, { secs: 1, nanos: 500000000 }); assert.equal(item.aggregated_output.length, 16000); assert(item.cwd.startsWith('file:'));
  const unknown = codexItem({ name: 'Bash', input: { command: 'true' } }, 'other', cwd);
  assert.equal(unknown.exit_code, null); assert.equal(unknown.duration, undefined);
});

test('Read/Grep/Glob/LS map to Codex exploration actions, unknown tools remain short summaries', () => {
  for (const [name, action] of [['Read', 'read'], ['Grep', 'search'], ['Glob', 'list_files'], ['LS', 'list_files']]) {
    const item = codexItem({ name, input: { file_path: 'example.txt', path: '.', pattern: 'hello' }, output: 'found' }, name, cwd);
    assert.equal(item.type, 'CommandExecution'); assert.equal(item.parsed_cmd[0].type, action);
    if (name === 'Read') assert.equal(item.parsed_cmd[0].path, path.join(cwd, 'example.txt'));
  }
  for (const name of ['WebFetch', 'WebSearch', 'mcp__server__query', 'Task', 'Agent']) {
    const entry = visible([{ key: name, role: 'assistant', text: '', tool: { name, input: {}, output: 'a'.repeat(5000) } }], cwd)[0];
    assert.equal(entry.item, null); assert(entry.text.length < 700);
  }
});

test('Edit/Write/MultiEdit/NotebookEdit carry native file changes with supplied old/new text', () => {
  const file = 'example.txt';
  const change = tool => codexItem({ input: { file_path: file }, output: 'done', ...tool }, 'key', cwd).changes[file];
  assert.match(change({ name: 'Edit', input: { file_path: file, old_string: 'old\nline', new_string: 'new\nline' } }).unified_diff, /-old\n-line\n\+new\n\+line/);
  assert.equal(change({ name: 'Write', input: { file_path: file, content: 'new' }, output: 'File created successfully' }).type, 'add');
  assert.equal(change({ name: 'Write', input: { file_path: file, content: 'new' } }).type, 'update');
  const multi = change({ name: 'MultiEdit', input: { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } });
  assert.match(multi.unified_diff, /-a\n\+b/); assert.match(multi.unified_diff, /-c\n\+d/);
  const notebook = codexItem({ name: 'NotebookEdit', input: { notebook_path: 'demo.ipynb', old_source: 'old', new_source: 'new' } }, 'n', cwd);
  assert.match(notebook.changes['demo.ipynb'].unified_diff, /-old\n\+new/);
  assert.equal(codexItem({ name: 'Edit', input: { file_path: file } }, 'missing', cwd), null);
});

test('Codex shell tools map to Claude Bash; apply_patch maps to native Write/Edit with exact fields', () => {
  assert.deepEqual(claudeCalls({ name: 'exec_command', input: { cmd: 'echo hello' } }), [{ name: 'Bash', input: { command: 'echo hello' } }]);
  assert.deepEqual(claudeCalls({ name: 'local_shell_call', input: { command: ['bash', '-lc', 'echo hello'] } }), [{ name: 'Bash', input: { command: 'echo hello' } }]);
  const patch = '*** Begin Patch\n*** Add File: new.txt\n+new text\n*** Update File: old.txt\n@@\n-old text\n+changed text\n*** End Patch';
  assert.deepEqual(claudeCalls({ name: 'apply_patch', input: { input: patch } }), [
    { name: 'Write', input: { file_path: 'new.txt', content: 'new text\n' } },
    { name: 'Edit', input: { file_path: 'old.txt', old_string: 'old text', new_string: 'changed text', replace_all: false } }
  ]);
  for (const text of ['*** Begin Patch\n*** Delete File: old.txt\n*** End Patch', '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch', 'bad patch']) assert.equal(parsePatch(text), null);
  assert.equal(claudeCalls({ name: 'exec_command', input: { cmd: 'sleep 30' }, isIncomplete: true }), null);
  assert.equal(claudeCalls({ name: 'web_search', input: {} }), null);
});

test('completed tool extraction retains error/exit/timing and UI events do not export model items', () => {
  const rows = [
    { type: 'assistant', uuid: 'call', timestamp: '2026-10-30T10:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'false' } }] } },
    { type: 'user', timestamp: '2026-10-30T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'failed', is_error: true }] }, toolUseResult: { exitCode: 1 } }
  ];
  const entries = extract('claude', rows, 'session'); assert.equal(entries[0].tool.durationMs, 1000); assert.equal(entries[0].tool.exitCode, 1); assert.equal(entries[0].tool.isError, true);
  const item = visible(entries, cwd)[0].item;
  assert.equal(extract('codex', [{ type: 'event_msg', payload: { type: 'item_completed', item } }], 'mirror').length, 0);
  const failedPatch = extract('codex', [
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'p', call_id: 'p', name: 'apply_patch', input: 'patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p', output: 'apply_patch verification failed: missing context' } }
  ], 'codex');
  assert.equal(failedPatch[0].tool.isError, true);
});
