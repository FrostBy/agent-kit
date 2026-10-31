'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const broker = require('../src/sources/broker');
const source = fs.readFileSync(path.resolve(__dirname, '../scripts/agents/broker.js'), 'utf8');

function fixture(t, agent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-broker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompt = path.join(root, 'prompt.md'); fs.writeFileSync(prompt, 'local fixture');
  const exits = [];
  const processMock = Object.assign(new EventEmitter(), { env: { HOME: root, USERPROFILE: root }, pid: 123, cwd: () => root, argv: ['node', 'broker.js', '--agent', agent, '--name', 'worker', '--state', root, '--prompt', prompt], exit: code => { exits.push(code); } });
  if (agent === 'kimi') processMock.argv.push('--kimi-print');
  const children = [], requests = [], intervals = [], timers = [], answers = {};
  function spawn(command, args, options) {
    const stdio = args.includes('stdio://');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = { write(bytes) {
      if (!stdio && typeof bytes === 'string') { queueMicrotask(() => child.stdout.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')); return; }
      let msg;
      if (stdio) msg = JSON.parse(String(bytes).trim());
      else {
        const buffer = Buffer.from(bytes), len = buffer[1] & 127;
        const offset = len < 126 ? 2 : len === 126 ? 4 : 10;
        const mask = buffer.subarray(offset, offset + 4), payload = buffer.subarray(offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        msg = JSON.parse(payload.toString());
      }
      requests.push(msg);
      if (msg.id === undefined || !msg.method) return;
      const result = msg.method === 'thread/start' ? { thread: { id: 'thread-fixture' }, model: 'fixture-model' } : msg.method === 'turn/start' ? { turn: { id: 'turn-fixture' } } : {};
      const response = answers[msg.method] ? answers[msg.method](msg) : { result };
      if (response === null) return;
      queueMicrotask(() => send({ id: msg.id, ...response }));
    } };
    function send(msg) {
      if (stdio) { child.stdout.write(JSON.stringify(msg) + '\n'); return; }
      const b = Buffer.from(JSON.stringify(msg));
      const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]);
      child.stdout.write(Buffer.concat([head, b]));
    }
    child.send = send; children.push({ command, args, options, child }); return child;
  }
  const context = { require: name => name === 'node:child_process' ? { spawn } : require(name.startsWith('.') ? path.resolve(__dirname, '../scripts/agents', name) : name), process: processMock,
    console, Buffer, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} };
  const run = () => vm.runInNewContext(source, context, { filename: 'broker.js' });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'worker.state.json'), 'utf8'));
  return { root, run, state, processMock, children, requests, intervals, timers, answers, exits, spawn, context };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

const meshEvents = f => fs.readFileSync(path.join(f.root, 'worker.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
let commandNumber = 0;
function meshCommand(f, type, payload = {}) {
  fs.writeFileSync(path.join(f.root, 'worker.inbox', `${++commandNumber}.command.json`), JSON.stringify({ v: 1, id: `test-${commandNumber}`, type, payload }));
  f.intervals[0]();
}

test('Codex holds server questions, validates answers and replies on the original typed RPC ID', async t => {
  const f = fixture(t, 'codex'); f.run(); await settle();
  const child = f.children[0].child;
  const params = { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'item', isBlocking: true,
    questions: [{ id: 'choice', question: 'Which route?', options: [{ label: 'A' }, { label: 'B' }] }] };
  child.send({ id: 77, method: 'item/tool/requestUserInput', params });
  child.send({ id: 77, method: 'item/tool/requestUserInput', params });
  child.send({ id: '77', method: 'item/tool/requestUserInput', params });
  await settle();
  const questions = meshEvents(f).filter(e => e.type === 'question');
  assert.equal(questions.length, 2); assert.equal(f.state().status, 'running');
  assert.equal(f.requests.filter(r => !r.method).length, 0);
  assert.equal(questions[0].payload.isBlocking, true);
  meshCommand(f, 'answer', { requestId: questions[0].requestId, text: 'invalid' }); await settle();
  assert.equal(f.requests.filter(r => !r.method).length, 0);
  assert.match(meshEvents(f).at(-1).summary, /Unknown option/);
  meshCommand(f, 'answer', { requestId: questions[0].requestId, text: 'A' }); await settle();
  assert.deepEqual(f.requests.find(r => r.id === 77 && !r.method), { jsonrpc: '2.0', id: 77, result: { answers: { choice: { answers: ['A'] } } } });
  meshCommand(f, 'answer', { requestId: questions[1].requestId, result: { answers: { choice: { answers: ['B'] } } } }); await settle();
  assert.equal(f.requests.find(r => r.id === '77' && !r.method).result.answers.choice.answers[0], 'B');
  meshCommand(f, 'answer', { requestId: questions[0].requestId, text: 'B' }); await settle();
  assert.match(meshEvents(f).at(-1).summary, /Stale or resolved/);
  assert.equal(f.requests.filter(r => !r.method).length, 2);
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 0);
  assert.deepEqual(f.state().pendingRequests, []);
});

test('approval policy is opt-in and approve/deny use command, file and permissions response schemas', async t => {
  const f = fixture(t, 'codex'); f.processMock.argv.push('--approval-policy', 'on-request'); f.run(); await settle();
  assert.equal(f.requests.find(r => r.method === 'thread/start').params.approvalPolicy, 'on-request');
  assert.equal(f.requests.find(r => r.method === 'thread/start').params.approvalsReviewer, 'user');
  const defaultStart = fixture(t, 'codex'); defaultStart.run(); await settle();
  assert.equal(defaultStart.requests.find(r => r.method === 'thread/start').params.approvalsReviewer, undefined);
  const child = f.children[0].child;
  for (const kind of ['commandExecution', 'fileChange', 'permissions']) for (const type of ['approve', 'deny']) {
    const id = `${kind}-${type}`, permissions = { network: { enabled: true }, fileSystem: { write: ['/fixture'] } };
    child.send({ id, method: `item/${kind}/requestApproval`, params: { threadId: 'thread-fixture', turnId: 'turn-fixture', reason: 'fixture approval', permissions, availableDecisions: ['accept', 'decline'] } });
    await settle(); assert(!f.requests.some(r => r.id === id && !r.method));
    const event = meshEvents(f).at(-1); assert.equal(event.type, 'approval');
    meshCommand(f, type, { requestId: event.requestId }); await settle();
    assert.deepEqual(f.requests.find(r => r.id === id && !r.method).result, kind === 'permissions'
      ? { permissions: type === 'approve' ? permissions : {}, scope: 'turn' } : { decision: type === 'approve' ? 'accept' : 'decline' });
  }
  child.send({ id: 'limited', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', availableDecisions: ['cancel'] } });
  await settle(); meshCommand(f, 'approve', { requestId: meshEvents(f).at(-1).requestId }); await settle();
  assert.match(meshEvents(f).at(-1).summary, /not available/);
  assert(!f.requests.some(r => r.id === 'limited' && !r.method));
});

test('command approval deny falls back to cancel when decline is not offered', async t => {
  const f = fixture(t, 'codex'); f.processMock.argv.push('--approval-policy', 'on-request'); f.run(); await settle();
  const child = f.children[0].child;
  child.send({ id: 'classic', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', reason: 'fixture', availableDecisions: ['accept', 'decline'] } });
  child.send({ id: 'amended', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', reason: 'fixture', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { network: true } }, 'cancel'] } });
  await settle();
  meshCommand(f, 'deny', { requestId: meshEvents(f).find(e => e.type === 'approval' && e.payload.reason === 'fixture' && JSON.stringify(e.payload.availableDecisions).includes('decline')).requestId }); await settle();
  assert.deepEqual(f.requests.find(r => r.id === 'classic' && !r.method).result, { decision: 'decline' });
  meshCommand(f, 'deny', { requestId: meshEvents(f).find(e => e.type === 'approval' && e.payload.reason === 'fixture' && JSON.stringify(e.payload.availableDecisions).includes('cancel')).requestId }); await settle();
  assert.deepEqual(f.requests.find(r => r.id === 'amended' && !r.method).result, { decision: 'cancel' });
  // Ошибка валидации (ни decline, ни cancel) не закрывает запрос: повторный ответ проходит.
  child.send({ id: 'retry', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', availableDecisions: ['accept'] } });
  await settle(); meshCommand(f, 'deny', { requestId: meshEvents(f).at(-1).requestId }); await settle();
  assert.match(meshEvents(f).at(-1).summary, /not available/);
  assert(!f.requests.some(r => r.id === 'retry' && !r.method));
  meshCommand(f, 'approve', { requestId: meshEvents(f).find(e => e.type === 'approval' && e.payload.turnId === 'turn-fixture'
    && !meshEvents(f).some(x => x.type === 'request.resolved' && x.requestId === e.requestId)).requestId }); await settle();
  assert.deepEqual(f.requests.find(r => r.id === 'retry' && !r.method).result, { decision: 'accept' });
});

test('server resolution, interrupt, completion and disconnect invalidate requests, including reused wire IDs', async t => {
  for (const action of ['resolved', 'interrupt', 'completed', 'disconnect']) {
    const f = fixture(t, 'codex'); f.run(); await settle();
    let child = f.children[0].child;
    const question = () => child.send({ id: 81, method: 'item/tool/requestUserInput', params: { threadId: 'thread-fixture', turnId: 'turn-fixture',
      isBlocking: false, questions: [{ id: 'q', question: 'Question' }] } });
    question(); await settle(); const id = meshEvents(f).at(-1).requestId;
    if (action === 'resolved') child.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-fixture', requestId: 81 } });
    if (action === 'interrupt') meshCommand(f, 'interrupt');
    if (action === 'completed') child.send({ method: 'turn/completed', params: { turn: { id: 'turn-fixture', status: 'completed' } } });
    if (action === 'disconnect') child.emit('exit', 1);
    await settle(); assert(meshEvents(f).some(e => e.type === 'request.resolved' && e.requestId === id));
    if (action === 'disconnect') { f.timers.at(-1)(); await settle(); child = f.children.at(-1).child; question(); await settle(); }
    meshCommand(f, 'answer', { requestId: id, text: 'late answer' }); await settle();
    assert.match(meshEvents(f).at(-1).summary, /Stale or resolved/);
    assert(!f.requests.some(r => r.id === 81 && !r.method));
    if (action === 'disconnect') {
      const fresh = meshEvents(f).findLast(e => e.type === 'question'); assert.notEqual(fresh.requestId, id);
      meshCommand(f, 'answer', { requestId: fresh.requestId, text: 'current answer' }); await settle();
      assert.equal(f.requests.find(r => r.id === 81 && !r.method).result.answers.q.answers[0], 'current answer');
    } else {
      const before = meshEvents(f).filter(e => e.type === 'question').length;
      question(); await settle(); assert.equal(meshEvents(f).filter(e => e.type === 'question').length, before);
    }
  }
});

test('typed decisions and exit are serviced while turn/steer is still awaiting its RPC response', async t => {
  const f = fixture(t, 'codex'); f.run(); await settle();
  f.answers['turn/steer'] = () => null;
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'message'), 'steer'); f.intervals[0](); await settle();
  const steer = f.requests.find(r => r.method === 'turn/steer'); assert(steer);
  const child = f.children[0].child;
  child.send({ id: 'held', method: 'item/tool/requestUserInput', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', questions: [{ id: 'q', question: 'Continue?' }] } });
  await settle(); meshCommand(f, 'answer', { requestId: meshEvents(f).at(-1).requestId, text: 'yes' }); await settle();
  assert.equal(f.requests.find(r => r.id === 'held' && !r.method).result.answers.q.answers[0], 'yes');
  meshCommand(f, 'exit'); await settle(); assert.deepEqual(f.exits, [0]);
  assert.equal(meshEvents(f).at(-1).type, 'agent.exited');
});

test('shared transport keeps unsupported requests at -32601, holds callbacks without a timer, and responds with errors', async () => {
  const { connectProxy } = require('../src/agents/codex-client');
  for (const callback of [false, true]) {
    let child, incoming; const writes = [];
    const client = connectProxy({ mode: 'stdio', timeout: 10, ...(callback ? { onRequest: msg => { incoming = msg; } } : {}), spawn() {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
      child.stdin.on('data', bytes => writes.push(JSON.parse(String(bytes)))); return child;
    } });
    await client.ready;
    child.stdout.write(JSON.stringify({ id: 'server-1', method: 'test', params: {} }) + '\n');
    await new Promise(r => setTimeout(r, 25)); assert.equal(client.alive, true);
    if (callback) { assert.equal(incoming.id, 'server-1'); assert.equal(writes.length, 0); client.respond(incoming.id, { code: -32602, message: 'bad answer' }); }
    assert.equal(writes.length, 1); assert.equal(writes[0].id, 'server-1'); assert.equal(writes[0].error.code, callback ? -32602 : -32601);
    client.close(); assert.throws(() => client.respond('late', {}), /disconnected/);
  }
});

test('Codex broker keeps state format and exclusion policy; turns, inbox steering and reconnect use the same thread', async t => {
  const f = fixture(t, 'codex'); f.run(); await settle();
  assert.equal(f.processMock.env.SESSION_SYNC_BROKER, '1');
  assert.equal(f.children[0].command, 'codex'); assert.deepEqual(Array.from(f.children[0].args), ['app-server', 'proxy']);
  assert.equal(f.children[0].options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  const start = f.requests.find(r => r.method === 'thread/start');
  assert.equal(start.params.config.shell_environment_policy.set.SESSION_SYNC_BROKER, '1');
  assert.equal(f.state().threadId, 'thread-fixture'); assert.equal(f.state().status, 'running');
  assert.equal(broker.agents(f.root, 'codex')[0].id, 'thread-fixture');
  fs.writeFileSync(path.join(f.root, 'worker.inbox', '001'), 'steer fixture'); f.intervals[0](); await settle();
  assert(f.requests.some(r => r.method === 'turn/steer'));
  const child = f.children[0].child;
  child.send({ method: 'item/completed', params: { threadId: 'thread-fixture', item: { type: 'agentMessage', text: 'fixture answer' } } });
  child.send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } } });
  await settle(); assert.equal(f.state().status, 'idle'); assert.equal(f.state().turns, 1);
  assert.ok(f.state().lastTurnAt);
  assert.equal(fs.readFileSync(path.join(f.root, 'worker.out.md'), 'utf8'), 'fixture answer');
  child.emit('exit', 1); assert.equal(f.state().status, 'reconnecting');
  f.timers.at(-1)(); await settle();
  assert(f.requests.some(r => r.method === 'thread/resume' && r.params.threadId === 'thread-fixture'));
});

test('Codex mode preserves model/effort on every Plan turn and omits collaborationMode by default', async t => {
  for (const mode of [undefined, 'default', 'plan']) for (const override of [false, true]) {
    const f = fixture(t, 'codex');
    if (mode) f.processMock.argv.push('--mode', mode);
    if (override) f.processMock.argv.push('--model', 'selected-model', '--effort', 'high');
    f.answers['thread/start'] = () => ({ result: { thread: { id: 'thread-fixture' }, model: 'current-model', reasoningEffort: 'low' } });
    f.run(); await settle();
    assert.equal(f.state().launch.mode, mode ?? 'default');
    const check = (model, effort) => {
      const params = f.requests.filter(r => r.method === 'turn/start').at(-1).params;
      if (mode === 'plan') assert.deepEqual(params.collaborationMode, { mode: 'plan', settings: {
        model: override ? 'selected-model' : model, reasoning_effort: override ? 'high' : effort, developer_instructions: null,
      } });
      else assert(!Object.hasOwn(params, 'collaborationMode'));
    };
    check('current-model', 'low');
    if (mode === 'plan') assert.equal(f.requests.find(r => r.method === 'initialize').params.capabilities.experimentalApi, true);
    f.children[0].child.send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    f.children[0].child.send({ method: 'thread/settings/updated', params: { threadId: 'thread-fixture', threadSettings: { model: 'updated-model', effort: 'medium' } } });
    fs.writeFileSync(path.join(f.root, 'worker.inbox', 'next'), 'next turn'); f.intervals[0](); await settle();
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 2);
    check('updated-model', 'medium');
  }
});

test('--mode rejects invalid values and non-Codex agents before spawning', t => {
  for (const [agent, mode] of [['codex', 'auto'], ['kimi', 'plan'], ['claude', 'default']]) {
    const f = fixture(t, agent); f.processMock.argv.push('--mode', mode);
    assert.throws(f.run, /Invalid --mode/); assert.equal(f.children.length, 0);
  }
});

test('Kimi broker preserves sessionId and resumes through inbox without real CLI or network', async t => {
  const f = fixture(t, 'kimi'); f.run();
  assert.equal(f.children[0].command, 'kimi');
  f.children[0].child.stdout.write('fixture response');
  f.children[0].child.stderr.write('To resume this session: kimi -r session_fixture');
  f.children[0].child.emit('exit', 0); await settle();
  assert.equal(f.state().sessionId, 'session_fixture'); assert.equal(f.state().status, 'idle');
  assert.equal(broker.agents(f.root, 'kimi')[0].id, 'session_fixture');
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'next'), 'next prompt'); f.timers.at(-1)(); await settle();
  assert(Array.from(f.children[1].args).includes('session_fixture'));
});

test('interactive broker queues busy messages as next turns while answers and interrupt stay independent', async t => {
  const f = fixture(t, 'claude'), original = f.context.require;
  const prompts = [], responses = []; let options, complete, interrupted = false;
  f.context.require = name => name === '../../src/agents/interactive-client' ? {
    ...original(name), connectInteractive(config) {
      options = config;
      return { ready: Promise.resolve(), prompt(text) { prompts.push(text); return new Promise(resolve => { complete = resolve; }); },
        respond(id, result) { responses.push({ id, result }); }, interrupt: async () => { interrupted = true; }, close: async () => {} };
    }
  } : original(name);
  f.run(); await settle(); assert.equal(f.state().capabilities.steer, false);
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'next'), 'next message'); f.intervals[0](); await settle();
  assert.deepEqual(prompts, ['local fixture']);
  options.onRequest({ id: 'question', method: 'can_use_tool', params: { tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } } });
  const event = meshEvents(f).find(e => e.type === 'question');
  meshCommand(f, 'answer', { requestId: event.requestId, text: 'A' }); await settle();
  assert.equal(responses[0].result.updatedInput.answers['Q?'], 'A'); assert.deepEqual(prompts, ['local fixture']);
  complete({ text: 'first', status: 'completed' }); await settle();
  assert.deepEqual(prompts, ['local fixture', 'next message']); assert.equal(f.state().turns, 1);
  meshCommand(f, 'interrupt'); await settle(); assert(interrupted);
  complete({ text: '', status: 'interrupted' }); await settle();
  assert.equal(f.state().status, 'idle'); assert.equal(f.state().turns, 2);
  meshCommand(f, 'exit'); await settle(); assert.deepEqual(f.exits, [0]);
});

test('sandbox workspace-write auto-approves in-cwd writes and ordinary commands without waking the orchestrator', async t => {
  const f = fixture(t, 'claude'), original = f.context.require;
  const responses = []; let options, complete;
  f.context.require = name => name === '../../src/agents/interactive-client' ? {
    ...original(name), connectInteractive(config) {
      options = config;
      return { ready: Promise.resolve(), prompt() { return new Promise(resolve => { complete = resolve; }); },
        respond(id, result) { responses.push({ id, result }); }, interrupt: async () => {}, close: async () => {} };
    }
  } : original(name);
  f.processMock.argv.push('--sandbox', 'workspace-write');
  f.run(); await settle();
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'go'), 'run'); f.intervals[0](); await settle();
  const ask = (id, tool_name, input) => options.onRequest({ id, method: 'can_use_tool', params: { tool_name, input } });
  ask('in-cwd', 'Edit', { file_path: path.join(f.root, 'a.txt'), old_string: 'x', new_string: 'y' }); await settle();
  assert.deepEqual(responses.at(-1), { id: 'in-cwd', result: { behavior: 'allow', updatedInput: { file_path: path.join(f.root, 'a.txt'), old_string: 'x', new_string: 'y' } } });
  assert(!meshEvents(f).some(e => e.type === 'approval')); assert(!meshEvents(f).some(e => e.type === 'question'));
  assert.equal(meshEvents(f).filter(e => e.type === 'approval.auto' && e.payload.decision === 'approve').length, 1);
  assert.deepEqual(f.state().pendingRequests, []);
  ask('bash', 'Bash', { command: 'npm test' }); await settle();
  assert.equal(responses.at(-1).id, 'bash'); assert.equal(responses.at(-1).result.behavior, 'allow');
  ask('curl', 'Bash', { command: 'curl https://example.com' }); await settle();
  assert(!responses.some(r => r.id === 'curl')); assert(meshEvents(f).some(e => e.type === 'approval'));
  complete({ text: 'done', status: 'completed' }); await settle();
  assert(!responses.some(r => r.id === 'curl'));
});

test('sandbox workspace-write defers writes outside cwd to the orchestrator', async t => {
  const f = fixture(t, 'claude'), original = f.context.require;
  const responses = []; let options, complete;
  f.context.require = name => name === '../../src/agents/interactive-client' ? {
    ...original(name), connectInteractive(config) {
      options = config;
      return { ready: Promise.resolve(), prompt() { return new Promise(resolve => { complete = resolve; }); },
        respond(id, result) { responses.push({ id, result }); }, interrupt: async () => {}, close: async () => {} };
    }
  } : original(name);
  f.processMock.argv.push('--sandbox', 'workspace-write');
  f.run(); await settle();
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'go'), 'run'); f.intervals[0](); await settle();
  options.onRequest({ id: 'outside', method: 'can_use_tool', params: { tool_name: 'Write', input: { file_path: path.join(os.tmpdir(), 'elsewhere-agent-kit.txt'), content: 'x' } } });
  await settle();
  assert(!responses.some(r => r.id === 'outside'));
  const event = meshEvents(f).find(e => e.type === 'approval');
  assert(event); assert.match(event.summary, /Write/);
  meshCommand(f, 'approve', { requestId: event.requestId }); await settle();
  assert.deepEqual(responses.at(-1), { id: 'outside', result: { behavior: 'allow', updatedInput: { file_path: path.join(os.tmpdir(), 'elsewhere-agent-kit.txt'), content: 'x' } } });
  complete({ text: 'done', status: 'completed' }); await settle();
});

test('sandbox read-only auto-denies writes and leaves ordinary commands to the orchestrator', async t => {
  const f = fixture(t, 'claude'), original = f.context.require;
  const responses = []; let options, complete;
  f.context.require = name => name === '../../src/agents/interactive-client' ? {
    ...original(name), connectInteractive(config) {
      options = config;
      return { ready: Promise.resolve(), prompt() { return new Promise(resolve => { complete = resolve; }); },
        respond(id, result) { responses.push({ id, result }); }, interrupt: async () => {}, close: async () => {} };
    }
  } : original(name);
  f.processMock.argv.push('--sandbox', 'read-only');
  f.run(); await settle();
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'go'), 'run'); f.intervals[0](); await settle();
  options.onRequest({ id: 'write', method: 'can_use_tool', params: { tool_name: 'Write', input: { file_path: path.join(f.root, 'a.txt'), content: 'x' } } });
  await settle();
  assert.deepEqual(responses.at(-1), { id: 'write', result: { behavior: 'deny', message: 'Denied by orchestrator' } });
  assert(!meshEvents(f).some(e => e.type === 'approval')); assert(!meshEvents(f).some(e => e.type === 'question'));
  assert.equal(meshEvents(f).filter(e => e.type === 'approval.auto' && e.payload.decision === 'deny').length, 1);
  options.onRequest({ id: 'bash', method: 'can_use_tool', params: { tool_name: 'Bash', input: { command: 'ls' } } });
  await settle();
  assert(!responses.some(r => r.id === 'bash')); assert(meshEvents(f).some(e => e.type === 'approval'));
  complete({ text: 'done', status: 'completed' }); await settle();
});

test('kimi ACP sandbox auto-approval answers with the allow_once permission option', async t => {
  const f = fixture(t, 'kimi'), original = f.context.require;
  f.processMock.argv.splice(f.processMock.argv.indexOf('--kimi-print'), 1);
  const responses = []; let options, complete;
  f.context.require = name => name === '../../src/agents/interactive-client' ? {
    ...original(name), connectInteractive(config) {
      options = config;
      return { ready: Promise.resolve(), prompt() { return new Promise(resolve => { complete = resolve; }); },
        respond(id, result) { responses.push({ id, result }); }, interrupt: async () => {}, close: async () => {} };
    }
  } : original(name);
  f.processMock.argv.push('--sandbox', 'workspace-write');
  f.run(); await settle();
  options.onSession('session-fixture');
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'go'), 'run'); f.intervals[0](); await settle();
  const permission = { sessionId: 'session-fixture', toolCall: { title: 'Edit', content: [{ content: { text: 'edit a.txt' }, locations: [{ path: path.join(f.root, 'a.txt') }] }] },
    options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'no' }] };
  options.onRequest({ id: 'perm', method: 'session/request_permission', params: permission });
  await settle();
  assert.deepEqual(responses.at(-1), { id: 'perm', result: { outcome: { outcome: 'selected', optionId: 'once' } } });
  assert(!meshEvents(f).some(e => e.type === 'approval'));
  assert.equal(meshEvents(f).filter(e => e.type === 'approval.auto' && e.payload.decision === 'approve').length, 1);
  permission.toolCall = { title: 'WebFetch', content: [{ content: { text: 'https://example.com' } }] };
  options.onRequest({ id: 'net', method: 'session/request_permission', params: permission });
  await settle();
  assert(!responses.some(r => r.id === 'net')); assert(meshEvents(f).some(e => e.type === 'approval'));
  complete({ text: 'done', status: 'completed' }); await settle();
});

test('broker refuses names escaping its state directory before starting a CLI', t => {
  const f = fixture(t, 'codex'); f.processMock.argv[f.processMock.argv.indexOf('--name') + 1] = '../escape';
  assert.throws(f.run, /Invalid agent name/); assert.equal(f.children.length, 0);
});

test('Codex exits archive on /exit, idle timeout and graceful process signals; failures do not prevent exit', async t => {
  for (const mode of ['inbox', 'idle', 'signal', 'beforeExit', 'archive-error']) {
    const f = fixture(t, 'codex');
    if (mode === 'idle') f.processMock.argv.push('--idle-min', '0.0000001');
    if (mode === 'archive-error') f.answers['thread/archive'] = () => ({ error: { message: 'archive denied' } });
    f.run(); await settle();
    if (mode === 'inbox' || mode === 'archive-error') {
      fs.writeFileSync(path.join(f.root, 'worker.inbox', 'exit'), '/exit'); f.intervals[0]();
    } else if (mode === 'idle') {
      f.children[0].child.send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      // The idle check compares Date.now(); on fast runners it can land in the same millisecond.
      await new Promise(r => setTimeout(r, 20));
      f.intervals[0]();
    } else f.processMock.emit(mode === 'signal' ? 'SIGTERM' : 'beforeExit');
    // Exit paths are asynchronous; slower CI runners need more than one settle tick.
    let request;
    for (let i = 0; i < 100 && !(request = f.requests.find(r => r.method === 'thread/archive')); i++) await new Promise(r => setTimeout(r, 10));
    await settle();
    assert.ok(request, `no thread/archive in mode ${mode}`);
    assert.deepEqual(request.params, { threadId: 'thread-fixture' });
    assert.equal(f.state().status, 'done'); assert.equal(f.state().archived, mode !== 'archive-error'); assert.deepEqual(f.exits, [0]);
    if (mode === 'archive-error') assert.match(fs.readFileSync(path.join(f.root, 'worker.log'), 'utf8'), /archive failed/);
    assert.equal(broker.agents(f.root, 'codex').length, 0);
  }
});

test('saved archived threads unarchive before resume; reconnect detects an externally archived rollout', async t => {
  const f = fixture(t, 'codex');
  fs.writeFileSync(path.join(f.root, 'worker.state.json'), JSON.stringify({ agent: 'codex', threadId: 'saved-thread', status: 'done', archived: true, turns: 2 }));
  f.run(); await settle();
  assert(f.requests.findIndex(r => r.method === 'thread/unarchive') < f.requests.findIndex(r => r.method === 'thread/resume'));
  assert(!f.requests.some(r => r.method === 'thread/start')); assert.equal(f.state().threadId, 'saved-thread'); assert.equal(f.state().archived, false);
  f.answers['thread/read'] = () => ({ result: { thread: { path: '\\\\?\\C:\\home\\codex\\archived_sessions\\rollout-saved-thread.jsonl' } } });
  f.children[0].child.emit('exit', 1); f.timers.at(-1)(); await settle();
  const last = f.requests.slice(f.requests.findLastIndex(r => r.method === 'initialize'));
  assert.deepEqual(last.filter(r => r.method.startsWith('thread/')).map(r => r.method), ['thread/read', 'thread/unarchive', 'thread/resume']);
});

test('failed/serverOverloaded turns keep the agent idle and accept inbox without archiving', async t => {
  const f = fixture(t, 'codex'); f.run(); await settle();
  f.children[0].child.send({ method: 'error', params: { error: { codexErrorInfo: 'serverOverloaded', message: 'busy' } } });
  f.children[0].child.send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'serverOverloaded' } } } });
  await settle(); assert.equal(f.state().status, 'idle');
  assert(!f.requests.some(r => r.method === 'thread/archive')); assert.deepEqual(f.exits, []);
  fs.writeFileSync(path.join(f.root, 'worker.inbox', 'retry'), 'try again'); f.intervals[0](); await settle();
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 2);
});

test('turn/start on an externally archived thread unarchives, resumes once and retries the message', async t => {
  for (const message of ['thread not found: saved-thread', 'thread is archived']) {
    const f = fixture(t, 'codex');
    fs.writeFileSync(path.join(f.root, 'worker.state.json'), JSON.stringify({ agent: 'codex', threadId: 'saved-thread', status: 'idle', turns: 1 }));
    f.run(); await settle();
    assert.equal(f.state().status, 'idle');
    let recovered = false;
    f.answers['turn/start'] = () => {
      if (!recovered) { recovered = true; return { error: { code: -32600, message } }; }
      return { result: { turn: { id: 'turn-after-recovery' } } };
    };
    fs.writeFileSync(path.join(f.root, 'worker.inbox', '001'), 'continue after archive');
    f.intervals[0](); await settle();
    const after = f.requests.slice(f.requests.findLastIndex(r => r.method === 'initialize'));
    assert.deepEqual(after.filter(r => r.method.startsWith('thread/')).map(r => r.method), ['thread/read', 'thread/resume', 'thread/unarchive', 'thread/resume']);
    assert.equal(f.requests.filter(r => r.method === 'turn/start').length, 2);
    assert.equal(f.state().archived, false);
    assert.match(fs.readFileSync(path.join(f.root, 'worker.log'), 'utf8'), /unarchive and resume/);
    f.children[0].child.send({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'turn-after-recovery', status: 'completed' } } });
    await settle();
    assert.equal(f.state().status, 'idle'); assert.equal(f.state().turns, 2);
  }
});

test('non-archive turn/start errors still surface as a failed message', async t => {
  const f = fixture(t, 'codex'); f.run(); await settle();
  f.children[0].child.send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } } });
  await settle();
  f.answers['turn/start'] = () => ({ error: { code: -32602, message: 'invalid params' } });
  fs.writeFileSync(path.join(f.root, 'worker.inbox', '001'), 'broken request');
  f.intervals[0](); await settle();
  assert(!f.requests.some(r => r.method === 'thread/unarchive'));
  assert.equal(f.state().status, 'idle');
  assert.match(fs.readFileSync(path.join(f.root, 'worker.out.md'), 'utf8'), /сообщение не принято сервером/);
});

test('archive protects live broker state in the default Claude scratchpad without --state', async t => {
  const scratch = path.join(os.tmpdir(), 'claude');
  if (!fs.existsSync(scratch)) { t.skip('no Claude scratchpad'); return; }
  const f = fixture(t, 'codex'), { archiveSessions } = require('../scripts/agents/archive-broker-sessions');
  const dir = path.join(f.root, 'sessions'); fs.mkdirSync(dir);
  const old = new Date(Date.now() - 2 * 3600000);
  for (const id of ['live-default', 'running-default']) {
    const file = path.join(dir, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ timestamp: old.toISOString(), type: 'session_meta', payload: { id, originator: 'claude-agent-broker' } }) + '\n');
    fs.utimesSync(file, old, old);
  }
  const marker = `archive-default-${process.pid}-${Date.now()}`;
  fs.writeFileSync(path.join(scratch, `${marker}-live.state.json`), JSON.stringify({ agent: 'codex', threadId: 'live-default', pid: process.pid, status: 'idle' }));
  fs.writeFileSync(path.join(scratch, `${marker}-running.state.json`), JSON.stringify({ agent: 'codex', threadId: 'running-default', pid: 999999999, status: 'running' }));
  t.after(() => { for (const suffix of ['live', 'running']) fs.rmSync(path.join(scratch, `${marker}-${suffix}.state.json`), { force: true }); });
  const result = await archiveSessions({ home: f.root, env: f.processMock.env, log: () => {}, connect: () => { throw new Error('must not connect in dry-run'); } });
  assert.equal(result.candidates, 0); assert.equal(f.children.length, 0);
});

test('archive command is dry-run by default and archives only old idle broker sessions via proxy', async t => {
  const f = fixture(t, 'codex'), { archiveSessions } = require('../scripts/agents/archive-broker-sessions');
  const { connectProxy } = require('../src/agents/codex-client');
  const dir = path.join(f.root, 'sessions'); fs.mkdirSync(dir);
  const old = new Date(Date.now() - 2 * 3600000);
  function rollout(id, originator, running = false, recent = false) {
    const file = path.join(dir, `rollout-${id}.jsonl`), timestamp = (recent ? new Date() : old).toISOString();
    const rows = [{ timestamp, type: 'session_meta', payload: { id, originator, source: 'vscode' } },
      { timestamp, type: 'event_msg', payload: { type: running ? 'task_started' : 'task_complete' } }];
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); if (!recent) fs.utimesSync(file, old, old);
  }
  rollout('eligible', 'claude-agent-broker'); rollout('running', 'claude-agent-broker', true);
  rollout('recent', 'claude-agent-broker', false, true); rollout('native', 'codex-tui'); rollout('live', 'claude-agent-broker');
  fs.writeFileSync(path.join(f.root, 'live.state.json'), JSON.stringify({ agent: 'codex', threadId: 'live', pid: process.pid, status: 'idle' }));
  const options = { home: f.root, env: f.processMock.env, stateDirs: [f.root], log: () => {}, connect: args => connectProxy({ ...args, spawn: f.spawn }) };
  assert.equal((await archiveSessions(options)).candidates, 1); assert.equal(f.children.length, 0);
  const result = await archiveSessions({ ...options, apply: true }); assert.equal(result.archived, 1);
  assert.deepEqual(f.requests.filter(r => r.method === 'thread/archive').map(r => r.params.threadId), ['eligible']);
  fs.writeFileSync(path.join(f.root, 'archived.state.json'), JSON.stringify({ agent: 'codex', threadId: 'missing-rollout', status: 'idle', archived: true }));
  assert(!broker.agents(f.root, 'codex').some(agent => agent.id === 'missing-rollout'));
  assert.doesNotThrow(() => require('../src/sources/codex').load(f.root, Date.now(), f.root, () => true, f.root));
});

test('isolated stdio transport uses the official dedicated app-server, not the shared proxy', async () => {
  const { connectProxy } = require('../src/agents/codex-client'), requests = [];
  const client = connectProxy({ mode: 'stdio', spawn(command, args) {
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', bytes => {
      const msg = JSON.parse(bytes.toString()); requests.push(msg);
      if (msg.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n'));
    });
    return child;
  } });
  await client.ready; assert.deepEqual(await client.request('initialize', {}), { ok: true }); client.close();
  assert.equal(requests[0].method, 'initialize');
});

test('existing mirror settings are reset through API using an ephemeral user-default probe', async () => {
  const { resetSettings } = require('../scripts/agents/reset-mirror-settings'), calls = [];
  const policy = { type: 'workspace-write', writable_roots: [], network_access: false };
  const connect = () => ({ ready: Promise.resolve(), notify() {}, close() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { cwd: '/demo/project' } };
    if (method === 'thread/start') return { thread: { id: 'probe' }, sandbox: policy, approvalPolicy: 'on-request' };
    return {};
  } });
  await resetSettings('mirror', { connect, log: () => {} }); assert.equal(calls.length, 0);
  await resetSettings('mirror', { apply: true, connect, log: () => {} });
  assert.deepEqual(calls.find(call => call.method === 'thread/start').params, { cwd: '/demo/project', ephemeral: true });
  assert.deepEqual(calls.find(call => call.method === 'thread/settings/update').params, { threadId: 'mirror', sandboxPolicy: policy, approvalPolicy: 'on-request' });
  assert(calls.find(call => call.method === 'thread/resume')); assert(calls.find(call => call.method === 'thread/unsubscribe'));
});

test('broker shutdown never archives a sync-owned thread, including extra profiles and corrupt registries', async t => {
  for (const broken of [false, true]) {
    const f = fixture(t, 'codex'), profile = path.join(f.root, 'work-profile');
    f.processMock.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'agent-kit-session-sync';
    f.processMock.argv.push('--claude-config-dir', profile);
    f.run(); await settle();
    const dir = path.join(profile, 'agent-kit', 'sync', 'project'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pairs.json'), broken ? '{' : JSON.stringify({ version: 2, pairs: [{ id: 'pair', codex: { id: 'thread-fixture', mirror: true, managed: 'app-server' } }] }));
    f.processMock.emit('SIGTERM'); await settle();
    assert(!f.requests.some(r => r.method === 'thread/archive')); assert.equal(f.state().archived, false); assert.deepEqual(f.exits, [0]);
    assert.equal(f.children[0].options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'agent-kit-session-sync');
    assert.equal(f.processMock.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'agent-kit-session-sync');
  }
});

test('archive excludes poisoned mirror IDs and rechecks registries immediately before mutation', async t => {
  const { archiveSessions } = require('../scripts/agents/archive-broker-sessions');
  const { connectProxy } = require('../src/agents/codex-client');
  const f = fixture(t, 'codex'), sessions = path.join(f.root, 'sessions'), profile = path.join(f.root, 'work');
  fs.mkdirSync(sessions); const dir = path.join(profile, 'agent-kit', 'sync', 'project'); fs.mkdirSync(dir, { recursive: true });
  const writeRegistry = ids => fs.writeFileSync(path.join(dir, 'pairs.json'), JSON.stringify({ version: 2, pairs: ids.map(id => ({ id: 'pair-' + id, codex: { id, managed: 'app-server', mirror: true } })) }));
  const old = new Date(Date.now() - 2 * 3600000);
  for (const id of ['mirror', 'broker', 'racing']) {
    const file = path.join(sessions, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ timestamp: old.toISOString(), type: 'session_meta', payload: { id, originator: 'claude-agent-broker', source: 'vscode' } }) + '\n'); fs.utimesSync(file, old, old);
  }
  writeRegistry(['mirror']);
  const args = { home: f.root, env: f.processMock.env, claudeConfigDirs: [profile], log: () => {}, connect: opts => connectProxy({ ...opts, spawn: f.spawn }) };
  const dry = await archiveSessions(args); assert(dry.protectedSync.includes('mirror')); assert(!dry.candidateIds.includes('mirror')); assert.equal(f.children.length, 0);
  f.answers['thread/read'] = msg => { if (msg.params.threadId === 'racing') writeRegistry(['mirror', 'racing']); return { result: {} }; };
  await archiveSessions({ ...args, apply: true });
  assert.deepEqual(f.requests.filter(r => r.method === 'thread/archive').map(r => r.params.threadId), ['broker']);
  assert(!f.requests.some(r => r.method === 'thread/archive' && ['mirror', 'racing'].includes(r.params.threadId)));
});

test('archive CLI accepts repeated Claude profile options and dry-run never starts app-server', t => {  const f = fixture(t, 'codex'), dirs = ['one', 'two'].map(name => path.join(f.root, name));
  for (const [n, profile] of dirs.entries()) {
    const folder = path.join(profile, 'agent-kit', 'sync', 'project'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'pairs.json'), JSON.stringify({ version: 2, pairs: [{ id: 'pair', codex: { id: 'mirror-' + n } }] }));
  }
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/agents/archive-broker-sessions.js'), '--claude-config-dir', dirs[0], '--claude-config-dir', dirs[1]], {
    env: { ...process.env, ...f.processMock.env, CODEX_HOME: f.root, AGENT_BROKER_CODEX: 'MUST-NOT-RUN' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Protected sync thread: mirror-0/); assert.match(result.stdout, /Protected sync thread: mirror-1/);
  assert.match(result.stdout, /dry-run, no app-server connection/);
});

test('send puts the message into the inbox and prints the finished turn output', async t => {
  const { spawn, spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-send-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'worker.inbox'));
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'codex', status: 'idle', turns: 1, pid: process.pid }));
  const script = path.resolve(__dirname, '../scripts/agents/broker.js');
  const env = { ...process.env, BROKER_POLL_MS: '50' };
  const child = spawn(process.execPath, [script, 'send', '--name', 'worker', '--state', root, '--text', 'hello agent', '--timeout-min', '1'], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  // Подмена брокера: забираем письмо из inbox, «завершаем» ход с ростом turns.
  let letter = null;
  for (let i = 0; i < 200 && !letter; i++) {
    await new Promise(r => setTimeout(r, 10));
    letter = fs.readdirSync(path.join(root, 'worker.inbox')).find((f) => !f.startsWith('.'));
  }
  assert.ok(letter, 'send did not drop the message into the inbox');
  assert.match(letter, /^\d{15}-\d+$/);
  assert.equal(fs.readFileSync(path.join(root, 'worker.inbox', letter), 'utf8'), 'hello agent');
  fs.writeFileSync(path.join(root, 'worker.out.md'), 'turn result');
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'codex', status: 'idle', turns: 2, lastTurnAt: new Date().toISOString(), pid: process.pid }));
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, stderr); assert.equal(stdout, 'turn result');
  // --message FILE - тот же путь к письму.
  const message = path.join(root, 'msg.md'); fs.writeFileSync(message, 'from file');
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'kimi', status: 'idle', turns: 2, pid: process.pid }));
  const again = spawn(process.execPath, [script, 'send', '--name', 'worker', '--state', root, '--message', message, '--timeout-min', '1'], { env });
  const letter2 = await new Promise((resolve) => {
    const poll = setInterval(() => {
      const found = fs.readdirSync(path.join(root, 'worker.inbox')).filter((f) => !f.startsWith('.'));
      if (found.length > 1) { clearInterval(poll); resolve(found.find((f) => f !== letter)); }
    }, 10);
  });
  assert.equal(fs.readFileSync(path.join(root, 'worker.inbox', letter2), 'utf8'), 'from file');
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'kimi', status: 'idle', turns: 3, pid: process.pid }));
  assert.equal(await new Promise(r => again.on('exit', r)), 0);
});

test('send and wait count an errored finished turn as turn completion', async t => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-send-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'worker.inbox'));
  const script = path.resolve(__dirname, '../scripts/agents/broker.js');
  const env = { ...process.env, BROKER_POLL_MS: '50' };
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'codex', status: 'idle', turns: 1, pid: process.pid }));
  const child = spawn(process.execPath, [script, 'send', '--name', 'worker', '--state', root, '--text', 'x', '--timeout-min', '1'], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  let letter = null;
  for (let i = 0; i < 200 && !letter; i++) {
    await new Promise(r => setTimeout(r, 10));
    letter = fs.readdirSync(path.join(root, 'worker.inbox')).find((f) => !f.startsWith('.'));
  }
  assert.ok(letter);
  // Ход завершился с ошибкой - turns вырос, status error: send всё равно печатает out.md.
  fs.writeFileSync(path.join(root, 'worker.out.md'), 'error report');
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'codex', status: 'error', turns: 2, pid: process.pid }));
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, stderr); assert.equal(stdout, 'error report');
  // wait на статусе running дождётся конца текущего хода.
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'kimi', status: 'running', turns: 2, pid: process.pid }));
  const waiter = spawn(process.execPath, [script, 'wait', '--name', 'worker', '--state', root, '--timeout-min', '1'], { env });
  let waitOut = '';
  waiter.stdout.on('data', (d) => { waitOut += d; });
  await new Promise(r => setTimeout(r, 150));
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'kimi', status: 'idle', turns: 3, pid: process.pid }));
  assert.equal(await new Promise(r => waiter.on('exit', r)), 0);
  assert.equal(waitOut, 'error report');
});

test('send and wait exit 1 with a clear message on a dead broker pid or turn timeout', async t => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-send-dead-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.resolve(__dirname, '../scripts/agents/broker.js');
  const env = { ...process.env, BROKER_POLL_MS: '20' };
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'codex', status: 'idle', turns: 3, pid: 999999999 }));
  for (const mode of ['wait', 'send']) {
    const args = [script, mode, '--name', 'worker', '--state', root];
    if (mode === 'send') args.push('--text', 'x');
    const r = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /не жив/);
  }
  fs.writeFileSync(path.join(root, 'worker.state.json'), JSON.stringify({ agent: 'kimi', status: 'running', turns: 0, pid: process.pid }));
  const r = spawnSync(process.execPath, [script, 'wait', '--name', 'worker', '--state', root, '--timeout-min', '0.0005'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /таймаут/);
});

test('idle defaults to 15 minutes, preserves overrides and emits an idle exit for both agents', async t => {
  for (const agent of ['codex', 'kimi']) for (const idleMin of [undefined, 2]) {
    const f = fixture(t, agent); let now = Date.now();
    f.context.Date = class extends Date { static now() { return now; } };
    if (idleMin) f.processMock.argv.push('--idle-min', String(idleMin));
    f.run(); await settle();
    if (agent === 'codex') f.children[0].child.send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    else f.children[0].child.emit('exit', 0);
    await settle(); assert.equal(f.state().launch.idleMin, idleMin ?? 15);
    now += (idleMin ?? 15) * 60000 + 1;
    if (agent === 'codex') f.intervals[0](); else f.timers.at(-1)();
    await settle(); assert.deepEqual(f.exits, [0]);
    assert.equal(meshEvents(f).at(-1).payload.reason, 'idle');
  }
});

test('send revives detached Codex/Kimi with saved settings and delivers only the new turn', async t => {
  for (const agent of ['codex', 'kimi']) {
    const f = fixture(t, agent), stateFile = path.join(f.root, 'worker.state.json');
    const launch = { agent, cwd: f.root, model: 'saved-model', effort: 'high', mode: agent === 'codex' ? 'plan' : undefined, sandbox: 'read-only', approvalPolicy: 'on-request', network: true, search: true, idleMin: 3, kimiPrint: agent === 'kimi' };
    fs.writeFileSync(stateFile, JSON.stringify({ agent, pid: 999999999, status: 'done', turns: 4, threadId: agent === 'codex' ? 'thread-saved' : undefined,
      sessionId: agent === 'kimi' ? 'session_saved' : undefined, turnId: 'old-turn', launch }));
    const stale = require('../src/agents/mesh').eventWriter(path.join(f.root, 'worker'), 'worker')('question', {}, { requestId: 'stale' });
    let output = '', spawned;
    let exitResolve; const exited = new Promise(resolve => { exitResolve = resolve; });
    const sendProcess = { env: { BROKER_POLL_MS: '1' }, pid: 555, execPath: process.execPath,
      argv: ['node', 'broker.js', 'send', '--name', 'worker', '--state', f.root, '--text', 'new message', '--timeout-min', '0.01'],
      stdout: { write: text => { output += text; } }, exit(code) { exitResolve(code); throw Error('test exit'); } };
    vm.runInNewContext(source, { require: name => name === 'node:child_process' ? { spawn(command, args, options) {
      spawned = { command, args, options }; assert.equal(options.detached, true); assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'ignore');
      assert(!args.includes('--prompt')); assert(args.includes('--resume'));
      f.processMock.pid = process.pid; f.processMock.argv = ['node', ...args]; f.run();
      return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
    } } : require(name.startsWith('.') ? path.resolve(__dirname, '../scripts/agents', name) : name),
    process: sendProcess, __filename: path.resolve(__dirname, '../scripts/agents/broker.js'), console: { error() {} }, Buffer });
    await settle(); assert(spawned);
    if (agent === 'codex') {
      const resume = f.requests.find(r => r.method === 'thread/resume'); assert.equal(resume.params.threadId, 'thread-saved');
      assert.equal(resume.params.model, 'saved-model'); assert.equal(resume.params.approvalPolicy, 'on-request');
      assert.equal(resume.params.approvalsReviewer, 'user');
      assert.equal(resume.params.sandbox, 'read-only'); assert.equal(resume.params.config.web_search, 'live');
      const turns = f.requests.filter(r => r.method === 'turn/start'); assert.equal(turns.length, 1);
      assert.equal(turns[0].params.input[0].text, 'new message'); assert.equal(turns[0].params.effort, 'high');
      assert.deepEqual(turns[0].params.collaborationMode, { mode: 'plan', settings: { model: 'saved-model', reasoning_effort: 'high', developer_instructions: null } });
      assert.equal(f.state().launch.mode, 'plan');
      assert(!f.requests.some(r => r.method === 'turn/steer' || r.method === 'thread/start'));
      f.children[0].child.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'resumed result' } } });
      f.children[0].child.send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    } else {
      f.timers.at(-1)(); await settle();
      assert.equal(f.children.length, 1);
      assert.deepEqual(Array.from(f.children[0].args), ['-m', 'saved-model', '-S', 'session_saved', '-p', 'new message']);
      f.children[0].child.stdout.write('resumed result'); f.children[0].child.emit('exit', 0);
    }
    assert.equal(await exited, 0); assert.equal(output, 'resumed result'); assert.equal(f.state().turns, 5);
    assert.equal(f.state().launch.idleMin, 3);
    assert(meshEvents(f).some(e => e.type === 'request.resolved' && e.requestId === stale.requestId));
  }
});

test('owner death exits a running broker and SessionEnd exits both running agents', async t => {
  const { hook } = require('../scripts/agents/mesh-hook');
  for (const agent of ['codex', 'kimi']) for (const end of ['owner', 'SessionEnd']) {
    const f = fixture(t, agent), input = { cwd: f.root, session_id: 'owner-session', hook_event_name: 'SessionEnd' };
    const dir = require('../scripts/agents/mesh-hook').scratchpad(input, f.root);
    fs.mkdirSync(dir, { recursive: true });
    const stateArg = f.processMock.argv.indexOf('--state') + 1; f.processMock.argv[stateArg] = dir;
    const file = path.join(dir, 'worker.state.json');
    const originalRequire = f.context.require;
    f.context.require = name => name === 'node:os' ? { tmpdir: () => f.root }
      : name === '../../src/sync/process-cache' ? { identity: async () => end === 'owner' ? '999999999:created' : null } : originalRequire(name);
    f.run(); await settle();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.owner, 'owner-session');
    assert.equal(saved.ownerPid, end === 'owner' ? 999999999 : undefined);
    if (end === 'SessionEnd') {
      const state = JSON.parse(fs.readFileSync(file, 'utf8')); state.pid = process.pid; fs.writeFileSync(file, JSON.stringify(state));
      assert.equal(await hook(input, { env: {}, tmp: f.root }), 0);
      f.intervals[0]();
    } else f.intervals.at(-1)();
    await settle(); assert.deepEqual(f.exits, [0]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'done');
  }
});
