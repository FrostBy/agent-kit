'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract } = require('../src/sync');
const { observe, title } = require('../src/sync/names');
const { cleanText } = require('../src/sync/messages');
const c = (text, extra = {}) => ({ type: 'user', uuid: 'message', message: { role: 'user', content: text }, ...extra });
const x = (text, extra = {}) => ({ type: 'response_item', payload: { type: 'message', id: 'message', role: 'user', content: [{ type: 'input_text', text }], ...extra } });

test('Claude keeps human typed/queued and legacy input; explicitly nonhuman origins/sources are skipped', () => {
  for (const extra of [{}, { turnOrigin: 'human' }, { origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' }, { origin: { kind: 'human' }, promptSource: 'queued', turnOrigin: 'human' }]) {
    assert.equal(extract('claude', [c('Real user request', extra)], 'session')[0].text, 'Real user request');
  }
  for (const extra of [{ origin: { kind: 'task-notification', producer: 'background', runId: 'task-id' } }, { origin: { kind: 'peer' } }, { origin: { kind: 'future-system-event' } }, { promptSource: 'system' }, { turnOrigin: 'task_notification' }, { turnOrigin: 'peer' }, { isMeta: true }, { isSidechain: true }]) {
    assert.deepEqual(extract('claude', [c('Not human even without markup', extra)], 'session'), []);
  }
});

test('Claude removes nested system/task reminders and slash command outputs without discarding actual text blocks', () => {
  const service = '<system-reminder>automated <task-notification>background result</task-notification></system-reminder>';
  const row = c([{ type: 'text', text: service }, { type: 'text', text: 'Please fix this.' }, { type: 'text', text: '<local-command-stdout>output</local-command-stdout>' }], { turnOrigin: 'human' });
  assert.equal(extract('claude', [row], 'session')[0].text, 'Please fix this.');
  for (const text of [service, '<task-notification>background result</task-notification>', '<command-message>clear</command-message><command-name>/clear</command-name><command-args>args</command-args>', '<local-command-stdout>logs</local-command-stdout>']) assert.deepEqual(extract('claude', [c(text)], 'session'), []);
  assert.equal(cleanText('claude', 'Before<system-reminder>outer<system-reminder>inner</system-reminder>tail</system-reminder>After'), 'BeforeAfter');
  assert.equal(cleanText('claude', 'Keep<system-reminder>unfinished private text'), 'Keep');
  assert.equal(extract('claude', [c('Please update AGENTS.md and explain environment_context.')], 'session')[0].text, 'Please update AGENTS.md and explain environment_context.');
});

test('service filtering leaves completed tool pairs and compact summaries intact', () => {
  const rows = [{ type: 'assistant', uuid: 'call', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'example' } }] } },
    c([{ type: 'text', text: '<system-reminder>ignore this</system-reminder>' }, { type: 'tool_result', tool_use_id: 'tool', content: 'real file contents' }])];
  const result = extract('claude', rows, 'session'); assert.equal(result.length, 1); assert.equal(result[0].tool.output, 'real file contents'); assert(!result[0].text.includes('ignore this'));
  const summary = extract('claude', [c('Useful compact summary<system-reminder>runtime details</system-reminder>', { isCompactSummary: true, isMeta: true })], 'session');
  assert.equal(summary[0].text, 'Useful compact summary'); assert.equal(summary[0].compact, true);
});

test('Codex discards environment/instructions/hooks/aborts and preserves mixed real user text', () => {
  for (const text of ['<environment_context><cwd>/project</cwd></environment_context>', '<user_instructions>policy</user_instructions>', '# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>policy</INSTRUCTIONS>', '<hook_prompt hook_run_id="hook">context</hook_prompt>', '<turn_aborted>aborted</turn_aborted>', '<additional_context>context</additional_context>']) assert.deepEqual(extract('codex', [x(text)], 'session'), []);
  const text = '# AGENTS.md instructions\n<INSTRUCTIONS>policy</INSTRUCTIONS>\n<environment_context>settings</environment_context>\nActual question\n<turn_aborted>status</turn_aborted>';
  assert.equal(extract('codex', [x(text)], 'session')[0].text, 'Actual question');
  assert.deepEqual(extract('codex', [{ type: 'event_msg', payload: { type: 'turn_aborted' } }], 'session'), []);
  for (const kind of ['agents_md.instructions', 'environments.environment_context', 'hooks.additional_context', 'generic.turn_aborted', 'multi_agent.subagent_notification']) {
    assert.deepEqual(extract('codex', [x('Plain service text without wrappers', { internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] } })], 'session'), []);
  }
});

test('Codex metadata filters individual content blocks and does not drop a neighboring genuine question', () => {
  const row = x('unused'); row.payload.content = [{ type: 'input_text', text: 'harness context' }, { type: 'input_text', text: 'Real user question' }, { type: 'input_text', text: 'hook context' }];
  row.payload.internal_chat_message_metadata_passthrough = { content_item_kinds: ['environments.environment_context', 'user.message', 'unknown'], content_item_metadata: [{ provenance: { type: 'harness' } }, {}, { provenance: { hook: true } }] };
  assert.equal(extract('codex', [row], 'session')[0].text, 'Real user question');
  const source = x('Agent-generated context', { internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: 'agents_md' } }] } });
  assert.deepEqual(extract('codex', [source], 'session'), []);
  const summary = extract('codex', [{ type: 'compacted', payload: { replacement_history: [source.payload, x('Compact summary').payload] } }], 'session');
  assert.equal(summary[0].text, 'Compact summary');
});

test('source-title fallback never selects a notification or context wrapper as first user input', () => {
  const claude = {}; observe(claude, 'claude', [c('Notification', { origin: { kind: 'task-notification' } }), c('<system-reminder>context</system-reminder>'), c('Actual title')], true);
  assert.equal(title(claude, 'claude'), 'Actual title \u00b7 Claude');
  const codex = {}; observe(codex, 'codex', [x('<environment_context>context</environment_context>'), x('Actual title')], true);
  assert.equal(title(codex, 'codex'), 'Actual title \u00b7 Codex');
});
