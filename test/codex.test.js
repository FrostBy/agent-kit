'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const codex = require('../src/sources/codex');
const git = require('../src/sources/git');
const config = require('../src/config');
const { render } = require('../src/render');
const { frame, fitLine } = require('../src/panel');
const { codexSample } = require('../src/sample');
const { deepMerge } = require('../src/util');

const NOW = Date.UTC(2026, 9, 25, 12);
const row = (type, payload) => ({ type, payload, timestamp: new Date(NOW).toISOString() });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const plain = (over = {}) => deepMerge(config.CODEX_DEFAULTS, { color: false, links: false, ...over });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-statusline-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Codex uses last-request context, cumulative session tokens and actual quota windows', () => {
  const root = path.resolve('/work');
  const s = codex.apply(jsonl([
    row('session_meta', { id: 'one', cwd: root, timestamp: new Date(NOW - 60000).toISOString(), cli_version: '0.164.0' }),
    row('turn_context', { model: 'gpt-6.1-sol', effort: 'high', cwd: root }),
    row('event_msg', { type: 'token_count', info: {
      model_context_window: 1000,
      last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 },
      total_token_usage: { input_tokens: 5000, output_tokens: 500 },
    }, rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 2, window_minutes: 10080, resets_at: NOW / 1000 + 10000 }, secondary: null } }),
    row('event_msg', { type: 'token_count', info: null, rate_limits: null }),
  ]));
  const snap = codex.snapshot(s, root, NOW);
  assert.equal(snap.input.context_window.used_tokens, 110);
  assert.equal(snap.input.context_window.used_percentage, 11);
  assert.equal(snap.input.context_window.current_usage.input_tokens, 20);
  assert.equal(snap.input.token_usage.input_tokens, 5000);
  assert.equal(snap.input.quota_windows.length, 1);
  assert.equal(snap.input.quota_windows[0].label, '7d');
  assert.equal(snap.plan.label, 'Pro');
  assert.equal(snap.input.cost.total_duration_ms, 60000);
});

test('Codex pairs tool calls/results, tracks plans and clears activity at turn completion', () => {
  const s = codex.apply(jsonl([
    row('event_msg', { type: 'task_started' }),
    row('response_item', { type: 'function_call', call_id: 'plan', name: 'functions.update_plan', arguments: JSON.stringify({ plan: [{ status: 'completed' }, { status: 'in_progress' }] }) }),
    row('response_item', { type: 'function_call_output', call_id: 'plan', output: 'ok' }),
    row('response_item', { type: 'function_call', call_id: 'read', name: 'read_file', arguments: 'null' }),
    row('response_item', { type: 'custom_tool_call', call_id: 'exec', name: 'exec', input: 'private command' }),
    row('response_item', { type: 'function_call_output', call_id: 'read', output: 'ok' }),
  ]));
  assert.equal(codex.snapshot(s, '/work').activity.tool.name, 'exec');
  assert.deepEqual(s.todos, { done: 1, total: 2 });
  codex.apply(jsonl([row('event_msg', { type: 'task_complete' })]), s);
  assert.equal(codex.snapshot(s, '/work').activity.tool.name, 'idle');
  assert.equal(s.pending.size, 0);
  assert.doesNotThrow(() => codex.apply('null\n{broken}\n'));
  assert.equal(codex.clean('\x1b[2Jhello\r\n'), '[2Jhello');
});

test('Codex labels active context, cumulative tokens and account quota independently', async () => {
  const root = path.resolve('/work'), s = codex.state();
  s.context = { model: 'gpt-6.1-sol', effort: 'high' };
  s.info = {
    model_context_window: 475000,
    last_token_usage: { input_tokens: 223336, output_tokens: 227, total_tokens: 223563 },
    total_token_usage: { input_tokens: 11063897, output_tokens: 45888 },
  };
  s.limits.set('codex', { primary: { used_percent: 3, window_minutes: 10080 } });
  const snap = codex.snapshot(s, root, NOW);
  snap.git = codexSample(NOW, root).git;
  const out = (await frame(snap, plain(), root)).join('\n');
  assert.equal(snap.input.context_window.context_window_size, 475000);
  assert.equal(snap.input.context_window.used_tokens, 223563);
  assert.match(out, /ctx .*47% 224k\/475k/);
  assert.match(out, /7d .*3%/);
  assert.equal(snap.input.token_usage.input_tokens, 11063897);
  assert.doesNotMatch(out, /quota used:|session tokens:/);
  assert.doesNotMatch(out, /\/1M|\/1\.05M/);
});

test('Codex reader handles appended partial UTF-8, malformed rows and truncated logs', (t) => {
  const dir = temp(t), file = path.join(dir, 'session.jsonl');
  const meta = jsonl([row('session_meta', { id: 'test', cwd: dir })]);
  const model = Buffer.from(jsonl([row('turn_context', { model: 'модель', effort: 'high' })]));
  const split = model.indexOf(Buffer.from('модель')) + 1;
  fs.writeFileSync(file, Buffer.concat([Buffer.from(meta), model.subarray(0, split)]));
  const reader = new codex.Reader(file);
  assert.equal(reader.read().meta.id, 'test');
  assert.equal(reader.state.context.model, undefined);
  fs.appendFileSync(file, model.subarray(split));
  fs.appendFileSync(file, '{broken}\n');
  assert.equal(reader.read().context.model, 'модель');
  const offset = reader.offset;
  assert.equal(reader.read().context.model, 'модель');
  assert.equal(reader.offset, offset);
  fs.writeFileSync(file, jsonl([row('session_meta', { id: 'replacement' })]));
  assert.equal(reader.read().meta.id, 'replacement');
  assert.equal(reader.state.context.model, undefined);
});

test('Codex discovery stays inside the selected umbrella and supports explicit sessions', (t) => {
  const home = temp(t), root = path.join(home, 'work');
  const sessions = path.join(home, 'sessions', '2026', '10', '25');
  fs.mkdirSync(sessions, { recursive: true });
  const write = (name, cwd) => {
    const file = path.join(sessions, name + '.jsonl');
    fs.writeFileSync(file, jsonl([row('session_meta', { id: name, cwd })]));
    return file;
  };
  write('rollout-03-outside', root + '-other');
  const inside = write('rollout-02-inside', path.join(root, 'api'));
  const older = write('rollout-01-older', root);
  assert.equal(codex.findSession({ home, root, threadId: '' }), inside);
  assert.equal(codex.findSession({ home, root, threadId: 'older' }), older);
  assert.equal(codex.findSession({ home, root, session: 'inside' }), inside);
  assert.equal(codex.findSession({ home, root, session: inside }), inside);
  assert.equal(codex.findSession({ home, root: path.join(home, 'empty'), threadId: '' }), null);
  assert.throws(() => codex.findSession({ home, root, session: 'missing' }), /not found/);
});

test('Codex auto pick skips guardian subagent rollouts in the same cwd', (t) => {
  const home = temp(t), root = path.join(home, 'work');
  const sessions = path.join(home, 'sessions', '2026', '10', '25');
  fs.mkdirSync(sessions, { recursive: true });
  const write = (name, meta) => {
    const file = path.join(sessions, name + '.jsonl');
    fs.writeFileSync(file, jsonl([row('session_meta', meta)]));
    return file;
  };
  const parent = write('rollout-01-parent', { id: 'parent', cwd: root });
  const guardian = write('rollout-02-guardian', {
    id: 'guardian', cwd: root, parent_thread_id: '01a17063-x',
    source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review',
  });
  assert.equal(codex.findSession({ home, root, threadId: '' }), parent);
  assert.equal(codex.findSession({ home, root, session: 'guardian' }), guardian);
  assert.equal(codex.findSession({ home, root, threadId: 'parent' }), parent);
});

test('Git counts deleted/staged files and does not parse rename source paths as statuses', () => {
  const s = git.parseStatus('# branch.head main\0# branch.ab +2 -1\0'
    + '1 .D N... 100644 100644 000000 a b deleted\0'
    + '1 AM N... 100644 100644 100644 a b added\0'
    + '2 R. N... 100644 100644 100644 a b R100 renamed\0? old-name\0'
    + '? new/file-one\0? new/file-two\0');
  assert.equal(s.changed, 3);
  assert.equal(s.deleted, 1);
  assert.equal(s.staged, 2);
  assert.equal(s.untracked, 2);
});

test('Git scanner counts individual untracked files and tracked deletions in a real repo', async (t) => {
  const dir = temp(t);
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', windowsHide: true });
  run('init', '--quiet');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'old\n');
  run('add', 'gone.txt');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture');
  fs.unlinkSync(path.join(dir, 'gone.txt'));
  fs.mkdirSync(path.join(dir, 'new'));
  fs.writeFileSync(path.join(dir, 'new', 'a'), 'a');
  fs.writeFileSync(path.join(dir, 'new', 'b'), 'b');
  const s = await git.repoState(dir);
  assert.equal(s.deleted, 1);
  assert.equal(s.untracked, 2);
  assert.equal(s.del, 1);
});

test('Codex panel renders the full umbrella without Claude credentials or usage requests', async () => {
  const usage = require('../src/sources/usage');
  const oldLoad = usage.load, oldPlan = usage.plan;
  usage.load = usage.plan = () => { throw new Error('Claude source called'); };
  try {
    const snap = codexSample(NOW, path.resolve('/work'));
    const out = (await frame(snap, plain(), snap.git.root, { demo: true })).join('\n');
    for (const value of ['Codex · DEMO', 'gpt-6.1-sol', '200k/475k', '+120 −34 ?3', 'Σ +171 −47', '1 to pull', '3/7', 'agents 2']) {
      assert.ok(out.includes(value), `missing ${value}:\n${out}`);
    }
    assert.doesNotMatch(out, /Fable|Max 20x|\$/);
  } finally { usage.load = oldLoad; usage.plan = oldPlan; }
});

test('umbrella shows behind-only and stash-only repos and totals include hidden rows', async () => {
  const root = path.resolve('/work');
  const g = codexSample(NOW, root).git;
  g.repos.push({ dir: path.join(root, 'behind'), branch: 'main', behind: 2 });
  g.repos.push({ dir: path.join(root, 'stashed'), branch: 'main', stash: 1 });
  const cfg = plain({ lines: [['git']], widgets: { git: { max: 20, stash: true } } });
  const all = (await render({ workspace: { current_dir: root } }, cfg, NOW, { git: () => g })).join('\n');
  assert.match(all, /behind\s+⎇ main/);
  assert.match(all, /stashed\s+⎇ main/);
  const limited = (await render({}, plain({ lines: [['git']], widgets: { git: { max: 1, stash: true } } }), NOW, { git: () => g })).join('\n');
  assert.match(limited, /Σ \+171 −47/);
  assert.match(limited, /\+4 more/);
});

test('Codex CLI preview runs without a session and invalid watch/install modes fail clearly', (t) => {
  const dir = temp(t);
  const cli = path.resolve(__dirname, '..', 'statusline.js');
  const env = { ...process.env, CODEX_HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'no-claude'), AGENT_STATUSLINE_CONFIG: path.join(dir, 'config.json'), NO_COLOR: '1' };
  const run = (...args) => spawnSync(process.execPath, [cli, '--codex', ...args], { env, encoding: 'utf8', windowsHide: true });
  const preview = run('--preview');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Σ \+171 −47/);
  const install = run('--install');
  assert.equal(install.status, 1);
  assert.match(install.stdout, /native Codex needs a patched CLI/);
  const watch = run('--watch');
  assert.equal(watch.status, 1);
  assert.match(watch.stdout, /interactive terminal/);
  const waiting = run(`--root=${dir}`);
  assert.equal(waiting.status, 0, waiting.stdout + waiting.stderr);
  assert.match(waiting.stdout, /Waiting|Ожидание/);
  const init = run('--init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).lines, config.CODEX_DEFAULTS.lines);
  assert.equal(fs.existsSync(path.join(dir, 'no-claude')), false);
});

test('watch lines fit narrow terminals without leaking ANSI escapes or splitting emoji', () => {
  const styled = '\x1b[31mhello\x1b[0m';
  assert.equal(fitLine(styled, 5), styled);
  assert.equal(fitLine(styled, 4), 'hel…');
  assert.equal(fitLine('📋 3/7', 4), '📋 …');
  assert.equal(fitLine('e\u0301 abcdef', 4), 'e\u0301 a…');
});
