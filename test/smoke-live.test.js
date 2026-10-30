'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { smoke } = require('../scripts/agents/smoke-live');

test('smoke has no model/SQL/process actions without the explicit --live option', async () => {
  const result = await smoke({ spawn: () => assert.fail('no child without --live'), readArchived: () => assert.fail('no SQL without --live'), log: () => {} });
  assert.equal(result.skipped, true);
});

test('smoke sends exact pong prompt, exits via inbox and checks both state and SQLite', async t => {
  for (const reply of ['pong', 'wrong reply']) {
    let timer, root, childHome, sqlReads = 0;
    const result = await smoke({ live: true, timeoutMs: 1000, pollMs: 1, closeMs: 1000, log: () => {},
      spawn(command, args, options) {
        childHome = options.env.CODEX_HOME; assert.equal(typeof childHome, 'string'); assert(childHome.length > 0);
        root = args[args.indexOf('--state') + 1];
        t.after(() => { clearInterval(timer); fs.rmSync(root, { recursive: true, force: true }); });
        const prompt = args[args.indexOf('--prompt') + 1]; assert.equal(fs.readFileSync(prompt, 'utf8'), 'Reply with exactly: pong');
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => assert.fail('normal smoke must exit via inbox');
        const stateFile = path.join(root, 'ping.state.json'), state = { threadId: 'thread-smoke', status: 'idle', turns: 1, archived: false, lastTurnStatus: 'completed' };
        fs.writeFileSync(stateFile, JSON.stringify(state)); fs.writeFileSync(path.join(root, 'ping.out.md'), reply);
        timer = setInterval(() => {
          const exit = path.join(root, 'ping.inbox', '999999-smoke-exit');
          if (!fs.existsSync(exit)) return;
          assert.equal(fs.readFileSync(exit, 'utf8'), '/exit'); clearInterval(timer);
          state.status = 'done'; state.archived = true; fs.writeFileSync(stateFile, JSON.stringify(state)); child.emit('exit', 0);
        }, 1);
        return child;
      },
      readArchived(home, id) { sqlReads++; assert.equal(home, childHome); assert.equal(id, 'thread-smoke'); assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'ping.state.json'))).archived, true); return 1; }
    });
    assert.equal(result.ok, reply === 'pong'); assert.equal(result.stateArchived, true); assert.equal(result.sqliteArchived, 1); assert.equal(sqlReads, 1);
  }
});
