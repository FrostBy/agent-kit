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
  const processMock = Object.assign(new EventEmitter(), { env: {}, pid: 123, cwd: () => root, argv: ['node', 'broker.js', '--agent', agent, '--name', 'worker', '--state', root, '--prompt', prompt], exit: code => { exits.push(code); } });
  const children = [], requests = [], intervals = [], timers = [], answers = {};
  function spawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = { write(bytes) {
      if (typeof bytes === 'string') { queueMicrotask(() => child.stdout.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')); return; }
      const buffer = Buffer.from(bytes), len = buffer[1] & 127;
      const offset = len < 126 ? 2 : len === 126 ? 4 : 10;
      const mask = buffer.subarray(offset, offset + 4), payload = buffer.subarray(offset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      const msg = JSON.parse(payload.toString()); requests.push(msg);
      if (msg.id === undefined) return;
      const result = msg.method === 'thread/start' ? { thread: { id: 'thread-fixture' }, model: 'fixture-model' } : msg.method === 'turn/start' ? { turn: { id: 'turn-fixture' } } : {};
      const response = answers[msg.method] ? answers[msg.method](msg) : { result };
      queueMicrotask(() => send({ id: msg.id, ...response }));
    } };
    function send(msg) {
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
  return { root, run, state, processMock, children, requests, intervals, timers, answers, exits, spawn };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Codex broker keeps state format and exclusion policy; turns, inbox steering and reconnect use the same thread', async t => {
  const f = fixture(t, 'codex'); f.run(); await settle();
  assert.equal(f.processMock.env.SESSION_SYNC_BROKER, '1');
  assert.equal(f.children[0].command, 'codex'); assert.deepEqual(Array.from(f.children[0].args), ['app-server', 'proxy']);
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
  assert.equal(fs.readFileSync(path.join(f.root, 'worker.out.md'), 'utf8'), 'fixture answer');
  child.emit('exit', 1); assert.equal(f.state().status, 'reconnecting');
  f.timers.at(-1)(); await settle();
  assert(f.requests.some(r => r.method === 'thread/resume' && r.params.threadId === 'thread-fixture'));
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
      f.intervals[0]();
    } else f.processMock.emit(mode === 'signal' ? 'SIGTERM' : 'beforeExit');
    // Exit paths are asynchronous; slower CI runners need more than one settle tick.
    let request;
    for (let i = 0; i < 100 && !(request = f.requests.find(r => r.method === 'thread/archive')); i++) await new Promise(r => setTimeout(r, 10));
    await settle();
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
  const options = { home: f.root, stateDirs: [f.root], log: () => {}, connect: args => connectProxy({ ...args, spawn: f.spawn }) };
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
