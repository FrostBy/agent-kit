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
  const processMock = { env: {}, pid: 123, cwd: () => root, argv: ['node', 'broker.js', '--agent', agent, '--name', 'worker', '--state', root, '--prompt', prompt], exit: code => { throw Error(`exit ${code}`); } };
  const children = [], requests = [], intervals = [], timers = [];
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
      queueMicrotask(() => send({ id: msg.id, result }));
    } };
    function send(msg) {
      const b = Buffer.from(JSON.stringify(msg));
      const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]);
      child.stdout.write(Buffer.concat([head, b]));
    }
    child.send = send; children.push({ command, args, options, child }); return child;
  }
  const context = { require: name => name === 'node:child_process' ? { spawn } : require(name), process: processMock,
    console, Buffer, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} };
  const run = () => vm.runInNewContext(source, context, { filename: 'broker.js' });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'worker.state.json'), 'utf8'));
  return { root, run, state, processMock, children, requests, intervals, timers };
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
