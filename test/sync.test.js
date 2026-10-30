'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { configuration, hook, eligible, extract, incremental, withConfig, write, hookConfigs } = require('../src/sync');
const { configure } = require('../src/sync/install');
const { slug, activated, projectPaths } = require('../src/sync/activation');
const opts = { env: {}, interactive: async () => true };
const jsonl = records => records.map(JSON.stringify).join('\n') + '\n';
const c = (id, text, extra = {}) => ({ type: 'user', uuid: randomUUID(), sessionId: id, message: { role: 'user', content: text }, ...extra });
const x = text => ({ type: 'response_item', payload: { id: randomUUID(), type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-kit-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const config = configuration(path.join(root, 'project'), env);
  config.versions = { claude: 'test-claude', codex: 'test-codex' };
  await fs.mkdir(path.join(config.claudeProjectsDir, slug(config.cwd)), { recursive: true });
  await fs.mkdir(config.codexHome, { recursive: true });
  await fs.writeFile(path.join(config.codexHome, 'config.toml'), `[projects.${JSON.stringify(config.cwd)}]\ntrust_level = "trusted"\n`);
  const id = randomUUID(), file = path.join(config.claudeProjectsDir, 'project', `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const input = (kind = 'claude', endpoint = { id, file }, event = 'Stop') => ({ cwd: config.cwd, session_id: endpoint.id, transcript_path: endpoint.file, hook_event_name: event });
  const registry = async () => JSON.parse(await fs.readFile(path.join(config.stateDir, 'pairs.json')));
  const pair = async (index = 0) => JSON.parse(await fs.readFile(path.join(config.stateDir, `${(await registry()).pairs[index].id}.json`)));
  const append = (file, records) => fs.appendFile(file, jsonl(records));
  const archive = async () => (await fs.readFile(path.join(config.stateDir, `${(await pair()).id}.events`), 'utf8')).trim().split('\n').map(JSON.parse);
  return { root, env, config, id, file, input, registry, pair, append, archive };
}

test('bidirectional sync: backfill, tools across hooks, retry/ack, compaction and no mirror loops', async t => {
  const f = await fixture(t), { config, id, file, input, pair, append } = f;
  await fs.writeFile(file, jsonl([
    c(id, 'OLD-HANDOFF'), { type: 'system', subtype: 'compact_boundary', sessionId: id },
    c(id, 'COMPACT-SUMMARY', { isCompactSummary: true }), c(id, 'NEW-TURN'),
    c(id, '', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE-THINKING' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'example' } }] } })
  ]));
  await hook('claude', input(), config, opts);
  let p = await pair(), seed = await fs.readFile(p.codex.file, 'utf8');
  assert.doesNotMatch(seed, /OLD-HANDOFF/); assert.match(seed, /COMPACT-SUMMARY/); assert.match(seed, /NEW-TURN/); assert.doesNotMatch(seed, /PRIVATE/);
  await append(file, [c(id, [{ type: 'tool_result', tool_use_id: 't1', content: 'COMPLETED-TOOL' }])]);
  await hook('claude', input(), config, opts);
  assert((await f.archive()).some(e => e.text.includes('COMPLETED-TOOL')));
  const count = (await pair()).known.length;
  await hook('claude', input(), config, opts);
  assert.equal((await pair()).known.length, count); assert.equal(await fs.readFile(p.codex.file, 'utf8'), seed);
  await append(p.codex.file, [x('RETURN-HANDOFF')]);
  await hook('codex', input('codex', p.codex), config, opts);
  assert.equal((await f.registry()).pairs.length, 1);
  const output = await hook('claude', input('claude', p.claude, 'UserPromptSubmit'), config, opts);
  assert.match(output.hookSpecificOutput.additionalContext, /RETURN-HANDOFF/);
  assert.deepEqual(await hook('claude', input('claude', p.claude, 'UserPromptSubmit'), config, opts), output);
  await append(file, [c(id, output.hookSpecificOutput.additionalContext, { isMeta: true })]);
  assert.equal(await hook('claude', input('claude', p.claude, 'UserPromptSubmit'), config, opts), null);
  await append(file, [c(id, 'NEXT-DELTA')]); await hook('claude', input(), config, opts);
  const reply = await hook('codex', input('codex', p.codex, 'UserPromptSubmit'), config, opts);
  assert.match(reply.hookSpecificOutput.additionalContext, /NEXT-DELTA/); assert.doesNotMatch(reply.hookSpecificOutput.additionalContext, /OLD-HANDOFF|RETURN-HANDOFF/);
  await append(p.codex.file, [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: reply.hookSpecificOutput.additionalContext }] } }]);
  assert.equal(await hook('codex', input('codex', p.codex, 'UserPromptSubmit'), config, opts), null);
  // Independent native Codex session creates its own Claude mirror.
  const codexId = randomUUID(), codexFile = path.join(config.codexSessionsDir, `${codexId}.jsonl`);
  await fs.writeFile(codexFile, jsonl([{ type: 'session_meta', payload: { id: codexId, cwd: config.cwd, source: 'cli', originator: 'codex-tui' } }, x('REVERSE-BACKFILL'), { type: 'response_item', payload: { type: 'compaction', encrypted_content: 'SECRET' } }]));
  await hook('codex', input('codex', { id: codexId, file: codexFile }), config, opts);
  p = await pair(1); seed = await fs.readFile(p.claude.file, 'utf8');
  assert.match(seed, /REVERSE-BACKFILL/); assert.match(seed, /custom-title/); assert.doesNotMatch(seed, /SECRET/);
  await hook('claude', input('claude', p.claude, 'SessionStart'), config, opts);
  await append(p.claude.file, [c(p.claude.id, 'REVERSE-RETURN')]);
  const reverse = await hook('codex', input('codex', p.codex, 'UserPromptSubmit'), config, opts);
  assert.match(reverse.hookSpecificOutput.additionalContext, /REVERSE-RETURN/);
  assert.equal((await f.registry()).pairs.length, 2);
});

test('incremental byte reader: partial UTF-8, truncation, replacement and same-size rewrite', async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, '{"text":"one"}\n');
  let r = await incremental(file); assert.equal(r.records.length, 1);
  assert.equal((await incremental(file, r.cursor)).bytesRead, 0);
  const bytes = Buffer.from('{"text":"привет"}\n');
  await fs.appendFile(file, bytes.subarray(0, 12));
  const partial = await incremental(file, r.cursor); assert.equal(partial.records.length, 0);
  await fs.appendFile(file, bytes.subarray(12));
  r = await incremental(file, partial.cursor); assert.equal(r.records[0].text, 'привет');
  await fs.writeFile(file, '{}\n'); r = await incremental(file, r.cursor); assert.equal(r.reset, true);
  const replacement = file + '.replacement'; await fs.writeFile(replacement, '{"text":"replacement"}\n'); await fs.rename(replacement, file);
  r = await incremental(file, r.cursor); assert.equal(r.reset, true); assert.equal(r.records[0].text, 'replacement');
  await fs.writeFile(file, '{"text":"REPLACEMENT"}\n'); r = await incremental(file, r.cursor); assert.equal(r.reset, true);
  await fs.writeFile(file, '{bad}\n'); await assert.rejects(incremental(file), SyntaxError);
  await fs.writeFile(file, Buffer.from([0xff, 10])); await assert.rejects(incremental(file), /encoded data/);
});

test('eligibility caches process checks, rechecks resumed modes, and excludes brokers/sidechains/exec', async t => {
  const f = await fixture(t); let probes = 0;
  await fs.writeFile(f.file, jsonl([c(f.id, 'hello')]));
  const options = { env: {}, interactive: async () => { probes++; return true; } };
  await hook('claude', f.input(), f.config, options); await hook('claude', f.input(), f.config, options);
  assert.equal(probes, 1);
  for (const env of [{ SESSION_SYNC_BROKER: '1' }, { SESSION_SYNC_EXCLUDE: '1' }]) assert.equal(await hook('claude', f.input(), f.config, { ...options, env }), null);
  const before = (await f.pair()).known.length;
  await hook('claude', f.input('claude', undefined, 'SessionStart'), f.config, { env: {}, cliIdentity: 'other-cli', interactive: async () => false });
  await f.append(f.file, [c(f.id, 'PRINT-ONLY')]);
  assert.equal(await hook('claude', f.input(), f.config, options), null);
  assert.equal((await f.pair()).known.length, before); assert.equal(probes, 1);
  for (const source of ['exec', 'appServer', { subagent: {} }]) assert.equal(await eligible('codex', f.input(), [{ type: 'session_meta', payload: { source, originator: 'codex-tui' } }], {}, options.interactive), false);
  assert.equal(await eligible('claude', { ...f.input(), agent_id: 'child' }, [], {}, options.interactive), false);
  assert.equal(await eligible('claude', { ...f.input(), transcript_path: '/subagents/agent-123.jsonl' }, [], {}, options.interactive), false);
  assert.equal(extract('claude', [c(f.id, 'sidechain', { isSidechain: true })], f.id).length, 0);
  assert.throws(() => extract('codex', [{ type: 'event_msg', payload: { type: 'thread_rolled_back' } }], 'id'), /rollback/);
});

test('confined writes, orphan mirrors, mismatched IDs, archive recovery and lock contention fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(write(f.file, 'no'), /explicit/);
  await withConfig(f.config, async () => {
    await assert.rejects(write(path.join(f.root, 'outside.json'), '{}'), /outside configured/);
    await assert.rejects(write(f.file, 'overwrite'), /rewrite an existing session/);
  });
  await assert.rejects(withConfig({ ...f.config, stateDir: 'relative' }, () => {}), /absolute/);
  await fs.writeFile(f.file, jsonl([c('wrong-id', 'no')])); await assert.rejects(hook('claude', f.input(), f.config, opts), /ID mismatch/);
  await fs.writeFile(f.file, jsonl([{ type: 'session-sync-mirror', sessionId: f.id }])); await assert.rejects(hook('claude', f.input(), f.config, opts), /Orphan mirror/);
  await fs.writeFile(f.file, jsonl([c(f.id, 'valid')])); await hook('claude', f.input(), f.config, opts);
  let p = await f.pair(); const journal = path.join(f.config.stateDir, `${p.id}.events`);
  await fs.appendFile(journal, 'uncommitted partial tail'); await hook('claude', f.input(), f.config, opts);
  assert.equal((await fs.stat(journal)).size, p.archiveSize);
  await fs.writeFile(path.join(f.config.stateDir, 'lock'), '');
  assert.equal(await hook('claude', f.input(), f.config, opts), null); await fs.unlink(path.join(f.config.stateDir, 'lock'));
  await fs.truncate(journal, 0); await assert.rejects(hook('claude', f.input(), f.config, opts), /archive truncated/);
  await assert.rejects(hook('claude', { ...f.input(), transcript_path: path.join(f.root, 'outside.jsonl') }, f.config, opts), /outside configured/);
});

test('installer uses fake homes, keeps other hooks/config, is idempotent and removes only owned hooks', async t => {
  const f = await fixture(t), log = () => {};
  const settings = path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), toml = path.join(f.env.CODEX_HOME, 'config.toml');
  await fs.mkdir(f.env.CODEX_HOME, { recursive: true });
  await fs.writeFile(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep' }] }] }, other: true }));
  await fs.writeFile(toml, 'model = "keep"\n[features]\nfast = true\n');
  assert.equal(configure({ env: f.env, log }), 2);
  assert.equal(configure({ env: f.env, log }), 0);
  assert.deepEqual(Object.keys(hookConfigs('script').claude.hooks), ['SessionStart', 'UserPromptSubmit', 'Stop']);
  let parsed = JSON.parse(await fs.readFile(settings)); assert.equal(parsed.hooks.Stop.length, 2);
  await fs.appendFile(toml, '# unrelated later edit\n');
  assert.equal(configure({ env: f.env, remove: true, log }), 2);
  assert.equal(configure({ env: f.env, remove: true, log }), 0);
  parsed = JSON.parse(await fs.readFile(settings)); assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'keep'); assert.equal(parsed.other, true);
  assert.match(await fs.readFile(toml, 'utf8'), /unrelated later edit/); assert.doesNotMatch(await fs.readFile(toml, 'utf8'), /SESSION-SYNC/);
  assert((await fs.readdir(f.env.CODEX_HOME)).some(n => n.includes('backup')));
  await fs.writeFile(toml, '# BEGIN AGENT-KIT SESSION-SYNC\n');
  const before = await fs.readFile(settings, 'utf8'); assert.throws(() => configure({ env: f.env, log }), /Ambiguous/); assert.equal(await fs.readFile(settings, 'utf8'), before);
});

test('50 MiB / 4200 events: cached hook stays under one second and does not reread/rewrite the archive', async t => {
  const f = await fixture(t), rows = [];
  for (let i = 0; i < 4200; i++) rows.push(c(f.id, '', { uuid: `event-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `turn ${i}` }, { type: 'thinking', thinking: 'x'.repeat(12500) }] } }));
  await fs.writeFile(f.file, jsonl(rows));
  const cold = performance.now(); await hook('claude', f.input(), f.config, opts); const coldMs = performance.now() - cold;
  const p = await f.pair(); assert.equal(p.known.length, 256); assert.equal((await f.archive()).length, 4200);
  const journal = path.join(f.config.stateDir, `${p.id}.events`), before = await fs.stat(journal);
  const start = performance.now(); await hook('claude', f.input(), f.config, opts); const warmMs = performance.now() - start;
  assert(warmMs < 1000, `warm hook ${warmMs.toFixed(1)} ms`);
  assert.equal((await fs.stat(journal)).mtimeMs, before.mtimeMs);
  assert.equal((await incremental(f.file, (await f.pair()).claude.cursor)).bytesRead, 0);
  t.diagnostic(`50 MiB / 4200 events: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms`);
});

test('process ancestry uses CIM on Windows and ps on Unix; unknown/print/exec modes fail closed', async () => {
  const { processInteractive } = require('../src/sync');
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const [kind, name, command, expected] of [
      ['claude', 'claude.exe', 'claude.exe', true], ['claude', 'claude.exe', 'claude.exe --print hello', false],
      ['claude', 'claude.exe', 'claude.exe -p=hello', false], ['codex', 'codex.exe', 'codex.exe exec resume id', false],
      ['codex', 'codex.exe', 'codex.exe review', false], ['codex', 'codex.exe', 'codex.exe app-server', false],
      ['codex', 'codex.exe', 'codex.exe', true], ['codex', 'node', 'node /opt/codex.js exec task', false],
      ['codex', 'node', 'node /opt/codex.js', true], ['codex', 'node', 'node /app/sync.js hook codex', false]
    ]) {
      const run = async (exe, args) => {
        if (platform === 'win32') { assert.equal(exe, 'powershell.exe'); assert.match(args.at(-1), /Get-CimInstance/); return { stdout: JSON.stringify([{ name, command }]) }; }
        assert.equal(exe, 'ps'); return { stdout: `123 1 ${name} ${command}\n1 0 init init\n` };
      };
      assert.equal(await processInteractive(kind, { platform, pid: 123, run }), expected, `${platform}: ${command}`);
    }
  }
});

test('installer handles multiline TOML safely, and CLI installation/removal stays in fake homes', async t => {
  const f = await fixture(t), { tomlBlock } = require('../src/sync/install');
  const before = 'prompt = """line one\nline two"""\n[features]\nfast = true\n';
  const installed = tomlBlock(before, '# BEGIN AGENT-KIT SESSION-SYNC\n# owned\n# END AGENT-KIT SESSION-SYNC\n');
  assert.equal(tomlBlock(installed, ''), before);
  assert.throws(() => tomlBlock('prompt = """\n# BEGIN AGENT-KIT SESSION-SYNC\n# END AGENT-KIT SESSION-SYNC\n"""', ''), /inside TOML/);
  const { spawnSync } = require('node:child_process');
  const script = path.resolve(__dirname, '../scripts/agents/sync.js');
  for (const command of ['install', 'install', 'uninstall', 'uninstall']) {
    const result = spawnSync(process.execPath, [script, command], { env: { ...process.env, ...f.env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.doesNotMatch(await fs.readFile(path.join(f.env.CODEX_HOME, 'config.toml'), 'utf8'), /SESSION-SYNC/);
});

test('activation requires both registrations, caches TOML mtime, and skips before transcript/process reads', async t => {
  const f = await fixture(t), toml = path.join(f.config.codexHome, 'config.toml');
  const dir = path.join(f.config.claudeProjectsDir, slug(f.config.cwd));
  const never = { env: {}, interactive: () => { throw Error('process probe must not run'); } };
  await fs.rm(toml);
  const start = performance.now();
  assert.equal(await hook('claude', f.input(), f.config, never), null);
  assert(performance.now() - start < 100);
  const literal = `[projects.'${f.config.cwd}']\ntrust_level = 'trusted'\n`;
  await fs.writeFile(toml, literal);
  assert.equal(await activated(f.config), true);
  const cache = path.join(f.config.stateDir, 'activation.json'), before = await fs.stat(cache);
  assert.equal(await activated(f.config), true); assert.equal((await fs.stat(cache)).mtimeMs, before.mtimeMs);
  await fs.rmdir(dir); assert.equal(await hook('claude', f.input(), f.config, never), null);
  await fs.mkdir(dir); assert.equal(await activated(f.config), true);
  await fs.writeFile(toml, 'prompt = """\n' + literal + '"""\n');
  assert.equal(await hook('claude', f.input(), f.config, never), null);
  await fs.writeFile(toml, `[projects.${JSON.stringify(f.config.cwd)}]\n`);
  assert.equal(await activated(f.config), true);
  assert.deepEqual(projectPaths(literal), [f.config.cwd]);
  if (process.platform === 'win32') {
    await fs.writeFile(toml, `[projects.${JSON.stringify(f.config.cwd.toUpperCase().replaceAll('\\', '/'))}]\n`);
    assert.equal(await activated(f.config), true);
  }
});

test('install and uninstall follow file symlinks and keep links and unrelated target settings intact', async t => {
  const f = await fixture(t), settings = path.join(f.config.claudeHome, 'settings.json');
  const target = path.join(f.root, 'real-settings.json'), tomlTarget = path.join(f.root, 'real-config.toml');
  const toml = path.join(f.config.codexHome, 'config.toml');
  await fs.writeFile(target, '{"keep":true}\n'); await fs.writeFile(tomlTarget, 'model = "keep"\n');
  await fs.unlink(toml);
  await fs.symlink(target, settings, 'file'); await fs.symlink(tomlTarget, toml, 'file');
  for (const remove of [false, true]) {
    configure({ env: f.env, remove, log: () => {} });
    assert((await fs.lstat(settings)).isSymbolicLink()); assert((await fs.lstat(toml)).isSymbolicLink());
    assert.equal(await fs.realpath(settings), await fs.realpath(target)); assert.equal(await fs.realpath(toml), await fs.realpath(tomlTarget));
    assert.equal(JSON.parse(await fs.readFile(target)).keep, true);
    assert.equal(Boolean(JSON.parse(await fs.readFile(target)).hooks), !remove);
  }
  assert.equal(await fs.readFile(tomlTarget, 'utf8'), 'model = "keep"\n');
});

test('mirror seed uses only the latest compact summary and recent context, within the byte budget', async t => {
  const f = await fixture(t); f.config.contextTokens = 700;
  const history = Array.from({ length: 100 }, (_, n) => c(f.id, `OLD-MONTH-${n} ` + 'x'.repeat(200)));
  history.push({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), sessionId: f.id }, c(f.id, 'LATEST-MONTH-SUMMARY', { isCompactSummary: true }));
  for (let n = 0; n < 20; n++) history.push(c(f.id, `FRESH-${n} ` + 'я'.repeat(160)));
  await fs.writeFile(f.file, jsonl(history)); await hook('claude', f.input(), f.config, opts);
  const p = await f.pair(), seedRows = (await fs.readFile(p.codex.file, 'utf8')).trim().split('\n').map(JSON.parse);
  const content = seedRows.slice(1).map(r => r.payload.content[0].text).join('\n');
  assert.match(seedRows[1].payload.content[0].text, /LATEST-MONTH-SUMMARY/);
  assert.match(content, /FRESH-19/); assert.doesNotMatch(content, /OLD-MONTH/);
  assert(Buffer.byteLength(content) <= f.config.contextTokens * 4);
  assert.equal(p.codex.pending.length, 0);
});

test('a month-unopened mirror receives a compact snapshot, retries it, acknowledges it, then resumes deltas', async t => {
  const f = await fixture(t); f.config.contextTokens = 800;
  await fs.writeFile(f.file, jsonl([c(f.id, 'INITIAL-SEED')])); await hook('claude', f.input(), f.config, opts);
  let p = await f.pair();
  await f.append(f.file, [...Array.from({ length: 100 }, (_, n) => c(f.id, `STALE-${n}`)),
    { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), sessionId: f.id },
    c(f.id, 'MONTH-SUMMARY', { isCompactSummary: true }),
    ...Array.from({ length: 30 }, (_, n) => c(f.id, `RECENT-${n} ` + 'x'.repeat(150)))]);
  await hook('claude', f.input(), f.config, opts);
  p = await f.pair(); assert.equal(p.codex.pending.length, 0); assert(p.codex.snapshot);
  const input = f.input('codex', p.codex, 'SessionStart');
  const output = await hook('codex', input, f.config, opts), text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /MONTH-SUMMARY/); assert.match(text, /RECENT-29/); assert.doesNotMatch(text, /STALE-|INITIAL-SEED/);
  assert(Buffer.byteLength(text) <= f.config.contextTokens * 4);
  const prompt = f.input('codex', p.codex, 'UserPromptSubmit');
  assert.deepEqual(await hook('codex', prompt, f.config, opts), { hookSpecificOutput: { ...output.hookSpecificOutput, hookEventName: 'UserPromptSubmit' } });
  await f.append(p.codex.file, [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } }]);
  assert.equal(await hook('codex', prompt, f.config, opts), null);
  await f.append(f.file, [c(f.id, 'JUST-A-DELTA')]); await hook('claude', f.input(), f.config, opts);
  const delta = (await hook('codex', prompt, f.config, opts)).hookSpecificOutput.additionalContext;
  assert.match(delta, /JUST-A-DELTA/); assert.doesNotMatch(delta, /MONTH-SUMMARY|RECENT-/);
});

test('backlog overflow without compaction switches to the latest bounded context with an omission note', async t => {
  const f = await fixture(t); f.config.contextTokens = 600;
  await fs.writeFile(f.file, jsonl([c(f.id, 'SEED')])); await hook('claude', f.input(), f.config, opts);
  const p = await f.pair();
  await f.append(f.file, Array.from({ length: 30 }, (_, n) => c(f.id, `OVERFLOW-${n} ` + 'x'.repeat(300))));
  const output = await hook('codex', f.input('codex', p.codex, 'UserPromptSubmit'), f.config, opts);
  const text = output.hookSpecificOutput.additionalContext;
  assert.match(text, /Earlier context omitted/); assert.match(text, /OVERFLOW-29/); assert.doesNotMatch(text, /OVERFLOW-0 /);
  assert(Buffer.byteLength(text) <= f.config.contextTokens * 4);
});

test('Codex compacted records in the same file replace older context for seeds and later delivery', async t => {
  for (const type of ['compacted', 'response_item']) {
    const f = await fixture(t); f.config.contextTokens = 600;
    const id = randomUUID(), file = path.join(f.config.codexSessionsDir, id + '.jsonl');
    const compact = { type, payload: { ...(type === 'response_item' ? { type: 'compacted' } : {}), replacement_history: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE-INSTRUCTIONS' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CODEX-SUMMARY' }] }
    ] } };
    await fs.mkdir(f.config.codexSessionsDir, { recursive: true });
    await fs.writeFile(file, jsonl([{ type: 'session_meta', payload: { id, cwd: f.config.cwd, source: 'cli', originator: 'codex-tui' } }, x('OLD-CODEX'), compact, x('FRESH-CODEX')]));
    const input = f.input('codex', { id, file }); await hook('codex', input, f.config, opts);
    const p = await f.pair(), seed = await fs.readFile(p.claude.file, 'utf8');
    assert.match(seed, /CODEX-SUMMARY/); assert.match(seed, /FRESH-CODEX/); assert.doesNotMatch(seed, /OLD-CODEX|PRIVATE-INSTRUCTIONS/);
    await f.append(file, [{ ...compact, payload: { ...compact.payload, replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECOND-CODEX-SUMMARY' }] }] } }, x('LATEST-CODEX')]);
    const output = await hook('claude', f.input('claude', p.claude, 'SessionStart'), f.config, opts);
    const text = output.hookSpecificOutput.additionalContext;
    assert.match(text, /SECOND-CODEX-SUMMARY/); assert.match(text, /LATEST-CODEX/); assert.doesNotMatch(text, /FRESH-CODEX/);
    assert(Buffer.byteLength(text) <= f.config.contextTokens * 4);
  }
});

test('large snapshots and single large deltas fit each client cap, acknowledge all chunks and terminate', async t => {
  const { LIMITS } = require('../src/sync/delivery');
  for (const target of ['claude', 'codex']) {
    const f = await fixture(t);
    await fs.writeFile(f.file, jsonl([c(f.id, 'initial seed')])); await hook('claude', f.input(), f.config, opts);
    const p = await f.pair(), source = target === 'codex' ? p.claude : p.codex;
    const summary = 'SUMMARY-BEGIN ' + 'ю😀'.repeat(24000) + ' SUMMARY-END';
    if (target === 'codex') await f.append(source.file, [
      { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), sessionId: source.id },
      c(source.id, summary, { isCompactSummary: true }), c(source.id, 'FRESH-END')
    ]);
    else await f.append(source.file, [{ type: 'compacted', payload: { message: summary, replacement_history: [] } }, x('FRESH-END')]);
    const input = f.input(target, p[target], 'UserPromptSubmit');
    let output = await hook(target, input, f.config, opts), joined = '', chunks = 0;
    while (output) {
      const text = output.hookSpecificOutput.additionalContext;
      assert(text.startsWith('[session-sync:v2:'));
      assert(Buffer.byteLength(text) <= LIMITS[target]); assert(text.length <= (target === 'claude' ? 10000 : 64000));
      assert(!text.includes('\uFFFD')); joined += text;
      assert.deepEqual(await hook(target, input, f.config, opts), output, 'unacknowledged chunk must retry unchanged');
      await f.append(p[target].file, target === 'claude' ? [c(p[target].id, text, { isMeta: true })]
        : [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } }]);
      output = await hook(target, input, f.config, opts);
      assert(++chunks < 40, 'snapshot must finish rather than loop');
    }
    assert(chunks > 1); assert.match(joined, /SUMMARY-BEGIN/); assert.match(joined, /FRESH-END/);
    assert.equal((await f.pair())[target].snapshot, null);
    // A delta can exceed the per-hook cap while remaining below the active-context budget.
    const delta = 'DELTA-BEGIN ' + 'a'.repeat(90000) + ' DELTA-END';
    await f.append(source.file, target === 'codex' ? [c(source.id, delta)] : [x(delta)]);
    output = await hook(target, input, f.config, opts); joined = ''; chunks = 0;
    while (output) {
      const text = output.hookSpecificOutput.additionalContext; assert(Buffer.byteLength(text) <= LIMITS[target]); joined += text;
      await f.append(p[target].file, target === 'claude' ? [c(p[target].id, text, { isMeta: true })]
        : [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } }]);
      output = await hook(target, input, f.config, opts); assert(++chunks < 25);
    }
    assert(chunks > 1); assert.match(joined, /DELTA-BEGIN/); assert.match(joined, /DELTA-END/);
  }
});

test('busy locks exit silently; stale locks recover and an old owner cannot remove a newer lease', async t => {
  const f = await fixture(t), { acquire, TIMEOUT } = require('../src/sync/lease');
  await fs.writeFile(f.file, jsonl([c(f.id, 'hello')])); await hook('claude', f.input(), f.config, opts);
  const file = path.join(f.config.stateDir, 'lock');
  const release = acquire(f.config.stateDir); const lock = JSON.parse(await fs.readFile(file));
  assert.equal(lock.pid, process.pid); assert(lock.startedAt); assert(lock.token);
  assert.equal(await hook('claude', f.input(), f.config, opts), null);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/agents/sync.js'), 'hook', 'claude'], {
    env: { ...process.env, ...f.env }, input: JSON.stringify(f.input()), encoding: 'utf8'
  });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  const old = new Date(Date.now() - TIMEOUT - 1000); await fs.utimes(file, old, old);
  const newer = acquire(f.config.stateDir); assert.equal(typeof newer, 'function');
  release(); assert((await fs.stat(file)).isFile()); newer();
  await fs.writeFile(file, JSON.stringify({ pid: 999999, startedAt: +old, token: 'killed-hook' })); await fs.utimes(file, old, old);
  await hook('claude', f.input(), f.config, opts); await assert.rejects(fs.stat(file), /ENOENT/);
});

test('checkpoint keys stay bounded, unchanged hooks do not rewrite it, and reset dedup uses the archive', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, jsonl(Array.from({ length: 500 }, (_, n) => c(f.id, `event-${n}`))));
  await hook('claude', f.input(), f.config, opts);
  const p = await f.pair(); assert(p.known.length <= 256);
  const file = path.join(f.config.stateDir, `${p.id}.json`);
  await hook('claude', f.input(), f.config, opts); const before = await fs.stat(file);
  await hook('claude', f.input(), f.config, opts); assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  const replaced = f.file + '.replacement'; await fs.copyFile(f.file, replaced); await fs.rename(replaced, f.file);
  await hook('claude', f.input(), f.config, opts);
  const after = await f.pair(); assert(after.known.length <= 256); assert.equal(after.codex.pending.length, 0);
});

test('denied sessions use a bounded decision file and old legacy decision files are pruned', async t => {
  const f = await fixture(t), { remember } = require('../src/sync/process-cache');
  const state = { entries: {} };
  for (let n = 0; n < 300; n++) remember(state, `id-${n}`, { file: f.file, cliIdentity: String(n) });
  assert.equal(Object.keys(state.entries).length, 128);
  await fs.mkdir(f.config.stateDir, { recursive: true });
  const old = path.join(f.config.stateDir, `claude-${'a'.repeat(64)}.decision.json`);
  await fs.writeFile(old, '{}'); const date = new Date(Date.now() - 8 * 86400000); await fs.utimes(old, date, date);
  await fs.writeFile(f.file, jsonl([c(f.id, 'denied')]));
  let probes = 0;
  const denied = { env: {}, cliIdentity: 'denied-cli', interactive: async () => { probes++; return false; } };
  await hook('claude', f.input('claude', undefined, 'SessionStart'), f.config, denied);
  await hook('claude', f.input('claude', undefined, 'SessionStart'), f.config, denied);
  assert.equal(probes, 1); await assert.rejects(fs.stat(old), /ENOENT/);
  const decisions = JSON.parse(await fs.readFile(path.join(f.config.stateDir, 'decisions.json'))); assert.equal(Object.keys(decisions.entries).length, 1);
});

test('SessionStart reuses the CLI pid/start identity and probes again only when it changes', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, jsonl([c(f.id, 'hello')]));
  let probes = 0;
  const options = { env: {}, cliIdentity: 'pid:123-start:one', interactive: async () => { probes++; return true; } };
  const input = f.input('claude', undefined, 'SessionStart');
  await hook('claude', input, f.config, options); await hook('claude', input, f.config, options); assert.equal(probes, 1);
  await hook('claude', input, f.config, { ...options, cliIdentity: 'pid:123-start:two' }); assert.equal(probes, 2);
  const { identity } = require('../src/sync/process-cache');
  assert.equal(await identity('codex', { platform: 'win32', run: async exe => {
    assert.equal(exe, 'cscript.exe'); return { stdout: JSON.stringify([{ pid: 12, start: 'birth', name: 'codex.exe', command: 'codex.exe' }]) };
  } }), '12:birth');
  assert.equal(await identity('codex', { platform: 'linux', pid: 2, run: async exe => {
    assert.equal(exe, 'ps'); return { stdout: '2 12 Fri Oct 30 10:00:00 2026 node node /app/sync.js\n12 1 Fri Oct 30 09:00:00 2026 codex codex\n' };
  } }), '12:Fri Oct 30 09:00:00 2026');
});

test('mirror versions come from source/latest client sessions, with cached --version fallback', async t => {
  const f = await fixture(t); delete f.config.versions;
  await fs.mkdir(f.config.codexSessionsDir, { recursive: true });
  await fs.writeFile(path.join(f.config.codexSessionsDir, 'version-source.jsonl'), jsonl([{ type: 'session_meta', payload: { cli_version: '9.8.7' } }]));
  await fs.writeFile(f.file, jsonl([c(f.id, 'hello', { version: '6.5.4' })]));
  await hook('claude', f.input(), f.config, opts); const p = await f.pair();
  assert.equal(JSON.parse((await fs.readFile(p.codex.file, 'utf8')).split('\n')[0]).payload.cli_version, '9.8.7');
  const { version } = require('../src/sync/versions');
  assert.equal(await version('claude', f.config, p), '6.5.4');
  await fs.rm(f.config.codexSessionsDir, { recursive: true, force: true });
  await fs.unlink(path.join(f.config.stateDir, 'versions.json'));
  let calls = 0;
  const result = await version('codex', f.config, {}, { run: async (exe, args) => { calls++; assert.equal(exe, 'codex'); assert.deepEqual(args, ['--version']); return { stdout: 'codex-cli 8.7.6' }; } });
  result.cache.codex = { value: result.value, at: Date.now() }; await fs.writeFile(result.file, JSON.stringify(result.cache));
  assert.equal(await version('codex', f.config, {}, { run: () => { throw Error('must use version cache'); } }), '8.7.6'); assert.equal(calls, 1);
});
