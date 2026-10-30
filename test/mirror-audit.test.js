'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { visible } = require('../src/sync/presentation');
const { encode, extract } = require('../src/sync');
const { toolSummary } = require('../src/sync/tool-summary');
const { audit, classify } = require('../scripts/agents/audit-mirror');
const names = ['Monitor', 'TaskOutput', 'TaskStop', 'TodoWrite', 'Agent', 'Task', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Artifact', 'mcp__server__query', 'update_plan', 'web_search', 'view_image', 'spawn_agent', 'wait', 'send_input', 'UnknownFutureTool'];
const endpoint = { id: 'audit', cwd: process.cwd(), version: 'test' };
function entry(name, input = {}) { return { key: name, role: 'user', text: '[claude tool ' + name + ']\nPRIVATE_RAW_RESULT', tool: { name, input, output: 'Monitor started (task secret-id)\n<task-notification>PRIVATE_RAW_RESULT</task-notification>\n' + 'x'.repeat(10000) } }; }

test('all unknown/control/external tools have compact assistant-only semantic summaries without raw tool data', () => {
  for (const name of names) {
    const value = entry(name), display = visible([value])[0], rows = encode('claude', endpoint, [value]);
    assert.equal(display.role, 'assistant'); assert(display.text.length <= 320); assert.doesNotMatch(display.text, /secret-id|PRIVATE_RAW|task-notification|\[Tool/);
    assert(rows.every(row => row.type === 'assistant')); assert.doesNotMatch(JSON.stringify(rows), /secret-id|PRIVATE_RAW|task-notification|\[Codex/);
    assert.equal(classify('claude', value, process.cwd()).route, 'summary');
    assert.equal(classify('codex', value, process.cwd()).route, 'summary');
  }
  assert.equal(toolSummary(entry('Monitor').tool), 'Background monitor started.');
  const code = entry('exec', { input: 'const result = await tools.read_only_query({});' });
  assert.equal(classify('codex', code, process.cwd()).route, 'summary');
  assert.equal(toolSummary(code.tool), 'Code orchestration completed.');
});

test('native todo/plan/web mappings exist in both directions while MCP identities are not forged into Bash', () => {
  const todo = entry('TodoWrite', { todos: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'pending' }] });
  assert.equal(visible([todo])[0].item.type, 'Plan'); assert.match(visible([todo])[0].item.text, /\[x\] One/);
  for (const [name, input, action] of [['WebSearch', { query: 'query' }, 'search'], ['WebFetch', { url: 'https://example.com' }, 'open_page']]) {
    const item = visible([entry(name, input)])[0].item; assert.equal(item.type, 'WebSearch'); assert.equal(item.action.type, action);
  }
  const rows = encode('claude', endpoint, [entry('update_plan', { plan: [{ step: 'One', status: 'completed' }] }), entry('web_search', { query: 'query' }), entry('exec', { cmd: ['bash', '-lc', 'echo hi'] })]);
  const calls = rows.flatMap(row => Array.isArray(row.message.content) ? row.message.content.filter(b => b.type === 'tool_use') : []);
  assert.deepEqual(calls.map(c => c.name), ['TodoWrite', 'WebSearch', 'Bash']);
  const spoof = encode('claude', endpoint, [entry('mcp__server__exec', { cmd: 'never infer a local command' })]); assert(spoof.every(row => row.type === 'assistant'));
  const completed = extract('codex', [{ type: 'response_item', payload: { id: 'search', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'query' } } }], 'session');
  assert.equal(completed[0].tool.name, 'web_search');
});

test('read-only audit selects interactive sessions, excludes brokers/mirrors, reports services and detects RAW', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-kit-audit-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'claude.jsonl'), home = path.join(root, 'codex'), sessions = path.join(home, 'sessions'); await fs.mkdir(sessions, { recursive: true });
  const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(source, jsonl([
    { type: 'user', uuid: 'q', sessionId: 'source', cwd: root, message: { role: 'user', content: 'Question' } },
    { type: 'assistant', uuid: 'call', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'm', name: 'Monitor', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm', content: 'Monitor started (task private)' }] } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>private</task-notification>' } }
  ]));
  for (const [id, originator] of [['one', 'codex-tui'], ['two', 'codex-tui'], ['three', 'codex-tui'], ['z-broker', 'claude-agent-broker'], ['zz-mirror', 'agent-kit-session-sync']]) await fs.writeFile(path.join(sessions, id + '.jsonl'), jsonl([{ type: 'session_meta', payload: { id, cwd: root, source: 'cli', originator } }, { type: 'response_item', payload: { type: 'message', id: 'u', role: 'user', content: [{ type: 'input_text', text: '<environment_context>service</environment_context>' }] } }]));
  const before = await fs.stat(source), listing = await fs.readdir(root);
  const result = await audit({ claude: source, codexHome: home, count: 3 });
  assert.equal(result.files, 4); assert.equal(result.raw, 0); assert.equal(result.userService, 0);
  assert(result.rows.some(row => row.source === 'claude:tool/Monitor' && row.example === 'Background monitor started.'));
  assert(result.rows.some(row => row.display === 'skipped')); assert(!result.inputs.some(input => /broker|mirror/.test(path.basename(input.file))));
  assert.equal((await fs.stat(source)).mtimeMs, before.mtimeMs); assert.deepEqual(await fs.readdir(root), listing);
  assert.equal(classify('claude', { role: 'user', text: '<task-notification>service</task-notification>', key: 'raw' }, root).route, 'RAW');
  for (const kind of ['claude', 'codex']) assert.equal(classify(kind, { role: 'assistant', text: '[Tool Monitor]\nRaw control response', key: 'raw' }, root).route, 'RAW');
});
