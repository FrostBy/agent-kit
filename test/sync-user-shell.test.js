'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../src/sync');
const { visible } = require('../src/sync/presentation');
const { userText } = require('../src/sync/messages');
const c = (id, text, extra = {}) => ({ type: 'user', uuid: id, message: { role: 'user', content: text }, ...extra });
const codex = (text, meta) => ({ type: 'response_item', payload: { type: 'message', id: 'shell', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: meta } });
const wrapper = '<user_shell_command>\n<command>\necho hi\n</command>\n<result>\nExit code: 2\nDuration: 0.1200 seconds\nOutput:\nhi and error\n</result>\n</user_shell_command>';

test('Claude bash-mode input/output become one native user execution and bounded tag-free context', () => {
  const result = extract('claude', [c('input', '<bash-input>echo hi</bash-input>', { timestamp: '2026-10-30T10:00:00Z' }),
    c('output', '<bash-stdout>hi</bash-stdout><bash-stderr>warning</bash-stderr>', { parentUuid: 'input', turnOrigin: 'human', timestamp: '2026-10-30T10:00:01Z' })], 'source');
  assert.equal(result.length, 1); assert.equal(result[0].role, 'user');
  assert.equal(result[0].text, 'User ran: echo hi\nOutput: hi\nStderr: warning');
  assert.deepEqual(result[0].shell, { command: 'echo hi', stdout: 'hi', stderr: 'warning', durationMs: 1000 });
  const item = visible(result, process.cwd())[0].item;
  assert.equal(item.type, 'CommandExecution'); assert.equal(item.source, 'user_shell'); assert.equal(item.parsed_cmd[0].type, 'unknown');
  assert.match(item.aggregated_output, /hi\nStderr:\nwarning/); assert.equal(item.exit_code, null);
});

test('shell pairing survives incremental checkpoints and excludes unrelated, orphaned or unfinished output', () => {
  let state = {};
  assert.deepEqual(extract('claude', [c('input', '<bash-input>pwd</bash-input>')], 'session', state), []);
  state = JSON.parse(JSON.stringify(state));
  const rows = extract('claude', [c('result', '<bash-stdout>/project</bash-stdout><bash-stderr></bash-stderr>', { parentUuid: 'input' })], 'session', state);
  assert.equal(rows.length, 1); assert.equal(state.userShell, undefined);
  assert.deepEqual(extract('claude', [c('orphan', '<bash-stdout>orphan</bash-stdout><bash-stderr></bash-stderr>')], 'session'), []);
  state = {}; extract('claude', [c('input', '<bash-input>pwd</bash-input>')], 'session', state);
  assert.deepEqual(extract('claude', [c('result', '<bash-stdout>wrong parent</bash-stdout><bash-stderr></bash-stderr>', { parentUuid: 'different' })], 'session', state), []);
  state = {}; extract('claude', [c('input', '<bash-input>pwd</bash-input>')], 'session', state);
  extract('claude', [c('human', 'Another request')], 'session', state);
  assert.deepEqual(extract('claude', [c('result', '<bash-stdout>late</bash-stdout><bash-stderr></bash-stderr>')], 'session', state), []);
  assert.deepEqual(extract('claude', [c('partial', '<bash-input>unfinished')], 'session'), []);
});

test('Codex user_shell_command imports once from model record, not a second time from UI events', () => {
  const rows = extract('codex', [codex(wrapper, { content_item_kinds: ['shell.user_command'] }),
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', source: 'user_shell' } } }], 'source');
  assert.equal(rows.length, 1); assert.equal(rows[0].shell.command, 'echo hi');
  assert.equal(rows[0].shell.exitCode, 2); assert.equal(rows[0].shell.durationMs, 120);
  assert.equal(rows[0].shell.stdout, 'hi and error'); assert.equal(rows[0].shell.stderr, '');
  assert.doesNotMatch(rows[0].text, /<user_shell|<command>|<result>/);
  assert.deepEqual(extract('codex', [codex(wrapper, { content_item_kinds: ['hooks.additional_context'] })], 'source'), []);
  assert.deepEqual(extract('codex', [codex('<user_shell_command>unfinished</user_shell_command>')], 'source'), []);
});

test('shell output is bounded and persisted-output wrappers are unwrapped without reading referenced files', () => {
  const rows = extract('claude', [c('in', '<bash-input>command</bash-input>'), c('out', '<bash-stdout><persisted-output>' + 'x'.repeat(30000) + '</persisted-output></bash-stdout><bash-stderr>err</bash-stderr>', { parentUuid: 'in' })], 'session');
  assert(rows[0].shell.stdout.length < 8100); assert(rows[0].text.length < 6200); assert.doesNotMatch(rows[0].text, /persisted-output|bash-stdout/);
});

test('memory/slash/peer runtime tags are cut; genuine arbitrary markup remains user data', () => {
  for (const name of ['user-memory-input', 'command-name', 'command-message', 'command-args', 'local-command-stdout', 'agent-message']) {
    const row = c('id', `<${name}>runtime data</${name}>`); assert.equal(userText('claude', row, row.message), '');
  }
  const row = c('id', 'Please inspect <note>data</note> and <T> code.');
  assert.equal(userText('claude', row, row.message), row.message.content);
  assert.deepEqual(extract('claude', [c('in', '<bash-input>not from human</bash-input>', { origin: { kind: 'task-notification' } })], 'source'), []);
  for (const text of ['<codex_internal_context source="model">internal</codex_internal_context>', '<goal_context>automatic goal context</goal_context>', '<skill><name>runtime skill</name></skill>']) {
    assert.deepEqual(extract('codex', [codex(text)], 'source'), []);
  }
});
