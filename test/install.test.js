'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { items, parseArgs, resolveSelection, voiceSetting, configureVoice, main, choose } = require('../install');
const { ROOT } = require('../scripts/codex/common');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), AGENT_STATUSLINE_CONFIG: path.join(root, 'statusline.json') };
  fs.mkdirSync(env.CODEX_HOME); fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  return { root, env, file: path.join(env.CODEX_HOME, 'config.toml') };
}

test('installer flags validate IDs, resolve dependencies and disable Codex outside Windows', () => {
  assert.deepEqual(parseArgs(['--yes', '--only=claude,interaction-modes', '--skip', 'voice']), { yes: true, only: ['claude', 'interaction-modes'], skip: ['voice'] });
  for (const args of [['--only'], ['--skip='], ['--only', 'claude,'], ['--wat'], ['--yes=no'], ['--only', 'claude', '--only', 'voice']]) assert.throws(() => parseArgs(args));
  const selection = resolveSelection({ only: ['interaction-modes'] }, 'win32');
  assert.deepEqual(selection.features.map(f => f.id), ['statusline', 'interaction-modes']);
  assert.deepEqual(selection.automatic, ['statusline']);
  assert.throws(() => resolveSelection({ only: ['interaction-modes'], skip: ['statusline'] }, 'win32'), /required/);
  assert.throws(() => resolveSelection({ only: ['typo'] }), /Unknown item/);
  assert.throws(() => resolveSelection({ skip: ['typo'] }), /Unknown item/);
  assert.throws(() => resolveSelection({ only: ['voice'] }, 'linux'), /TODO/);
  assert.deepEqual(resolveSelection({ yes: true }, 'darwin').selected.map(i => i.id), ['claude']);
  assert.deepEqual(resolveSelection({ only: ['claude'], skip: ['claude'] }).selected, []);
  assert(items('linux').filter(i => !['claude', 'broker', 'sync'].includes(i.id)).every(i => !i.available));
});

test('installer lists without changes, refuses implicit non-TTY actions and preflights before executing', async t => {
  const { env } = fixture(t), calls = [], messages = [];
  const deps = { env, platform: 'win32', tty: false, log: msg => messages.push(msg), exec: (...args) => calls.push(args), requirements: () => { throw Error('requirements failed'); } };
  await main(['--list'], deps);
  assert(messages.some(m => /interaction-modes.*requires statusline/.test(m)));
  assert.equal(calls.length, 0);
  await assert.rejects(main([], deps), /No TTY/);
  await assert.rejects(main(['--only', 'claude,statusline'], deps), /requirements failed/);
  assert.equal(calls.length, 0);
  const order = [];
  await main(['--only', 'claude,interaction-modes'], { ...deps, requirements: () => order.push('requirements'), log: msg => { order.push('summary'); messages.push(msg); }, exec: (...args) => { order.push('action'); calls.push(args); } });
  assert.equal(order[0], 'requirements');
  assert(order.indexOf('summary') < order.indexOf('action'));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][1], [path.join(ROOT, 'statusline.js'), '--install']);
  assert.deepEqual(calls[1][1].slice(1), ['build', '--features', 'statusline,interaction-modes']);
  assert.deepEqual(calls[2][1].slice(1), ['install']);
  assert.equal(calls[0][2].env, env);
  assert(messages.some(m => /statusline:.*dependency added automatically/.test(m)));
});

test('Claude installation reuses existing logic with a fake CLAUDE_CONFIG_DIR', async t => {
  const { env } = fixture(t);
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ existing: true, statusLine: { command: 'old' } }));
  await main(['--only', 'claude'], { env, platform: 'linux', tty: false, log: () => {}, exec: (command, args, opts) => {
    const result = spawnSync(command, args, { ...opts, stdio: 'pipe', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } });
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.existing, true);
  assert.match(settings.statusLine.command, /statusline\.js/);
  assert(settings.subagentStatusLine);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'statusline.backup.json'), 'utf8')).statusLine.command, 'old');
});

test('voice insertion stays at the TOML root and backs up the exact original', async t => {
  const { env, file } = fixture(t);
  const before = '# keep this\nmodel = "codex"\n[profiles.test]\nexperimental_realtime_ws_backend_prompt = "nested; leave it"\n';
  fs.writeFileSync(file, before);
  await configureVoice({ env, yes: true, log: () => {} });
  const after = fs.readFileSync(file, 'utf8');
  assert(after.indexOf('experimental_realtime_ws_backend_prompt') < after.indexOf('[profiles.test]'));
  assert(after.endsWith('[profiles.test]\nexperimental_realtime_ws_backend_prompt = "nested; leave it"\n'));
  const backups = fs.readdirSync(env.CODEX_HOME).filter(f => f.includes('backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(env.CODEX_HOME, backups[0]), 'utf8'), before);
  const { found } = voiceSetting(after);
  const prompt = JSON.parse(after.slice(found.start, found.end).trim().split(' = ')[1]);
  assert.match(prompt, /Speak at a faster pace\./);
  assert.doesNotMatch(prompt, /user_first_name/);
  const messages = [];
  assert.equal(await configureVoice({ env, yes: true, log: msg => messages.push(msg) }), false);
  assert.match(messages[0], /Skipped voice/);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(fs.readdirSync(env.CODEX_HOME).filter(f => f.includes('backup-')).length, 1);
});

test('voice replacement asks and handles multiline values without changing other TOML', async t => {
  const { env, file } = fixture(t);
  const before = `# header\n"experimental_realtime_ws_backend_prompt" = '''old\n[not_a_table]\nexperimental_realtime_ws_backend_prompt = "inside prompt"\n''' # old comment\nmodel = "keep"\n[features]\nfast = true\n`;
  fs.writeFileSync(file, before);
  await assert.rejects(configureVoice({ env, log: () => {} }), /TTY/);
  assert.equal(await configureVoice({ env, confirm: async () => false, log: () => {} }), false);
  let asked = false;
  await configureVoice({ env, confirm: async question => { asked = true; assert.match(question, /Replace existing/); return true; }, log: () => {} });
  assert(asked);
  const after = fs.readFileSync(file, 'utf8');
  assert(after.startsWith('# header\nexperimental_realtime_ws_backend_prompt = '));
  assert(after.endsWith('model = "keep"\n[features]\nfast = true\n'));
  assert.doesNotMatch(after, /not_a_table/);
  assert.throws(() => voiceSetting('model = "unterminated'), /Unclosed/);
  assert.throws(() => voiceSetting('experimental_realtime_ws_backend_prompt="a"\nexperimental_realtime_ws_backend_prompt="b"'), /Duplicate/);
  assert.equal(voiceSetting('# experimental_realtime_ws_backend_prompt = "comment"\nprompt = """\nexperimental_realtime_ws_backend_prompt = "data"\n"""\n').found, undefined);
});

test('voice refuses a concurrent config edit after confirmation', async t => {
  const { env, file } = fixture(t);
  fs.writeFileSync(file, 'experimental_realtime_ws_backend_prompt = "old"\n');
  await assert.rejects(configureVoice({ env, log: () => {}, confirm: async () => { fs.appendFileSync(file, 'model="new"\n'); return true; } }), /changed while awaiting/);
  assert(fs.readFileSync(file, 'utf8').endsWith('model="new"\n'));
  assert.deepEqual(fs.readdirSync(env.CODEX_HOME), ['config.toml']);
});

test('checkbox keyboard selection displays automatic dependencies and restores the terminal', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let raw = false, rendered = '';
  input.setRawMode = value => { raw = value; }; output.columns = 160;
  output.on('data', chunk => { rendered += chunk.toString(); });
  const result = choose(input, output);
  const index = items().findIndex(item => item.id === (process.platform === 'win32' ? 'interaction-modes' : 'claude'));
  for (let i = 0; i < index; i++) input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', ' ', { name: 'space' });
  if (process.platform === 'win32') assert.match(rendered, /statusline \(required\)/);
  input.emit('keypress', '\r', { name: 'return' });
  const opts = await result;
  assert.equal(raw, false);
  assert.equal(input.listenerCount('keypress'), 0);
  if (process.platform === 'win32') assert.deepEqual(resolveSelection(opts).automatic, ['statusline']);
  input.destroy(); output.destroy();
});
