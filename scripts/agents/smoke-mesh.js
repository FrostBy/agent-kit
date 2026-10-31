#!/usr/bin/env node
'use strict';
// Opt-in real CLIs with loopback models and fresh homes. Never copy account credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { connectProxy } = require('../../src/agents/codex-client');
const { connectInteractive } = require('../../src/agents/interactive-client');
const { connectOwner } = require('../../src/agents/mesh-owner');
const { readEvents } = require('../../src/agents/mesh');
const run = promisify(execFile), delay = ms => new Promise(r => setTimeout(r, ms));
const broker = path.resolve(__dirname, 'broker.js');
async function main() {
  if (!process.argv.includes('--live')) { console.log('smoke-mesh.js --live [--only kimi|claude|codex|web|claude-kimi]; set AGENT_BROKER_CODEX/KIMI/CLAUDE to executable paths if needed. Uses no real accounts.'); return; }
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const scratch = path.resolve(__dirname, '../../.native'); fs.mkdirSync(scratch, { recursive: true });
  // Windows AF_UNIX paths must fit SUN_LEN, including app-server-control.sock.
  const root = fs.mkdtempSync(path.join(scratch, 'mesh-'));
  console.log(`Artifacts: ${root}`);
  fs.writeFileSync(path.join(root, 'runner.pid'), String(process.pid));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'AGENT_BROKER_CODEX', 'AGENT_BROKER_KIMI', 'AGENT_BROKER_CLAUDE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'local'),
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), KIMI_CODE_HOME: path.join(root, 'kimi'),
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', BROKER_POLL_MS: '50',
    ANTHROPIC_API_KEY: 'isolated-loopback-only', CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe' });
  const project = path.join(root, 'project');
  for (const dir of [project, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.KIMI_CODE_HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: false }));
  const reports = {}, processes = new Set(), stateDirs = new Set(), requests = [], pendingHttp = new Set();
  let orchestratorPlan, holdCodex = false, releaseCodex;
  const launch = (exe, args, extra = {}) => {
    const child = spawn(exe, args, { env, cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...extra });
    processes.add(child); child.on('exit', () => { processes.delete(child); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
    child.on('error', e => { child.launchError = e; });
    child.stderr.on('data', d => fs.appendFileSync(path.join(root, 'children.log'), String(d)));
    child.stdout.on('data', d => fs.appendFileSync(path.join(root, 'children.stdout.log'), String(d)));
    return child;
  };
  const wait = async (predicate, label, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) { const value = await predicate(); if (value) return value; if (Date.now() >= end) throw Error(`Timeout: ${label}`); await delay(50); }
  };
  function anthropic(res, content, model) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    content.forEach((block, index) => {
      send('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
      send('content_block_stop', { index });
    });
    send('message_delta', { delta: { stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    send('message_stop', {}); res.end();
  }
  const tool = (name, input) => ({ type: 'tool_use', id: 'tool_' + randomUUID(), name, input });
  const question = [{ question: 'Choose a route', header: 'Route', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }], multiSelect: false }];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (req.url.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":10}'); return; }
    let data; try { data = JSON.parse(body || '{}'); } catch { res.writeHead(400).end(); return; }
    requests.push({ url: req.url, model: data.model, tools: (data.tools || []).map(t => t.name), questionSchema: data.tools?.find(t => t.name === 'AskUserQuestion')?.input_schema, messages: data.messages || data.input });
    fs.writeFileSync(path.join(root, 'provider-requests.json'), JSON.stringify(requests, null, 2));
    if (req.url.includes('responses')) {
      if (holdCodex) { holdCodex = false; await new Promise(resolve => { releaseCodex = resolve; }); }
      const id = 'resp_' + randomUUID(), item = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'mesh-owner-awake', annotations: [] }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      send('response.created', { response: { id, status: 'in_progress', output: [] } });
      send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'mesh-owner-awake' });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
      res.end(); return;
    }
    const messages = data.messages || [];
    const last = messages.findLast(m => m.role === 'user');
    const value = typeof last?.content === 'string' ? last.content : (last?.content || []).filter(c => c.type === 'text' && !c.text.startsWith('<system-reminder>')).at(-1)?.text || '';
    if (value.includes('MESH_HANG')) { pendingHttp.add(res); res.on('close', () => pendingHttp.delete(res)); return; }
    let content = [{ type: 'text', text: 'mesh-pong' }];
    if (!Array.isArray(last?.content) || !last.content.some(c => c.type === 'tool_result')) {
      if (value.includes('MESH_QUESTION')) content = [tool('AskUserQuestion', { questions: question.map(q => req.url.includes('/kimi/') ? { question: q.question, header: q.header, options: q.options } : q) })];
      else if (value.includes('MESH_PERMISSION')) content = [tool('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'should-not-exist.txt\',\'unexpected\')"', description: 'Isolated mesh permission probe' })];
    }
    if (req.url.includes('/claude/') && orchestratorPlan && !orchestratorPlan.sent &&
      (value.includes('MESH_ORCHESTRATOR') || (last?.content || []).some?.(c => c.type === 'tool_result'))) {
      const sawRequest = JSON.stringify(last.content).includes(orchestratorPlan.requestId);
      if (sawRequest) orchestratorPlan.sent = true;
      content = [tool('Bash', { command: sawRequest ? orchestratorPlan.reply : orchestratorPlan.read, description: 'Read or answer the isolated mesh event' })];
    }
    anthropic(res, content, data.model);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  env.ANTHROPIC_BASE_URL = `${url}/claude`;
  fs.writeFileSync(path.join(env.KIMI_CODE_HOME, 'config.toml'), `default_model = "fake"\ndefault_permission_mode = "manual"\ntelemetry = false\nauto_session_title = false\nmerge_all_available_skills = false\n[providers.loopback]\ntype = "anthropic"\nbase_url = "${url}/kimi"\napi_key = "isolated-loopback-only"\n[models.fake]\nprovider = "loopback"\nmodel = "claude-sonnet-4-5"\nmax_context_size = 200000\ncapabilities = ["tool_use"]\n[thinking]\nenabled = false\n`);
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "mesh-fake"\nmodel_provider = "loopback"\n[model_providers.loopback]\nname = "Isolated loopback"\nbase_url = "${url}/codex"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`);
  async function probe(name, fn) {
    if (only && only !== name) return;
    try { reports[name] = { status: 'passed', ...(await fn()) }; }
    catch (e) { reports[name] = { status: 'failed', reason: e.message }; process.exitCode = 1; }
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(reports, null, 2)); console.log(name, JSON.stringify(reports[name]));
  }
  const cli = async (args, extra = {}) => (await run(process.execPath, [broker, ...args], { env, cwd: project, windowsHide: true, timeout: 35000, ...extra })).stdout;
  async function agentProbe(agent, responder) {
    const stateDir = fs.mkdtempSync(path.join(root, agent + '-')); 
    stateDirs.add(stateDir);
    const base = path.join(stateDir, 'worker'), prompt = path.join(root, agent + '.txt'); fs.writeFileSync(prompt, 'MESH_QUESTION');
    const proc = launch(process.execPath, [broker, '--agent', agent, '--name', 'worker', '--state', stateDir, '--prompt', prompt, '--cwd', project]);
    const state = () => { try { return JSON.parse(fs.readFileSync(`${base}.state.json`)); } catch { return {}; } };
    const event = type => wait(() => {
      if (proc.launchError) throw proc.launchError;
      const events = readEvents(`${base}.events.jsonl`);
      const err = events.find(e => e.type === 'error'); if (err) throw Error(err.summary);
      return events.findLast(e => e.type === type);
    }, `${agent} ${type}`);
    const target = ['--name', 'worker', '--state', stateDir];
    const respond = async (type, e) => responder ? responder(type, e, target) : cli([type, ...target, '--request', e.requestId, ...(type === 'answer' ? ['--text', 'A'] : [])]);
    const q = await event('question'); await respond('answer', q);
    await wait(() => state().turns === 1, 'question completion');
    const send = cli(['send', ...target, '--text', 'MESH_PERMISSION']);
    const a = await event('approval'); await respond('deny', a); await send;
    if (fs.existsSync(path.join(project, 'should-not-exist.txt'))) throw Error('Denied tool ran');
    if (agent === 'kimi') {
      const approvalCount = readEvents(`${base}.events.jsonl`).filter(e => e.type === 'approval').length;
      const next = cli(['send', ...target, '--text', 'MESH_PERMISSION']);
      const approval = await wait(() => { const entries = readEvents(`${base}.events.jsonl`).filter(e => e.type === 'approval'); return entries.length > approvalCount && entries.at(-1); }, 'second permission');
      await respond('approve', approval); await next;
      if (!fs.existsSync(path.join(project, 'should-not-exist.txt'))) throw Error('Approved tool did not run');
      fs.unlinkSync(path.join(project, 'should-not-exist.txt'));
    }
    const hang = cli(['send', ...target, '--text', 'MESH_HANG']).catch(e => e);
    await wait(() => state().status === 'running', 'running before cancel');
    await cli(['interrupt', ...target]); await hang;
    const session = state().sessionId; if (!session) throw Error('No persisted session ID');
    await cli(['send', ...target, '--text', '/exit']); await wait(() => proc.exitCode !== null, 'agent exit');
    const result = await cli(['send', ...target, '--text', 'resurrect']);
    if (state().sessionId !== session || !result.includes('mesh-pong')) throw Error('Resurrection did not preserve session/reply');
    await cli(['send', ...target, '--text', '/exit']);
    return { question: true, deny: true, ...(agent === 'kimi' ? { approve: true } : {}), interrupt: true, resurrection: true, sessionId: session };
  }
  try {
    await probe('kimi', () => agentProbe('kimi'));
    await probe('claude', () => agentProbe('claude'));
    await probe('codex', async () => {
      const exe = env.AGENT_BROKER_CODEX || 'codex';
    await run(exe, ['app-server', 'daemon', 'start'], { env, windowsHide: true, timeout: 20000 });
      let reply = false, ownerId;
      const conn = connectProxy({ env, timeout: 10000, onNotification: msg => { if (msg.method === 'item/completed' && msg.params?.threadId === ownerId && msg.params?.item?.text?.includes('mesh-owner-awake')) reply = true; } });
      try {
        await conn.ready; await conn.request('initialize', { clientInfo: { name: 'mesh-live', version: '1' } }); conn.notify('initialized', {});
        const { thread } = await conn.request('thread/start', { cwd: project, approvalPolicy: 'never', sandbox: 'read-only' });
        ownerId = thread.id;
        await conn.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Initial isolated orchestrator turn', text_elements: [] }] });
        await wait(() => reply, 'initial owner turn'); reply = false;
        let error;
        const ownerCalls = [];
        const owner = connectOwner({ owner: { agent: 'codex', id: thread.id }, env, onError: e => { error = e; }, connect(options) {
          const c = connectProxy(options), request = c.request.bind(c);
          c.request = (method, ...args) => { ownerCalls.push(method); return request(method, ...args); }; return c;
        } });
        try {
          await owner.ready;
          await owner.deliver({ id: 'live-' + randomUUID(), from: 'worker', type: 'turn.completed', summary: 'Agent done', payload: {} }, root);
          if (error) throw error;
          await wait(() => reply, 'owner wake completion');
          reply = false;
          holdCodex = true;
          await conn.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Hold the active turn', text_elements: [] }] });
          await wait(() => releaseCodex, 'active model request');
          await owner.deliver({ id: 'busy-' + randomUUID(), from: 'worker', type: 'turn.completed', summary: 'Busy wake', payload: {} }, root);
          if (error) throw error;
          if (!ownerCalls.includes('turn/steer')) throw Error('Busy owner did not receive turn/steer');
          releaseCodex(); releaseCodex = null;
          await wait(() => reply, 'steered owner completes'); reply = false;
          const stateDir = fs.mkdtempSync(path.join(root, 'codex-owner-agent-')); stateDirs.add(stateDir);
          const prompt = path.join(stateDir, 'prompt.txt'); fs.writeFileSync(prompt, 'Reply once');
          launch(process.execPath, [broker, '--agent', 'codex', '--name', 'worker', '--state', stateDir, '--prompt', prompt, '--cwd', project], { env: { ...env, CODEX_THREAD_ID: thread.id } });
          await wait(() => reply, 'actual broker event wakes owner');
          const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'worker.state.json')));
          if (s.owner !== thread.id || s.orchestrator?.id !== thread.id || !s.turns) throw Error('Broker did not capture owner or finish agent turn');
          await cli(['send', '--name', 'worker', '--state', stateDir, '--text', '/exit']);
          return { daemon: true, loopback: true, eventStartsTurn: true, busySteer: true, actualBrokerOwnerEnv: true };
        } finally { owner.close(); await conn.request('thread/archive', { threadId: thread.id }).catch(() => {}); }
      } finally { conn.close(); await run(exe, ['app-server', 'daemon', 'stop'], { env, windowsHide: true, timeout: 10000 }); }
    });
    await probe('web', async () => {
      // The server is private to this test, so disabling its HTTP bearer gate needs no account.
      const portProbe = require('node:net').createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
      const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
      const child = launch(env.AGENT_BROKER_KIMI || 'kimi', ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port), '--dangerous-bypass-auth']);
      const webUrl = `http://127.0.0.1:${port}`;
      try {
        await wait(async () => { if (child.exitCode !== null) throw Error('kimi web exited; see children.log'); try { return (await fetch(webUrl + '/api/v1/healthz')).ok; } catch { return false; } }, 'kimi web startup');
        const response = await fetch(webUrl + '/api/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: { cwd: project } }) });
        const session = (await response.json()).data; if (!session?.id) throw Error('No web session');
        const profile = await fetch(`${webUrl}/api/v1/sessions/${session.id}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_config: { model: 'fake' } }) });
        if ((await profile.json()).code !== 0) throw Error('Could not bind the loopback model to the web session');
        let error;
        const owner = connectOwner({ owner: { agent: 'kimi', id: session.id, url: webUrl }, env, onError: e => { error = e; } });
        try {
          await owner.ready; await owner.deliver({ id: 'web-' + randomUUID(), from: 'worker', type: 'turn.completed', summary: 'Wake', payload: {} }, root); if (error) throw error;
          await wait(async () => {
            const snapshot = await fetch(`${webUrl}/api/v1/sessions/${session.id}/snapshot`); fs.writeFileSync(path.join(root, 'web-snapshot.json'), JSON.stringify(await snapshot.json(), null, 2));
            const response = await fetch(`${webUrl}/api/v1/sessions/${session.id}/messages`); const data = (await response.json()).data;
            fs.writeFileSync(path.join(root, 'web-messages.json'), JSON.stringify(data, null, 2));
            return JSON.stringify(data).includes('mesh-pong');
          }, 'kimi web owner reply');
          return { serverOwned: true, eventPrompt: true, loopback: true };
        } finally { owner.close(); }
      } finally { await fetch(webUrl + '/api/v1/shutdown', { method: 'POST' }).catch(() => {}); child.kill(); }
    });
    await probe('claude-kimi', async () => {
      let orchestrator;
      try {
        orchestrator = connectInteractive({ agent: 'claude', env, cwd: project, onRequest: msg => {
          if (msg.method !== 'can_use_tool' || msg.params.tool_name !== 'Bash' || ![orchestratorPlan?.read, orchestratorPlan?.reply].includes(msg.params.input?.command)) { orchestrator.respond(msg.id, { behavior: 'deny', message: 'Only the test broker command is allowed' }); return; }
          orchestrator.respond(msg.id, { behavior: 'allow', updatedInput: msg.params.input });
        } });
        await orchestrator.ready;
        const result = await agentProbe('kimi', async (type, event, target) => {
          const args = [broker, type, ...target, '--request', event.requestId, ...(type === 'answer' ? ['--text', 'A'] : [])];
          const command = argv => [process.execPath, ...argv].map(s => '"' + s.replace(/\\/g, '/') + '"').join(' ');
          orchestratorPlan = { requestId: event.requestId, read: command([broker, 'events', '--state', target.at(-1), '--next', '--timeout-min', '0.1']), reply: command(args), sent: false };
          const done = await orchestrator.prompt('MESH_ORCHESTRATOR: handle the pending isolated agent event.');
          if (done.status !== 'completed' || !orchestratorPlan.sent) throw Error('Claude orchestrator did not read and answer the mesh event');
        });
        return { ...result, realClaudeToolReply: true, eventReadByClaude: true };
      } finally { await orchestrator?.close(); }
    });
  } finally {
    releaseCodex?.();
    for (const res of pendingHttp) res.destroy();
    // Revived detached brokers are closed too if an assertion failed.
    for (const dir of stateDirs) {
      const file = path.join(dir, 'worker.state.json');
      if (fs.existsSync(file)) {
        const s = JSON.parse(fs.readFileSync(file));
        if (!['done', 'error'].includes(s.status)) await cli(['send', '--name', 'worker', '--state', dir, '--text', '/exit']).catch(() => { try { process.kill(s.pid); } catch {} });
      }
    }
    for (const child of processes) { child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
    server.closeAllConnections(); server.close();
  }
}
if (require.main === module) main().then(() => process.exit(process.exitCode || 0), e => { console.error(e.message); process.exit(1); });
