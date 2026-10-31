'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { connectInteractive, interactiveRequest, interactiveResult, interactiveSandboxDecision } = require('../src/agents/interactive-client');
const { connectOwner } = require('../src/agents/mesh-owner');

function fixture(t, agent) {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const writes = [], requests = [];
  const send = msg => proc.stdout.write(JSON.stringify(msg) + '\n');
  proc.stdin.on('data', data => {
    const msg = JSON.parse(data); writes.push(msg);
    if (agent === 'kimi' && msg.id && msg.method !== 'session/prompt') queueMicrotask(() => send({ id: msg.id,
      result: msg.method === 'initialize' ? { agentCapabilities: { loadSession: true } } : { sessionId: 'saved-session' } }));
    if (agent === 'claude' && msg.type === 'control_request') queueMicrotask(() => send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } }));
  });
  let args;
  const client = connectInteractive({ agent, sessionId: 'saved-session', cwd: '/project', env: { CODEX_THREAD_ID: 'owner', CLAUDECODE: '1' },
    spawn(exe, argv, options) { args = argv; assert.equal(options.env.CODEX_THREAD_ID, undefined); assert.equal(options.env.CLAUDECODE, undefined); return proc; },
    onRequest: msg => requests.push(msg) });
  t.after(() => client.close());
  return { client, send, writes, requests, args: () => args };
}
test('Kimi write permissions resolve text paths against agent cwd and keep outside writes as events', () => {
  const cwd = path.resolve('kimi-workspace');
  const decide = content => interactiveSandboxDecision('kimi', interactiveRequest('kimi', {
    method: 'session/request_permission', params: { toolCall: { title: 'Write', content } }
  }), { sandbox: 'workspace-write', cwd });
  for (const text of [
    'Requesting approval to Writing inside.txt',
    'Editing inside.txt\nnext line',
    'Creating inside.txt...',
    'Writing inside.txt…',
    'Writing "inside.txt"'
  ]) assert.equal(decide([{ type: 'content', content: { type: 'text', text } }]), 'approve', text);
  for (const text of ['Writing ../x.txt', `Writing ${path.resolve(cwd, '../outside.txt')}`, 'Requesting approval']) {
    assert.equal(decide([{ type: 'content', content: { type: 'text', text } }]), null, text);
  }
  assert.equal(decide([{ type: 'diff', path: path.join(cwd, 'inside.txt') }]), 'approve');
  assert.equal(decide([{ locations: [{ path: path.join(cwd, 'inside.txt') }] }]), 'approve');
  assert.equal(decide([{ path: path.resolve(cwd, '../outside.txt'), content: { text: 'Writing inside.txt' } }]), null);
});
test('ACP keeps requests open, completes from prompt result, cancels and loads the saved session', async t => {
  const f = fixture(t, 'kimi'); await f.client.ready;
  assert(f.writes.some(m => m.method === 'session/load' && m.params.sessionId === 'saved-session'));
  const done = f.client.prompt('first'); await new Promise(r => setImmediate(r));
  f.send({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'saved-session' } });
  assert.equal(f.requests.length, 1); assert(!f.writes.some(m => m.id === 'permission'));
  f.client.respond('permission', { outcome: { outcome: 'cancelled' } });
  f.send({ method: 'session/update', params: { sessionId: 'saved-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
  const prompt = f.writes.find(m => m.method === 'session/prompt');
  await f.client.interrupt(); assert.equal(f.writes.at(-1).method, 'session/cancel');
  f.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  assert.deepEqual(await done, { text: 'done', status: 'interrupted' });
});
test('Claude keeps stdin open after result and routes can_use_tool, answers, denial and interrupt', async t => {
  const f = fixture(t, 'claude'); await f.client.ready;
  assert(f.args().includes('--resume')); assert(!f.args().includes('--dangerously-skip-permissions'));
  for (const action of ['answer', 'deny', 'approve']) {
    const done = f.client.prompt(action); await new Promise(r => setImmediate(r));
    const request = { tool_name: action === 'answer' ? 'AskUserQuestion' : 'Bash', input: action === 'answer' ? { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } : { command: 'echo hi' } };
    f.send({ type: 'control_request', request_id: action, request: { subtype: 'can_use_tool', ...request } });
    const entry = interactiveRequest('claude', f.requests.at(-1));
    const result = interactiveResult('claude', entry, { text: 'A' }, action);
    f.client.respond(action, result);
    assert.equal(result.behavior, action === 'deny' ? 'deny' : 'allow');
    if (action === 'answer') assert.equal(result.updatedInput.answers['Which?'], 'A');
    f.send({ type: 'result', session_id: 'saved-session', result: action });
    assert.equal((await done).text, action);
  }
  await f.client.interrupt(); assert.equal(f.writes.at(-1).request.subtype, 'interrupt');
});
test('ACP elicitation validates answers and permission grants only allow_once', () => {
  const entry = interactiveRequest('kimi', { method: 'elicitation/create', params: { message: 'Choose', requestedSchema: { type: 'object', properties: { q: { type: 'string', enum: ['A', 'B'] } } } } });
  assert.equal(entry.type, 'question');
  assert.throws(() => interactiveResult('kimi', entry, { text: 'C' }, 'answer'), /Unknown option/);
  assert.deepEqual(interactiveResult('kimi', entry, { text: 'B' }, 'answer'), { action: 'accept', content: { q: 'B' } });
  const permission = interactiveRequest('kimi', { method: 'session/request_permission', params: { options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'no' }] } });
  assert.equal(interactiveResult('kimi', permission, {}, 'approve').outcome.optionId, 'once');
  assert.equal(interactiveResult('kimi', permission, {}, 'deny').outcome.optionId, 'no');
});
test('owner observer routes busy/idle on the same thread and stays passive to server requests', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-owner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = []; let busy = true;
  const owner = connectOwner({ owner: { agent: 'codex', id: 'owner' }, onError: assert.fail, connect(options) {
    options.onRequest({ id: 'orchestrator-permission', method: 'item/tool/requestUserInput' });
    return { ready: Promise.resolve(), notify() {}, close() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: ['owner'] };
      if (method === 'thread/resume') return { thread: { turns: busy ? [{ id: 'active', status: 'inProgress' }] : [] } };
      return {};
    } };
  } });
  await owner.ready;
  await owner.deliver({ id: 'one', from: 'worker', type: 'question', payload: { questions: [] }, summary: 'Q' }, dir);
  busy = false;
  await owner.deliver({ id: 'two', from: 'worker', type: 'turn.completed', payload: {}, summary: 'done' }, dir);
  assert.equal(calls.find(c => c.method === 'turn/steer').params.expectedTurnId, 'active');
  assert.equal(calls.find(c => c.method === 'turn/start').params.threadId, 'owner');
  assert(calls.filter(c => c.method === 'thread/resume').every(c => Object.keys(c.params).length === 1));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mesh-events.cursor.json'))).delivered, ['one', 'two']);
  owner.close();
});
test('embedded Codex and terminal Kimi report explicit unsupported-owner errors', async () => {
  for (const agent of ['codex', 'kimi']) {
    const errors = [];
    const owner = connectOwner({ owner: { agent, id: 'missing' }, onError: e => errors.push(e.message), connect: () => ({ ready: Promise.resolve(), notify() {}, close() {}, request: async method => method === 'thread/loaded/list' ? { data: [] } : {} }) });
    await assert.rejects(owner.ready, agent === 'codex' ? /shared daemon/ : /terminal wake is unsupported/);
    assert.equal(errors.length, 1); owner.close();
  }
});

test('Kimi owner must be live in this web server; cold sessions are never adopted by POST', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-web-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const live of [false, true]) {
    const calls = [], errors = [];
    const owner = connectOwner({ owner: { agent: 'kimi', id: 'owner', url: 'http://localhost:1234' }, env: { AGENT_MESH_KIMI_TOKEN: 'fake-test-token' }, onError: error => errors.push(error.message),
      async fetch(url, options) {
        calls.push({ url, options });
        assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
        return { ok: true, json: async () => ({ code: 0, data: url.includes('/api/v2/') ? { items: [{ id: 'owner', activity: { model: live ? 'fake' : null } }] } : { id: 'owner', workspace_id: 'workspace' } }) };
      }
    });
    if (!live) { await assert.rejects(owner.ready, /Terminal\/cold/); assert.equal(errors.length, 1); }
    else {
      await owner.ready;
      await owner.deliver({ id: 'event', from: 'worker', type: 'turn.completed', payload: {} }, dir);
      assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
      assert(calls.at(-1).url.endsWith('/sessions/owner/prompts'));
    }
    if (!live) assert(!calls.some(c => c.options.method === 'POST'));
    owner.close();
  }
});
