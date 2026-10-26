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
  const rows = (values) => values.map((v) => JSON.stringify(v)).join('\n') + '\n';
  const cfile = path.join(home, 'sessions', 'rollout-1.jsonl');
  write(cfile, rows([
    { type: 'session_meta', payload: { cwd: root, originator: 'codex_exec' } },
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
