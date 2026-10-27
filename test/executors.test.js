'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codex = require('../src/sources/codex');
const kimi = require('../src/sources/kimi');
const { render } = require('../src/render');
const { DEFAULTS } = require('../src/config');
const { deepMerge } = require('../src/util');

test('external executors: local fixtures, usage, context, quotas, filtering and lazy loading', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'executors-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'work'), now = Date.now();
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const rows = (values) => values.map((v) => JSON.stringify({ timestamp: new Date(now).toISOString(), ...v })).join('\n') + '\n';
  const cfile = path.join(home, 'sessions', 'rollout-1.jsonl');
  write(cfile, rows([
    { type: 'session_meta', payload: { cwd: root, originator: 'codex_exec', source: 'exec' } },
    { type: 'turn_context', payload: { model: 'sol', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 1000, last_token_usage: { total_tokens: 250 }, total_token_usage: { input_tokens: 2000, output_tokens: 100 } }, rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_at: now / 1000 + 3600 }, secondary: { used_percent: 30, window_minutes: 10080 } } } },
  ]));
  const kdir = path.join(home, 'sessions', 'workspace', 'session_one');
  write(path.join(kdir, 'state.json'), JSON.stringify({ cwd: path.join(root, 'sub'), updatedAt: new Date(now).toISOString() }));
  const wire = path.join(kdir, 'agents', 'main', 'wire.jsonl');
  write(wire, rows([
    { type: 'profile.bind', modelAlias: 'kimi-code/kimi-for-coding', thinkingEffort: 'high' },
    { type: 'usage.record', usage: { inputOther: 1000, output: 100, inputCacheRead: 200, inputCacheCreation: 300 } },
    { type: 'usage.record', usage: { inputOther: 700, output: 100 } },
    { type: 'token_counting.measured', tokens: 500 },
    { type: 'turn.ended', reason: 'failed', error: { code: 'provider.api_error', name: 'APIProviderQuotaExhaustedError', message: '5-hour quota exhausted', details: { statusCode: 429 } }, time: now - 1000 },
  ]));
  write(path.join(home, 'config.toml'), '[models."kimi-code/kimi-for-coding"]\nmax_context_size = 2_000 # window\ndisplay_name = "K2.8 Preview"\n');
  const sources = { codex: (accepts) => codex.load(root, now, home, accepts), kimi: (accepts) => kimi.load(root, now, home, accepts) };
  const cfg = (over = {}) => deepMerge(DEFAULTS, { color: false, links: false, lines: [['codex', '|', 'kimi']], ...over });
  const input = { workspace: { project_dir: root, current_dir: home } };
  const out = (await render(input, cfg(), now, sources)).join('\n');
  assert.match(out, /codex sol high   ctx ▰▱▱▱▱ 25% 250\/1k   5h ▰▱▱▱▱ 20% ↻ 1h00m   7d ▰▰▱▱▱ 30%/);
  assert.match(out, /kimi K2\.8 Preview high   ctx ▰▱▱▱▱ 25% 500\/2k   limit/);
  assert.doesNotMatch(out, /in |out |cache /);
  assert.deepEqual(kimi.load(root, now, home).input.context_window, { context_window_size: 2000, used_tokens: 500, used_percentage: 25 });
  assert.equal(kimi.load(root, now, home).input.token_usage.input_tokens, 1700);
  const withTokens = (await render(input, cfg({ separator: ' | ', widgets: { codex: { tokens: true }, kimi: { tokens: true } } }), now, sources)).join('\n');
  assert.ok(withTokens.includes('codex sol high | ctx ▰▱▱▱▱ 25% 250/1k | in 2k out 100 cache 0 | 5h'));
  assert.ok(withTokens.includes('kimi K2.8 Preview high | ctx ▰▱▱▱▱ 25% 500/2k | in 2k out 200 cache 200 | limit'));
  for (const id of ['codex', 'kimi']) {
    assert.deepEqual(await render(input, cfg({ lines: [[{ id, exclude: home }]] }), now, { [id]: () => assert.fail('excluded source loaded') }), []);
    assert.deepEqual(await render(input, cfg({ lines: [[{ id, exclude: home + ';other' }]] }), now, sources), []);
    assert.deepEqual(await render(input, cfg({ lines: [[id]], widgets: { [id]: { maxAge: 1 } } }), now + 120000, sources), []);
    assert.deepEqual(await render(input, cfg({ lines: [[id]] }), now, { [id]: () => null }), []);
  }
  assert.deepEqual(await render({}, cfg({ lines: [] }), now, { codex: () => assert.fail('unused'), kimi: () => assert.fail('unused') }), []);
  assert.equal(kimi.load(root + '-other', now, home), null);
  assert.equal(kimi.load(root, now + 6 * 3600000, home).limited, false);
  assert.equal(codex.load(root + '-other', now, home), null);
  const originalRead = fs.readSync;
  fs.readSync = () => assert.fail('filtered or unchanged log read');
  try {
    assert.equal(codex.load(root, now, home, () => false), null);
    assert.equal(kimi.load(root, now, home, () => false), null);
    assert.ok(codex.load(root, now, home));
    assert.ok(kimi.load(root, now, home));
  } finally { fs.readSync = originalRead; }
  fs.appendFileSync(cfile, rows([{ type: 'turn_context', payload: { model: 'updated' } }]));
  assert.equal(codex.load(root, now, home).input.model.display_name, 'updated');
  fs.appendFileSync(wire, rows([{ type: 'usage.record', usage: { output: 10 } }]));
  assert.equal(kimi.load(root, now, home).input.token_usage.output_tokens, 210);
  assert.deepEqual(await render({ ...input, harness: 'codex' }, cfg(), now, { codex: () => assert.fail('Codex inspector'), kimi: () => assert.fail('Codex inspector') }), []);
  fs.appendFileSync(wire, '{broken}\nnull\n');
  assert.equal(kimi.load(root, now, home).input.token_usage.output_tokens, 210);
  fs.truncateSync(wire, 16 * 1024 * 1024 + 1);
  assert.equal(kimi.load(root, now, home).input.token_usage.output_tokens, 210);
});

test('codex: model display name from models_cache.json, slug as fallback', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'work'), now = Date.now();
  const file = path.join(home, 'sessions', 'rollout-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { cwd: root, source: 'exec' } },
    { type: 'turn_context', timestamp: new Date(now).toISOString(), payload: { model: 'gpt-sol' } },
  ].map((v) => JSON.stringify(v)).join('\n') + '\n');
  assert.equal(codex.load(root, now, home).input.model.display_name, 'gpt-sol');
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-sol', display_name: 'Sol Pro' }, { slug: 'other', display_name: 'Other' }] }));
  assert.equal(codex.load(root, now, home).input.model.display_name, 'Sol Pro');
});

test('broker executors: session IDs, running priority, shared quotas and exec fallback', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-executors-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'work'), scratchpad = path.join(home, 'scratchpad'), now = Date.now();
  const write = (file, value, age = 0) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    fs.utimesSync(file, (now - age) / 1000, (now - age) / 1000);
    return file;
  };
  const state = (name, agent, status, id, age = 0) => write(path.join(scratchpad, `${name}.state.json`),
    JSON.stringify({ agent, status, [agent === 'codex' ? 'threadId' : 'sessionId']: id, model: 'state-model' }), age);
  const rollout = (id, source, model, extra = {}) => write(path.join(home, 'sessions', `rollout-${id}.jsonl`), [
    { type: 'session_meta', payload: { cwd: root, source, originator: source === 'exec' ? 'codex_exec' : 'codex-tui', ...extra } },
    { type: 'turn_context', payload: { model, effort: 'high' } },
    { type: 'event_msg', timestamp: new Date(now - (id === 'thread-first' ? 2000 : 1000)).toISOString(), payload: { type: 'token_count', info: { model_context_window: 1000, last_token_usage: { total_tokens: 250 }, total_token_usage: { input_tokens: 2000 } }, rate_limits: { secondary: { used_percent: 30, window_minutes: 10080 } } } },
  ].map((v) => JSON.stringify(v)).join('\n') + '\n', 3 * 3600000);
  const first = rollout('thread-first', 'vscode', 'Sol', { cwd: home + '-elsewhere' });
  rollout('thread-second', 'vscode', 'Luna');
  state('dry2', 'codex', 'running', 'thread-first', 2000);
  state('slice', 'codex', 'idle', 'thread-second', 1000);
  state('booting', 'codex', 'starting', undefined);
  write(path.join(scratchpad, 'broken.state.json'), '{broken');
  const input = { workspace: { project_dir: root }, scratchpad_dir: scratchpad };
  const cfg = (over = {}) => deepMerge(DEFAULTS, { color: false, links: false, lines: [['codex'], ['kimi']], ...over });
  const sources = {
    codex: (accepts) => codex.load(root, now, home, accepts, scratchpad),
    kimi: (accepts) => kimi.load(root, now, home, accepts, scratchpad),
  };
  const output = async (over) => (await render(input, cfg(over), now, sources)).join('\n');
  let out = await output();
  assert.match(out, /^codex slice Luna high.* · dry2 Sol high/);
  assert.doesNotMatch(out, /booting/);
  assert.match(out, /ctx .*25%.*7d/);
  state('slice', 'codex', 'running', 'thread-second', 1000);
  out = await output({ widgets: { codex: { tokens: true } } });
  assert.match(out, /^codex slice Luna high.* · dry2 Sol high/);
  assert.equal((out.match(/7d/g) || []).length, 1);
  assert.match(out, /in 2k out 0 cache 0/);
  assert.ok(out.indexOf('7d') > out.indexOf('dry2'));
  const originalRead = fs.readSync;
  fs.readSync = () => assert.fail('unchanged broker rollout read');
  try { assert.equal(codex.load(root, now, home, () => true, scratchpad).agents.length, 2); }
  finally { fs.readSync = originalRead; }
  fs.appendFileSync(first, JSON.stringify({ type: 'turn_context', payload: { model: 'Updated' } }) + '\n');
  fs.utimesSync(first, (now - 3 * 3600000) / 1000, (now - 3 * 3600000) / 1000);
  assert.match(await output(), /dry2 Updated/);
  assert.equal(codex.load(root, now + 120000, home, (at) => now + 120000 - at <= 60000, scratchpad), null);
  assert.equal(await output({ widgets: { codex: { exclude: root } } }), '');
  const extras = ['third', 'fourth'].map((name) => state(name, 'codex', 'running', 'thread-first'));
  assert.equal(codex.load(root, now, home, () => true, scratchpad).agents.length, 3);
  for (const file of extras) fs.rmSync(file);
  state('dry2', 'codex', 'idle', 'thread-first', 2000);
  state('slice', 'codex', 'idle', 'thread-second', 1000);
  assert.match(await output(), /^codex slice Luna.*dry2/);
  state('dry2', 'codex', 'starting', 'thread-first', 2000);
  assert.match(await output(), /dry2 Updated/);
  state('dry2', 'codex', 'done', 'thread-first');
  state('slice', 'codex', 'error', 'thread-second');
  const exec = rollout('aaa-exec', 'exec', 'Exec');
  fs.utimesSync(exec, now / 1000, now / 1000);
  rollout('zzz-vscode', 'vscode', 'Wrong');
  rollout('zzzz-child', 'exec', 'Child', { parent_thread_id: 'parent' });
  rollout('zzzzz-subagent', { subagent: 'parent' }, 'Subagent');
  assert.match(await output(), /^codex Exec high/);
  assert.doesNotMatch(await output(), /dry2|slice|Wrong|Child|Subagent/);
  assert.equal(codex.load(root, now, home, () => true, path.join(home, 'missing')).input.model.display_name, 'Exec');
  assert.equal(codex.findSession({ home, root, threadId: '' }).endsWith('rollout-zzz-vscode.jsonl'), true);
  fs.rmSync(exec);
  assert.equal(codex.load(root, now, home, () => true, scratchpad), null);
  assert.equal(codex.load(root, now, home, () => true, path.join(home, 'missing')), null);

  const sessionId = 'session_12345678-1234-1234-1234-123456789abc';
  const dir = path.join(home, 'sessions', 'kimi-workspace', sessionId);
  write(path.join(dir, 'state.json'), JSON.stringify({ cwd: home + '-elsewhere', updatedAt: now - 3 * 3600000 }));
  write(path.join(dir, 'agents', 'main', 'wire.jsonl'), [
    { type: 'profile.bind', modelAlias: 'kimi-code/K2.8', thinkingEffort: 'medium' },
    { type: 'token_counting.measured', tokens: 500, time: now },
  ].map((v) => JSON.stringify(v)).join('\n') + '\n');
  state('moon', 'kimi', 'running', sessionId);
  assert.equal(await output(), 'kimi moon K2.8 medium');
  assert.equal(await output({ widgets: { kimi: { exclude: root } } }), '');
  assert.equal(kimi.load(root, now + 120000, home, (at) => now + 120000 - at <= 60000, scratchpad), null);
  state('moon', 'kimi', 'done', sessionId);
  assert.equal(await output(), '');
});

test('broker freshness follows turn events, including incremental updates and fallback', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-freshness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now(), root = path.join(home, 'work'), scratchpad = path.join(home, 'scratchpad');
  const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); };
  const state = (name, agent, id) => write(path.join(scratchpad, `${name}.state.json`), [{ agent, status: 'running', [agent === 'codex' ? 'threadId' : 'sessionId']: id }]);
  const event = (type, age) => ({ type: 'event_msg', timestamp: new Date(now - age * 60000).toISOString(), payload: { type } });
  const file = path.join(home, 'sessions', 'rollout-thread.jsonl');
  write(file, [{ type: 'session_meta', payload: { cwd: root, source: 'vscode' } }, event('task_complete', 30)]);
  state('old', 'codex', 'thread');
  const input = { workspace: { project_dir: root }, scratchpad_dir: scratchpad };
  const config = deepMerge(DEFAULTS, { color: false, lines: [['codex'], ['kimi']] });
  const sources = { codex: (accepts) => codex.load(root, now, home, accepts, scratchpad), kimi: (accepts) => kimi.load(root, now, home, accepts, scratchpad) };
  const output = async () => (await render(input, config, now, sources)).join('\n');
  assert.equal(await output(), '');
  fs.appendFileSync(file, JSON.stringify(event('task_started', 1)) + '\n');
  assert.match(await output(), /codex old/);
  fs.appendFileSync(file, JSON.stringify(event('task_complete', 2)) + '\n');
  assert.match(await output(), /codex old/);
  const active = path.join(home, 'sessions', 'rollout-active.jsonl');
  write(active, [{ type: 'session_meta', payload: { cwd: root, source: 'vscode' } }, event('task_started', 3)]);
  state('active', 'codex', 'active');
  assert.match(await output(), /codex active/);
  assert.doesNotMatch(await output(), /old/);
  fs.appendFileSync(file, JSON.stringify(event('agent_message', 1)) + '\n');
  assert.match(await output(), /old.*active/);
  fs.rmSync(path.join(scratchpad, 'active.state.json'));
  fs.appendFileSync(file, JSON.stringify(event('turn_aborted', 30)) + '\n');
  assert.equal(await output(), '');
  const wire = path.join(home, 'sessions', 'workspace', 'session_kimi', 'agents', 'main', 'wire.jsonl');
  write(wire, [{ type: 'turn.ended', time: now - 30 * 60000 }]);
  state('moon', 'kimi', 'session_kimi');
  assert.equal(await output(), '');
  fs.appendFileSync(wire, JSON.stringify({ type: 'turn.prompt', time: now }) + '\n');
  assert.match(await output(), /kimi moon/);
});

test('Kimi quota flags use the error message and expire from the event time', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-limit-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now(), root = path.join(home, 'work');
  const dir = path.join(home, 'sessions', 'workspace', 'session_one');
  const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(wire), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ cwd: root, updatedAt: now }));
  const cfg = deepMerge(DEFAULTS, { color: false, links: false, lines: [['kimi']] });
  for (const [message, label, hours] of [
    ['5-hour quota exhausted', 'limit 5h', 5],
    ['Monthly quota exhausted; resets 2026-11-01T00:00:00Z', 'limit month', 720],
    ['Quota exhausted', 'limit', 720],
  ]) {
    fs.appendFileSync(wire, JSON.stringify({ type: 'turn.ended', time: now, error: { name: 'APIProviderQuotaExhaustedError', message, details: { statusCode: 429 } }, prompt: '5-hour month' }) + '\n');
    const source = kimi.load(root, now, home);
    const output = await render({ workspace: { project_dir: root } }, cfg, now, { kimi: () => source });
    assert.equal(output.join('\n'), `kimi ${label}`);
    assert.equal(kimi.load(root, now + hours * 3600000 - 1, home).limited, true);
    assert.equal(kimi.load(root, now + hours * 3600000 + 1, home).limited, false);
  }
});

test('persistent log cache skips unchanged bytes, appends complete UTF-8 rows and resets on truncation', (t) => {
  const cache = require('../src/cache');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'log-cache-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'log.jsonl');
  const parse = (text, state) => ({ text: state.text + text + '\n' });
  const load = () => cache.incremental(file, () => ({ text: '' }), parse);
  fs.writeFileSync(file, 'first\n');
  assert.equal(load().text, 'first\n');
  const original = fs.readSync;
  fs.readSync = () => assert.fail('unchanged log read');
  try { assert.equal(load().text, 'first\n'); } finally { fs.readSync = original; }
  const bytes = Buffer.from('привет\n');
  fs.appendFileSync(file, bytes.subarray(0, 3));
  assert.equal(load().text, 'first\n');
  fs.appendFileSync(file, bytes.subarray(3));
  assert.equal(load().text, 'first\nпривет\n');
  fs.writeFileSync(file, 'new\n');
  assert.equal(load().text, 'new\n');
});
