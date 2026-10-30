#!/usr/bin/env node
'use strict';
// Manual UI check: only a newly-created temporary home; no credentials or real sessions are copied.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { configuration, hook } = require('../../src/sync');
const { slug } = require('../../src/sync/activation');
const { connectProxy } = require('../../src/agents/codex-client');
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
async function main() {
  if (process.argv.includes('--help')) { console.log('node scripts/agents/demo-sync.js — create isolated demos in both directions; retain the temp home for manual inspection. No real auth/model requests.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-kit-sync-demo-'));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
    ANTHROPIC_AUTH_TOKEN: 'isolated-demo-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
  delete env.SESSION_SYNC_BROKER; delete env.SESSION_SYNC_EXCLUDE;
  const config = configuration(path.join(root, 'project'), env);
  await fs.mkdir(config.cwd, { recursive: true });
  await fs.mkdir(path.join(config.claudeProjectsDir, slug(config.cwd)), { recursive: true });
  await fs.mkdir(config.codexSessionsDir, { recursive: true });
  await fs.writeFile(path.join(config.codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "demo"\n[model_providers.demo]\nname = "Isolated offline demo"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(config.cwd)}]\ntrust_level = "trusted"\n`);
  // Dedicated stdio server honours this temp home; never proxy into the user's shared daemon.
  config.connectCodex = options => connectProxy({ ...options, env, mode: 'stdio', timeout: 5000 });
  const getVersion = async exe => (await promisify(execFile)(exe, ['--version'], { env, windowsHide: true, timeout: 5000 })).stdout.match(/\d+\.\d+\.\d+/)?.[0] || 'unknown';
  const claudeVersion = await getVersion('claude'), codexVersion = await getVersion(env.AGENT_BROKER_CODEX || 'codex');
  config.versions = { claude: claudeVersion };
  const claudeId = randomUUID(), codexId = randomUUID(), stamp = new Date().toISOString();
  const claudeFile = path.join(config.claudeProjectsDir, slug(config.cwd), `${claudeId}.jsonl`);
  const codexFile = path.join(config.codexSessionsDir, `rollout-demo-${codexId}.jsonl`);
  const message = (type, content, extra = {}) => ({ type, uuid: randomUUID(), sessionId: claudeId, cwd: config.cwd, version: claudeVersion, timestamp: stamp,
    message: { role: type, ...(type === 'assistant' ? { model: 'demo-claude', type: 'message', id: randomUUID(), stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } : {}), content }, ...extra });
  const example = path.join(config.cwd, 'example.txt');
  const rows = [message('user', 'Run a greeting, edit example.txt, then read it.'),
    message('user', '<bash-input>echo manual</bash-input>'),
    message('user', '<bash-stdout>manual</bash-stdout><bash-stderr></bash-stderr>'),
    message('assistant', [{ type: 'tool_use', id: 'demo-bash', name: 'Bash', input: { command: 'echo demo' } }]),
    message('user', [{ type: 'tool_result', tool_use_id: 'demo-bash', content: 'demo' }], { toolUseResult: { stdout: 'demo', stderr: '', exitCode: 0, durationMs: 15 } }),
    message('assistant', [{ type: 'tool_use', id: 'demo-edit', name: 'Edit', input: { file_path: example, old_string: 'Hello', new_string: 'Hi' } }]),
    message('user', [{ type: 'tool_result', tool_use_id: 'demo-edit', content: 'Edited example.txt' }]),
    message('assistant', [{ type: 'tool_use', id: 'demo-read', name: 'Read', input: { file_path: example } }]),
    message('user', [{ type: 'tool_result', tool_use_id: 'demo-read', content: 'Hi from the isolated demo.' }]),
    ...[
      ['TodoWrite', { todos: [{ content: 'Run checks', status: 'completed' }] }, 'Checklist updated.'],
      ['WebSearch', { query: 'demo documentation' }, 'Search complete.'],
      ['WebFetch', { url: 'https://example.com' }, 'Page fetched.'],
      ['Monitor', {}, 'Monitor started (task RAW_MONITOR, expires in 30m)'],
      ['TaskOutput', {}, 'PRIVATE_TASK_RAW\n' + 'x'.repeat(5000)],
      ['ToolSearch', { query: 'Read' }, 'Large raw schema omitted.'],
      ['mcp__demo__query', {}, 'Large external result omitted.'],
    ].flatMap(([name, input, output], n) => [
      message('assistant', [{ type: 'tool_use', id: 'extra-' + n, name, input }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'extra-' + n, content: output }]),
    ]),
    message('assistant', [{ type: 'text', text: 'Greeting ran, file edited and read successfully.' }]),
    { type: 'custom-title', sessionId: claudeId, customTitle: 'Demo from Claude' }];
  for (let n = 0; n < rows.length; n++) if (rows[n].uuid) rows[n].parentUuid = n ? rows[n - 1].uuid || null : null;
  await fs.writeFile(claudeFile, jsonl(rows));
  await fs.writeFile(path.join(config.cwd, 'example.txt'), 'Hi from the isolated demo.\n');
  const input = (id, file) => ({ session_id: id, transcript_path: file, cwd: config.cwd, hook_event_name: 'Stop' });
  await hook('claude', input(claudeId, claudeFile), config, { env, interactive: async () => true });
  const model = 'demo-codex';
  await fs.writeFile(codexFile, jsonl([
    { type: 'session_meta', payload: { id: codexId, cwd: config.cwd, source: 'cli', originator: 'codex-tui', cli_version: codexVersion } },
    { type: 'turn_context', payload: { model } },
    { type: 'response_item', payload: { type: 'message', id: 'demo-question', role: 'user', content: [{ type: 'input_text', text: 'Inspect example.txt and summarize it.' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'demo-user-shell', role: 'user', content: [{ type: 'input_text', text: '<user_shell_command>\n<command>\necho manual\n</command>\n<result>\nExit code: 0\nDuration: 0.0100 seconds\nOutput:\nmanual\n</result>\n</user_shell_command>' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['shell.user_command'] } } },
    { type: 'response_item', payload: { type: 'function_call', id: 'demo-bash', call_id: 'demo-bash', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo demo' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'demo-bash', output: 'Wall time: 0.01 seconds\nProcess exited with code 0\nFinal output:\ndemo' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'demo-edit', call_id: 'demo-edit', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: ' + example + '\n@@\n-Hello\n+Hi\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'demo-edit', output: 'Success. Updated example.txt.' } },
    { type: 'response_item', payload: { type: 'function_call', id: 'demo-read', call_id: 'demo-read', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat example.txt' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'demo-read', output: 'Hi from the isolated demo.' } },
    { type: 'response_item', payload: { type: 'function_call', id: 'plan', call_id: 'plan', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Run checks', status: 'completed' }] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'plan', output: 'Plan updated.' } },
    { type: 'response_item', payload: { id: 'web', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'demo documentation' } } },
    { type: 'response_item', payload: { type: 'message', id: 'demo-answer', role: 'assistant', content: [{ type: 'output_text', text: 'The file contains a short greeting.' }] } }
  ]));
  await fs.appendFile(path.join(config.codexHome, 'session_index.jsonl'), jsonl([{ id: codexId, thread_name: 'Demo from Codex', updated_at: stamp }]));
  await hook('codex', input(codexId, codexFile), config, { env, interactive: async () => true });
  const registry = JSON.parse(await fs.readFile(path.join(config.stateDir, 'pairs.json'), 'utf8'));
  const pairs = await Promise.all(registry.pairs.map(async p => JSON.parse(await fs.readFile(path.join(config.stateDir, `${p.id}.json`)))));
  const c = pairs.find(p => p.claude.id === claudeId), x = pairs.find(p => p.codex.id === codexId);
  if (!c?.codex.seeded || !x?.claude.seeded) throw Error(`Demo not ready. Inspect ${path.join(config.stateDir, 'sync.log')}; isolated home retained: ${root}`);
  const claudeRows = (await fs.readFile(x.claude.file, 'utf8')).trim().split('\n').map(JSON.parse);
  const uses = claudeRows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content.filter(b => b.type === 'tool_use') : []);
  const results = claudeRows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content.filter(b => b.type === 'tool_result') : []);
  if (uses.map(tool => tool.name).join(',') !== 'Bash,Edit,Bash,TodoWrite,WebSearch' || uses.some(tool => results.filter(result => result.tool_use_id === tool.id).length !== 1)) throw Error('Claude native tool pairs are invalid');
  if (!claudeRows.some(row => row.message?.content === '<bash-input>echo manual</bash-input>')
    || !claudeRows.some(row => row.message?.content === '<bash-stdout>manual</bash-stdout><bash-stderr></bash-stderr>')) throw Error('Claude bash-mode records missing');
  console.log('Claude transcript structure verified: Bash/Edit/Read, TodoWrite/WebSearch and paired results.');
  const inspector = config.connectCodex({});
  try {
    await inspector.ready;
    await inspector.request('initialize', { clientInfo: { name: 'agent-kit-demo-inspector', version: '1' }, capabilities: { experimentalApi: true } }); inspector.notify('initialized', {});
    const resumed = await inspector.request('thread/resume', { threadId: c.codex.id });
    const items = resumed.thread.turns.flatMap(turn => turn.items);
    if (!items.some(item => item.type === 'userMessage') || !items.some(item => item.type === 'agentMessage')) throw Error('Native resume did not render imported UI items');
    if (!items.some(item => item.type === 'commandExecution') || !items.some(item => item.type === 'fileChange')) throw Error('Native tool items missing');
    if (!items.some(item => item.type === 'commandExecution' && item.source === 'userShell')) throw Error('Native user-shell item missing');
    if (!items.some(item => item.type === 'commandExecution' && item.commandActions?.some(action => action.type === 'read'))
      || !JSON.stringify(items.find(item => item.type === 'fileChange')).includes('-Hello')) throw Error('Native exploration/diff data missing');
    if (!items.some(item => item.type === 'plan') || !items.some(item => item.type === 'webSearch') || /RAW_MONITOR|PRIVATE_TASK_RAW/.test(JSON.stringify(items))) throw Error('Native plan/web or summary validation failed');
    console.log(`Native app-server resume verified: ${items.map(item => item.type).join(', ')}.`);
    console.log('Expected Codex: You ran echo manual; Ran echo demo; Edited example.txt (-Hello/+Hi); Explored / Read example.txt.');
    console.log('Expected Claude: native bash-mode echo manual/output; Bash echo demo; Edit example.txt; Bash cat example.txt, all completed.');
  } finally { inspector.close(); }
  console.log(`Isolated demo retained: ${root}\nNo auth copied. Provider is loopback-only; do not expect real model replies.`);
  const quote = text => "'" + text.replaceAll("'", "''") + "'";
  console.log(`PowerShell — Codex:\n$env:CODEX_HOME=${quote(config.codexHome)}; Set-Location ${quote(config.cwd)}; codex resume ${c.codex.id}`);
  console.log(`PowerShell — Claude:\n$env:CLAUDE_CONFIG_DIR=${quote(config.claudeHome)}; $env:ANTHROPIC_AUTH_TOKEN='isolated-demo-only'; $env:ANTHROPIC_BASE_URL='http://127.0.0.1:9'; Set-Location ${quote(config.cwd)}; claude --resume ${x.claude.id}`);
  console.log('Inspect: title, user/assistant text, imported tools. Native ctx/quotas require a real model turn and are not fabricated by this demo.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
