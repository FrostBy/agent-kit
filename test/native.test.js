'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderNative } = require('../src/native');
const { DEFAULTS, CODEX_DEFAULTS } = require('../src/config');
const { render } = require('../src/render');
const { deepMerge } = require('../src/util');

const root = path.resolve('/umbrella');
const snapshot = () => ({
  schema_version: 1, cwd: path.join(root, 'repo0'), project_dir: root,
  model: { id: 'gpt-6.1-sol', display_name: 'GPT-6.1' }, effort: { level: 'high' },
  context_window: { used_percentage: 47, used_tokens: 223563, context_window_size: 475000, total_input_tokens: 11063897, total_output_tokens: 45888, cached_input_tokens: 9000000, reasoning_output_tokens: 12000 },
  rate_limits: [{ id: 'codex', primary: { used_percentage: 3, window_minutes: 10080 } }],
  runtime: { state: 'working' },
  activity: { tool: { name: 'read_file', detail: 'render.js' }, todos: { done: 3, total: 7 }, agents: 2 },
  pr: { number: 128, url: 'https://github.com/example/project/pull/128' },
  rows: 24,
});
const cfg = (over = {}) => deepMerge(CODEX_DEFAULTS, { color: false, links: false, ...over });
const forbidden = () => { throw new Error('Claude sources must not run'); };
const umbrella = (count) => ({ mode: 'umbrella', root, repos: Array.from({ length: count }, (_, i) => ({ dir: path.join(root, `repo${i}`), branch: 'main', changed: 3, deleted: 2, staged: 1, untracked: 3, add: 4, del: 5 })) });

test('native mode renders once at the end with a spacer and separately colored hint', async () => {
  const labels = {
    default: 'default mode (shift+tab to cycle)',
    auto: '⏵⏵ auto mode on (shift+tab to cycle)',
    plan: '⏸\uFE0E plan mode on (shift+tab to cycle)',
    'read-only': 'read-only mode',
  };
  for (const lang of ['en', 'ru']) {
    for (const mode of [undefined, 'default', 'auto', 'plan', 'read-only', 'invalid']) {
      const input = { ...snapshot(), mode };
      const rows = await renderNative(input, cfg({ lang, lines: [['mode', 'model', { id: 'mode' }], ['mode']] }), 0, { git: () => null });
      assert.deepEqual(rows, labels[mode] ? ['GPT-6.1', '\u2800', labels[mode], '\u2800'] : ['GPT-6.1', '\u2800']);
    }
  }
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    for (const [mode, color] of [['auto', 33], ['plan', 36]]) {
      const rows = await renderNative({ ...snapshot(), mode }, cfg({ color: true, gapAfter: false }), 0, { git: () => null });
      const label = labels[mode].replace(' (shift+tab to cycle)', '');
      assert.equal(rows.at(-1), `\x1b[${color}m${label}\x1b[0m\x1b[90m (shift+tab to cycle)\x1b[0m`);
      assert.equal(rows.at(-2), '\u2800');
    }
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('native snapshot keeps the original rows and omits invented counters', async () => {
  let scanned;
  const rows = await renderNative(snapshot(), cfg({ lines: [...CODEX_DEFAULTS.lines, ['codex', 'kimi']] }), 0, {
    git: (cwd) => { scanned = cwd; return null; }, usage: forbidden, today: forbidden, plan: forbidden, transcript: forbidden, codex: forbidden, kimi: forbidden,
  });
  const out = rows.join('\n');
  assert.equal(scanned, root);
  assert.match(rows[0], /GPT-6.1 high.*ctx .*47%.*read_file render.js.*3\/7.*agents 2/);
  assert.match(rows[1], /^7d .*3%/);
  assert.equal(rows[2], '#128');
  assert.equal(rows[3], '\u2800');
  assert.equal(rows.length, 4);
  assert.match(out, /224k\/475k/);
  assert.doesNotMatch(out, /quota used|session tokens|\b[MDS]\d|Ready|working|500k|1M\//);
});

test('native footer matches the Claude renderer for the same available data', async () => {
  const input = snapshot(), git = () => umbrella(2);
  const actual = await renderNative(input, cfg({ maxLines: 16 }), 0, { git });
  const expected = await render({
    model: input.model, effort: input.effort, pr: input.pr,
    workspace: { project_dir: root, current_dir: input.cwd },
    context_window: { used_percentage: 47, context_window_size: 475000, current_usage: { input_tokens: 223563 } },
    rate_limits: { seven_day: { used_percentage: 3 } },
  }, deepMerge(DEFAULTS, { color: false, links: false }), 0, {
    git, usage: () => null, today: () => null, plan: () => null, transcript: () => input.activity,
  });
  expected.push('\u2800');
  assert.deepEqual(actual, expected);
});

test('native footer preserves whole-umbrella totals when repositories exceed row budget', async () => {
  const input = snapshot();
  for (const height of [24, 16]) {
    input.rows = height;
    const rows = await renderNative(input, cfg({ maxLines: 16 }), 0, { git: () => umbrella(12) });
    assert.ok(rows.length <= height - 8, rows.join('\n'));
    assert.match(rows.at(-2), /more.*Σ \+48 −60/);
    assert.equal(rows.at(-1), '\u2800');
    assert.doesNotMatch(rows.join('\n'), /\b[MDS]\d/);
    assert.equal(rows.filter((line) => /repo\d+\s/.test(line)).length, height === 24 ? 4 : 3);
  }
});

test('native footer caps the final rows and adds a gap only when it fits', async () => {
  const input = snapshot();
  input.rows = 10;
  const small = await renderNative(input, cfg(), 0, { git: () => umbrella(12) });
  assert.equal(small.length, 2);
  assert.notEqual(small.at(-1), '\u2800');
  input.rows = 100;
  const long = await renderNative(input, cfg({ maxLines: 32, lines: Array.from({ length: 40 }, () => ['model']) }), 0, { git: () => null });
  assert.equal(long.length, 32);
  assert.notEqual(long.at(-1), '\u2800');
  const short = await renderNative(input, cfg({ lines: [['model']] }), 0, { git: () => null });
  assert.deepEqual(short, ['GPT-6.1', '\u2800']);
});

test('native content limit excludes mode, spacer and gap and respects terminal height', async () => {
  const lines = Array.from({ length: 40 }, () => ['model']);
  for (const mode of ['auto', 'plan', 'default']) {
    const input = { ...snapshot(), mode };
    const suffix = mode === 'default' ? ['\u2800', 'default mode (shift+tab to cycle)'] : ['\u2800', `${mode === 'auto' ? '⏵⏵' : '⏸\uFE0E'} ${mode} mode on (shift+tab to cycle)`];
    const render = (options = {}) => renderNative(input, cfg({ lines, ...options }), 0, { git: () => null });
    assert.deepEqual(await render(), [...Array(4).fill('GPT-6.1'), ...suffix, '\u2800']);
    assert.deepEqual(await render({ maxLines: 6, gapAfter: false }), [...Array(6).fill('GPT-6.1'), ...suffix]);
    for (const maxLines of [null, '6', 0, -1, 2.9]) {
      const count = typeof maxLines === 'number' ? Math.max(1, Math.floor(maxLines)) : 4;
      assert.deepEqual(await render({ maxLines }), [...Array(count).fill('GPT-6.1'), ...suffix, '\u2800']);
    }
    input.rows = 12;
    assert.deepEqual(await render(), [...Array(4 - suffix.length).fill('GPT-6.1'), ...suffix]);
    input.rows = 100;
    assert.equal((await render({ maxLines: 100 })).length, 32);
  }
});

test('unknown context and idle runtime do not create fake indicators', async () => {
  const input = snapshot();
  input.context_window = null;
  input.activity = null;
  input.rate_limits = [];
  input.pr = null;
  input.runtime = { state: 'Ready' };
  assert.deepEqual(await renderNative(input, cfg(), 0, { git: () => null }), ['GPT-6.1 high', '\u2800']);
});

test('native footer retains model, threshold and Git colors', async () => {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const out = (await renderNative(snapshot(), cfg({ color: true }), 0, { git: () => umbrella(2) })).join('\n');
    for (const code of [36, 32, 35, 34]) assert.ok(out.includes(`\x1b[${code}m`), `missing ANSI ${code}`);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('missing exact context usage never fabricates a token count from rounded percentage', async () => {
  const input = snapshot();
  delete input.context_window.used_tokens;
  const out = (await renderNative(input, cfg(), 0, { git: () => null })).join('\n');
  assert.match(out, /47%/);
  assert.doesNotMatch(out, /223k\/|224k\//);
  await assert.rejects(renderNative({ schema_version: 2 }, cfg()), /schema_version=1/);
});

test('agent attention is localized, stays inline when it fits and omits zero counters', async () => {
  const input = snapshot();
  input.columns = 200;
  const baseline = await renderNative(input, cfg(), 0, { git: () => null });
  for (const [status, ru, en] of [
    ['waiting_approval', 'reviewer ждёт подтверждения', 'reviewer awaits approval'],
    ['waiting_input', 'reviewer ждёт ответа', 'reviewer awaits reply'],
    ['failed', 'reviewer ошибка', 'reviewer failed'],
  ]) {
    input.activity.agents = status === 'failed' ? 0 : 3;
    input.activity.agent_attention = [{ name: 'reviewer', status }];
    for (const [lang, label] of [['ru', ru], ['en', en]]) {
      const rows = await renderNative(input, cfg({ lang }), 0, { git: () => null });
      assert.equal(rows.length, baseline.length);
      assert.ok(rows[0].includes(label), rows[0]);
      assert.doesNotMatch(rows.join('\n'), /agents 0/);
    }
  }
  input.activity = { ...snapshot().activity, agent_attention: [null, { name: 'reviewer', status: 'running' }] };
  assert.deepEqual(await renderNative(input, cfg(), 0, { git: () => null }), baseline);
});

test('narrow footer moves attention to one temporary row and retains Git totals', async () => {
  const input = snapshot();
  input.columns = 80;
  input.rows = 16;
  input.activity.agent_attention = [{ name: 'reviewer', status: 'waiting_approval' }];
  const rows = await renderNative(input, cfg({ lang: 'ru', maxLines: 16 }), 0, { git: () => umbrella(12) });
  assert.ok(rows.length <= 8);
  assert.equal(rows[1], 'reviewer ждёт подтверждения');
  assert.match(rows.at(-2), /Σ \+48 −60/);
  input.activity.agent_attention = [];
  const healthy = await renderNative(input, cfg(), 0, { git: () => null });
  assert.match(healthy[1], /^7d/);
});

test('attention uses severity colors and summarizes additional agents', async () => {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const input = snapshot();
    input.columns = 200;
    input.activity.agent_attention = [{ name: 'reviewer', status: 'failed' }, { name: 'builder', status: 'waiting_input' }];
    let out = (await renderNative(input, cfg({ color: true, lang: 'en' }), 0, { git: () => null })).join('\n');
    assert.ok(out.includes('\x1b[31mreviewer failed (+1)\x1b[0m'), out);
    assert.doesNotMatch(out, /builder/);
    input.activity.agent_attention = [{ name: 'reviewer', status: 'waiting_approval' }];
    out = (await renderNative(input, cfg({ color: true, lang: 'en' }), 0, { git: () => null })).join('\n');
    assert.ok(out.includes('\x1b[33mreviewer awaits approval\x1b[0m'), out);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('native CLI entry accepts JSON and rejects malformed input', () => {
  const env = { ...process.env, AGENT_STATUSLINE_CONFIG: path.join(__dirname, 'absent-native-config.json') };
  const input = snapshot();
  input.cwd = __dirname;
  input.project_dir = __dirname;
  const run = (data) => spawnSync(process.execPath, [path.join(__dirname, '..', 'statusline.js'), '--codex-native'], { input: data, encoding: 'utf8', env, timeout: 5000 });
  const result = run(JSON.stringify(input));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GPT-6.1/);
  assert.doesNotMatch(result.stdout, /DEMO|agent-statusline · Codex/);
  assert.notEqual(run('{broken').status, 0);
});

test('native exec detail keeps the executable and argument prefix instead of its path', async () => {
  for (const [command, expected] of [
    [String.raw`"C:\\Users\\frost\\AppData\\Local\\Microsoft\\WindowsApps\\powershell.exe" Get-ChildItem -Recurse -Force -Hidden`, 'powershell.exe Get-ChildItem -Recurse -\u2026'],
    ['/usr/bin/node --test', 'node --test'],
    [`'/opt/my tools/node' --test`, 'node --test'],
    ['npm test', 'npm test'],
  ]) {
    const input = snapshot();
    input.activity.tool = { name: 'exec', detail: command };
    const rows = await renderNative(input, cfg({ lines: [['activity']], gapAfter: false }), 0, { git: () => null });
    assert.equal(rows[0], '\u2699  exec ' + expected);
  }
});
