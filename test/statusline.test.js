'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const config = require('../src/config');
const { render, renderLines } = require('../src/render');
const { sample, sampleSources } = require('../src/sample');
const { parseStatus, parseNumstat } = require('../src/sources/git');
const transcript = require('../src/sources/transcript');
const today = require('../src/sources/today');
const { renderSubagents } = require('../src/subagent');
const { deepMerge } = require('../src/util');

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const plain = (over = {}) => deepMerge(config.DEFAULTS, { color: false, links: false, ...over });

const umbrella = (root) => ({
  mode: 'umbrella', root, repos: [
    { dir: path.join(root, 'api'), branch: 'feat/a-very-long-branch-name-for-testing', ahead: 1, behind: 0, changed: 2, untracked: 1, conflicts: 0, add: 10, del: 3, stash: 0 },
    { dir: path.join(root, 'web'), branch: 'main', ahead: 0, behind: 0, changed: 1, untracked: 0, conflicts: 0, add: 5, del: 0, stash: 0 },
    { dir: path.join(root, 'infra'), branch: 'main', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0, add: 0, del: 0, stash: 0 },
  ],
});

test('full render: headline blocks present, money hidden on a subscription', async () => {
  const cwd = path.resolve('/tmp/proj');
  const src = { ...sampleSources(NOW), git: () => umbrella(cwd) };
  const all = (await render(sample(NOW, cwd), plain(), NOW, src)).join('\n');
  for (const s of ['Fable 5.1', 'high', 'ctx', '42%', '84k/200k', '63%', '41%', 'Fable 18%', '#128', 'approved', '⚙  Edit render.js', '📋 3/7', 'agents 2', 'web  ⎇ main']) assert.ok(all.includes(s), `missing "${s}":\n${all}`);
  assert.doesNotMatch(all, /\$/);
  const api = (await render(sample(NOW, cwd), plain(), NOW, { ...src, plan: () => ({ label: 'API', api: true }) })).join('\n');
  for (const s of ['$4.37 session', '$23.80 today']) assert.ok(api.includes(s), `missing "${s}":\n${api}`);
});

test('umbrella: counts dirty repos, sums lines, truncates branches', async () => {
  const cwd = path.resolve('/tmp/proj');
  const cfg = plain({ lines: [['git']] });
  const rows = await render({ workspace: { current_dir: cwd } }, cfg, NOW, { git: () => umbrella(cwd) });
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^api\s+⎇ feat\/a-very-long-branch…/);
  assert.match(rows[1], /^web\s+⎇ main/);
  assert.equal(rows[2], 'Σ +15 −3');
  assert.doesNotMatch(rows.join(' '), /infra/);
  const marked = await render({ workspace: { project_dir: cwd, current_dir: path.join(cwd, 'web', 'src') } }, cfg, NOW, { git: () => umbrella(cwd) });
  assert.deepEqual(marked.map((r) => r.slice(0, 5)), ['⠀ api', '▸ web', '⠀ Σ +']);
  assert.deepEqual(marked.map((r) => r.trim().slice(0, 5)), marked.map((r) => r.slice(0, 5)));
  const [inline] = await render({ workspace: { current_dir: cwd } }, plain({ lines: [[{ id: 'git', rows: false }]] }), NOW, { git: () => umbrella(cwd) });
  assert.match(inline, /2 of 3 repos changed · api ⎇ feat\/a-very-long-branch…/);
});

test('rate limit: pace marker only when burning faster than the window', () => {
  const s = Math.floor(NOW / 1000);
  const cfg = plain({ lines: [['limit-5h']] });
  const fast = renderLines(cfg, { in: { rate_limits: { five_hour: { used_percentage: 80, resets_at: s + 4 * 3600 } } }, now: NOW });
  const slow = renderLines(cfg, { in: { rate_limits: { five_hour: { used_percentage: 10, resets_at: s + 3600 } } }, now: NOW });
  assert.match(fast[0], /out in/);
  assert.doesNotMatch(slow[0], /out in/);
});

test('git porcelain v2 and numstat parsing', () => {
  const st = parseStatus('# branch.head main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 a b f1\n1 .M N... 100644 100644 100644 a b f2\nu UU N... 1 2 3 4 a b c f3\n? new.txt\n');
  assert.deepEqual(st, { branch: 'main', ahead: 2, behind: 1, changed: 3, deleted: 0, staged: 1, untracked: 1, conflicts: 1 });
  assert.deepEqual(parseNumstat('3\t1\ta.js\n-\t-\tbin.png\n10\t0\tb.js\n'), { add: 13, del: 1 });
});

test('transcript: running tool, subagents, todos, permission mode', () => {
  const lines = [
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/done.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'in_progress' }] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }, { type: 'tool_use', id: 't3', name: 'Bash', input: { description: 'run tests' } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.deepEqual(transcript.parse(lines), { tool: { name: 'Bash', detail: 'run tests' }, agents: 1, todos: { done: 1, total: 2 }, permissionMode: 'plan' });
});

test('cost today: priced per model, yesterday skipped, content blocks deduplicated', () => {
  const day = today.startOfDay(NOW);
  const row = (ts, id, usage, model = 'claude-opus-5-5') => ({ type: 'assistant', requestId: `r-${id}`, message: { id, model, usage }, timestamp: new Date(ts).toISOString() });
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } };
  const text = [
    row(day - 3600e3, 'm0', u),
    row(day + 3600e3, 'm1', u),
    row(day + 3600e3, 'm1', u),
    row(day + 7200e3, 'm2', { input_tokens: 1_000_000, output_tokens: 0, speed: 'fast' }),
  ].map((o) => JSON.stringify(o)).join('\n');
  const st = today.scan(text, { cost: 0, lastKey: null }, day);
  const opus55 = { in: 4, out: 20, read: 0.2 };
  const expected = (opus55.in + opus55.out + opus55.read + opus55.in * 2) + opus55.in * 2;
  assert.equal(Math.round(st.cost * 100) / 100, expected);
});

test('subagent rows: one JSON line per task with context share', () => {
  const [row] = renderSubagents({ tasks: [{ id: 'x1', name: 'rev', agentType: 'code-reviewer', status: 'running', model: 'claude-sonnet-5', tokenCount: 50000, contextWindowSize: 200000, tokenSamples: [1, 5, 9], startTime: NOW - 90_000, label: 'checking' }] }, plain(), NOW);
  const o = JSON.parse(row);
  assert.equal(o.id, 'x1');
  for (const s of ['rev', 'code-reviewer', 'sonnet-5', '50k', '25%', '1m', 'checking']) assert.ok(o.content.includes(s), `missing ${s}: ${o.content}`);
});

test('plan widget: Team/Enterprise plan in warn color, others muted', () => {
  delete process.env.NO_COLOR;
  const cfg = deepMerge(config.DEFAULTS, { lines: [['plan']] });
  const [team] = renderLines(cfg, { plan: { label: 'Team', team: true }, now: NOW });
  const [pro] = renderLines(cfg, { plan: { label: 'Pro', team: false }, now: NOW });
  assert.ok(team.includes('\x1b[33m'), team);
  assert.ok(!team.includes('\x1b[90m'), team);
  assert.ok(pro.includes('\x1b[90m'), pro);
  assert.ok(!pro.includes('\x1b[33m'), pro);
});

test('config: user lines replace defaults, nested keys merge', () => {
  const cfg = deepMerge(config.DEFAULTS, { lines: [['model']], colors: { model: 'red' } });
  assert.deepEqual(cfg.lines, [['model']]);
  assert.equal(cfg.colors.model, 'red');
  assert.equal(cfg.colors.ok, 'green');
});

test('a throwing widget does not blank the line', () => {
  const { byId } = require('../src/widgets');
  const orig = byId.model.render;
  byId.model.render = () => { throw new Error('boom'); };
  try {
    const [l] = renderLines(plain({ lines: [['model', 'effort']] }), { in: { effort: { level: 'max' } }, now: NOW });
    assert.equal(l, 'max');
  } finally { byId.model.render = orig; }
});
