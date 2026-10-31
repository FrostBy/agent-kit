'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { eventWriter, nextEvent } = require('../src/agents/mesh');
const delay = ms => new Promise(r => setTimeout(r, ms));

test('send/wait ACK only the returned completion; /exit ACKs its own exit even without a new turn', async t => {
  for (const mode of ['send', 'wait', 'exit']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-delivery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const base = path.join(root, 'worker'); fs.mkdirSync(`${base}.inbox`);
    const emit = eventWriter(base, 'worker');
    const earlier = emit('question', {}, { requestId: 'unanswered' });
    const state = { agent: 'codex', status: 'running', turns: 1, pid: process.pid };
    fs.writeFileSync(`${base}.state.json`, JSON.stringify(state)); fs.writeFileSync(`${base}.out.md`, 'result');
    const preload = path.join(root, 'ready.js');
    fs.writeFileSync(preload, `const fs = require('node:fs'); const read = fs.readFileSync; let sent = false;
      fs.readFileSync = function(file, ...args) { const result = read.call(this, file, ...args);
        if (!sent && String(file).endsWith('worker.state.json')) { sent = true; process.send('ready'); } return result; };`);
    const child = spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../scripts/agents/broker.js'), mode === 'wait' ? 'wait' : 'send', '--name', 'worker', '--state', root,
      ...(mode === 'wait' ? [] : ['--text', mode === 'exit' ? '/exit' : 'hello']), '--timeout-min', '0.03'], { env: { ...process.env, BROKER_POLL_MS: '10' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => child.kill());
    let stderr = '', out = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.on('data', b => { out += b; });
    const exited = new Promise(r => child.on('exit', r));
    if (mode === 'wait') await new Promise(r => child.once('message', r));
    else {
      for (let i = 0; i < 200 && !fs.readdirSync(`${base}.inbox`).length; i++) await delay(10);
      assert(fs.readdirSync(`${base}.inbox`).length);
    }
    let completed;
    if (mode === 'exit') {
      completed = emit('turn.completed', { turnNumber: 2 });
      fs.writeFileSync(`${base}.state.json`, JSON.stringify({ ...state, status: 'idle', turns: 2, lastCompletionEvent: completed.id }));
      await delay(40); assert.equal(child.exitCode, null, '/exit must wait for agent.exited after interrupt completion');
    }
    const delivered = mode === 'exit' ? emit('agent.exited', { pid: process.pid, reason: 'exit', code: 0 }) : emit('turn.completed', { turnNumber: 2 });
    fs.writeFileSync(`${base}.state.json`, JSON.stringify({ ...state, status: mode === 'exit' ? 'done' : 'idle', turns: mode === 'exit' ? 1 : 2,
      ...(mode !== 'exit' ? { lastCompletionEvent: delivered.id } : { lastCompletionEvent: completed.id }) }));
    assert.equal(await exited, 0, stderr); assert.equal(out, 'result');
    const foreign = eventWriter(path.join(root, 'other'), 'other')('turn.completed', {});
    assert.equal((await nextEvent(root, { timeoutMin: 0.01, pollMs: 5 })).id, earlier.id);
    assert.equal((await nextEvent(root, { timeoutMin: 0.01, pollMs: 5 })).id, foreign.id);
    assert.equal(await nextEvent(root, { timeoutMin: 0.0002, pollMs: 5 }), null);
  }
});

test('delivery ACK reaches the parent scratchpad cursor while its hook waiter owns the lock', async t => {
  const { ackDelivered } = require('../src/agents/mesh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-nested-')), nested = path.join(root, 'agents'); fs.mkdirSync(nested);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const waiting = nextEvent(root, { timeoutMin: 0.002, pollMs: 20 });
  const event = eventWriter(path.join(nested, 'worker'), 'worker')('turn.completed', {});
  ackDelivered(nested, [event.id]);
  assert.equal(await waiting, null);
  assert(JSON.parse(fs.readFileSync(path.join(root, '.mesh-events.cursor.json'))).delivered.includes(event.id));
});
