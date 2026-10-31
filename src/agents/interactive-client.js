'use strict';
const { spawn: defaultSpawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { questionResult } = require('./mesh');

// Both CLIs keep stdin open between turns. Only protocol ACKs have a deadline.
function connectInteractive({ agent, env = process.env, cwd, sessionId, model, spawn = defaultSpawn,
  onRequest, onUpdate = () => {}, onSession = () => {}, onDisconnect = () => {}, log = () => {}, timeout = 30000 }) {
  const kimi = agent === 'kimi';
  const args = kimi ? [...(model ? ['-m', model] : []), 'acp']
    : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', ...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : [])];
  const childEnv = { ...env, SESSION_SYNC_BROKER: '1' };
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CLAUDECODE;
  const proc = spawn(env[kimi ? 'AGENT_BROKER_KIMI' : 'AGENT_BROKER_CLAUDE'] || agent, args,
    { env: childEnv, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let live = true, closed = false, turn, text = '', currentSession = sessionId;
  const write = msg => { if (!live) throw Error('Disconnected agent'); proc.stdin.write(JSON.stringify(msg) + '\n'); };
  function lost(reason) {
    if (!live) return;
    live = false;
    for (const p of pending.values()) p.reject(Error(reason));
    pending.clear();
    turn?.reject(Error(reason)); turn = null;
    proc.kill();
    proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy();
    if (!closed) onDisconnect(reason);
  }
  function request(method, params, limit = timeout) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = limit ? setTimeout(() => { pending.delete(id); reject(Error(`Agent request timeout: ${method}`)); }, limit) : null;
      const settle = fn => value => { clearTimeout(timer); fn(value); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try { write(kimi ? { jsonrpc: '2.0', id, method, params } : { type: 'control_request', request_id: id, request: { subtype: method, ...params } }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function respond(id, result, error) {
    write(kimi ? { jsonrpc: '2.0', id, ...(error ? { error } : { result }) }
      : { type: 'control_response', response: { subtype: error ? 'error' : 'success', request_id: id,
        ...(error ? { error: error.message } : { response: result }) } });
  }
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { lost('Invalid agent JSON'); return; }
    try {
      const id = kimi ? msg.id : msg.response?.request_id;
      if ((kimi ? !msg.method : msg.type === 'control_response') && pending.has(id)) {
        const p = pending.get(id); pending.delete(id);
        const error = kimi ? msg.error : msg.response.subtype === 'error' && { message: msg.response.error };
        if (error) p.reject(Object.assign(Error(error.message), error));
        else p.resolve(kimi ? msg.result : msg.response.response);
      } else if (kimi && msg.id !== undefined && msg.method) {
        onRequest({ id: msg.id, method: msg.method, params: msg.params || {} });
      } else if (!kimi && msg.type === 'control_request') {
        onRequest({ id: msg.request_id, method: msg.request?.subtype, params: msg.request || {} });
      } else if (!kimi && msg.type === 'control_cancel_request') {
        onUpdate({ method: 'request.cancelled', params: { requestId: msg.request_id } });
      } else if (kimi && msg.method === 'session/update') {
        if (msg.params?.sessionId !== currentSession || !turn) return;
        const update = msg.params.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text;
        onUpdate(msg);
      } else if (!kimi) {
        if (msg.session_id && msg.session_id !== currentSession) { currentSession = msg.session_id; onSession(currentSession); }
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) text += (msg.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        if (msg.type === 'result' && turn) {
          const active = turn; turn = null;
          active.resolve({ text: msg.result ?? text, status: msg.is_error ? 'failed' : 'completed' });
        }
        onUpdate(msg);
      }
    } catch (error) { lost(error.message); }
  });
  proc.stderr.on('data', data => log(`${agent} stderr ${String(data).trim().slice(0, 300)}`));
  proc.stdin.on('error', error => lost(error.message));
  proc.on('error', error => lost(error.message));
  proc.on('exit', code => lost(`${agent} exited (${code})`));
  const ready = (async () => {
    if (kimi) {
      const init = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-kit', version: '0.5.5' }, clientCapabilities: { elicitation: { form: {} } } });
      if (sessionId && !init.agentCapabilities?.loadSession) throw Error('Kimi ACP cannot load sessions; use --kimi-print only for legacy compatibility');
      const session = await request(sessionId ? 'session/load' : 'session/new', { ...(sessionId ? { sessionId } : {}), cwd, mcpServers: [] });
      currentSession = session.sessionId || sessionId;
      if (!currentSession) throw Error('Kimi ACP returned no sessionId');
      onSession(currentSession);
    } else await request('initialize', { hooks: {}, sdkMcpServers: [] });
  })();
  return {
    ready, respond,
    prompt: async value => {
      await ready;
      if (turn) throw Error('Agent turn already running (steer=false)');
      text = '';
      if (kimi) {
        // ACP completes a turn with the prompt RPC result, after all session/update chunks.
        turn = { reject() {} };
        try {
          const result = await request('session/prompt', { sessionId: currentSession, prompt: [{ type: 'text', text: value }] }, 0);
          return { text, status: result.stopReason === 'cancelled' ? 'interrupted' : 'completed' };
        } finally { turn = null; }
      }
      return new Promise((resolve, reject) => {
        turn = { resolve, reject };
        try { write({ type: 'user', session_id: currentSession || '', message: { role: 'user', content: value }, parent_tool_use_id: null }); }
        catch (error) { turn = null; reject(error); }
      });
    },
    interrupt() {
      if (kimi) { write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: currentSession } }); return Promise.resolve(); }
      return request('interrupt', {});
    },
    async close() {
      closed = true;
      try { if (kimi && live && currentSession) await request('session/close', { sessionId: currentSession }, 5000); }
      finally { lost('Agent closed'); lines.close(); }
    }
  };
}

function interactiveRequest(agent, msg) {
  const p = msg.params;
  if (agent === 'claude') {
    if (msg.method !== 'can_use_tool') return null;
    const question = p.tool_name === 'AskUserQuestion';
    return { type: question ? 'question' : 'approval', params: { ...p,
      ...(question ? { questions: (p.input?.questions || []).map((q, i) => ({ ...q, id: q.question || String(i), isOther: true })) } : {}) },
      summary: question ? (p.input?.questions || []).map(q => q.question).join('; ') : `${p.tool_name}: ${JSON.stringify(p.input)}` };
  }
  if (msg.method === 'elicitation/create') {
    const properties = p.requestedSchema?.properties;
    if (!properties || p.mode === 'url') return null;
    return { type: 'question', params: { ...p, questions: Object.entries(properties).map(([id, s]) => {
      const options = s.enum?.map(label => ({ label })) || (s.oneOf || s.items?.anyOf || s.items?.oneOf)?.map(o => ({ label: o.const, description: o.title }));
      return { id, question: s.title || s.description || id, ...(options ? { options } : {}), isOther: !options };
    }) }, summary: p.message };
  }
  if (msg.method === 'session/request_permission') {
    if (p.toolCall?.title === 'AskUserQuestion') return { type: 'question', params: { ...p,
      questions: [{ id: 'question', question: (p.toolCall.content || []).map(c => c.content?.text || '').join('\n'), options: (p.options || []).filter(o => o.kind === 'allow_once').map(o => ({ label: o.name })) }] }, summary: 'AskUserQuestion' };
    return { type: 'approval', params: p, summary: p.toolCall?.title || 'Kimi tool permission' };
  }
  return null;
}
function interactiveResult(agent, entry, payload, action) {
  const p = entry.params;
  if (entry.type === 'question') {
    const answers = questionResult(p, payload).answers;
    if (agent === 'claude') return { behavior: 'allow', updatedInput: { ...p.input,
      answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.answers.join(', ')])) } };
    if (p.options) {
      const option = p.options.find(o => o.name === answers.question.answers[0]);
      if (!option) throw Error('Unknown question option');
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
    const content = {};
    for (const [id, a] of Object.entries(answers)) {
      const schema = p.requestedSchema.properties[id], value = a.answers[0];
      if (schema.type === 'boolean') { if (!['true', 'false'].includes(value)) throw Error(`Expected true/false for ${id}`); content[id] = value === 'true'; }
      else if (['integer', 'number'].includes(schema.type)) {
        const n = Number(value); if (!Number.isFinite(n) || (schema.type === 'integer' && !Number.isInteger(n))) throw Error(`Expected ${schema.type} for ${id}`);
        content[id] = n;
      } else content[id] = schema.type === 'array' ? a.answers : value;
    }
    return { action: 'accept', content };
  }
  if (agent === 'claude') return action === 'approve' ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Denied by orchestrator' };
  const option = (p.options || []).find(o => o.kind === (action === 'approve' ? 'allow_once' : 'reject_once'));
  if (!option) {
    if (action === 'deny') return { outcome: { outcome: 'cancelled' } };
    throw Error('No allow_once permission option');
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}
// Решение брокера по --sandbox: 'approve'/'deny' — ответить агенту сразу, null — передать оркестратору.
// workspace-write: записи внутри cwd и обычные команды одобряем сами; записи вне cwd и сеть (без --network)
// уходят оркестратору. read-only: записи отклоняем автоматически, остальное — как раньше.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const NETWORK_COMMAND = /\b(?:curl|wget|scp|ssh|ftp|nc)\b/;
function interactiveSandboxDecision(agent, entry, { sandbox, cwd, network } = {}) {
  if (!entry || entry.type !== 'approval' || !['read-only', 'workspace-write'].includes(sandbox) || !cwd) return null;
  const inside = file => { const rel = path.relative(cwd, path.resolve(file)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  const p = entry.params || {};
  let write = false, net = false, files = [];
  if (agent === 'claude') {
    const tool = p.tool_name || '';
    write = WRITE_TOOLS.has(tool);
    net = NETWORK_TOOLS.has(tool) || (tool === 'Bash' && NETWORK_COMMAND.test(p.input?.command || ''));
    if (write) files = [p.input?.file_path, p.input?.notebook_path, ...(p.input?.edits || []).map(e => e.file_path || p.input?.file_path)].filter(Boolean);
  } else {
    const title = p.toolCall?.title || '';
    const content = p.toolCall?.content || [];
    const text = content.map(c => c.content?.text ?? c.text ?? '').join(' ');
    write = /(?:^|\s)(?:edit|write|multiedit|notebookedit)(?:\s|$)/i.test(title);
    net = /webfetch|websearch/i.test(`${title} ${text}`) || NETWORK_COMMAND.test(text);
    if (write) {
      files = content.flatMap(c => [c.path, ...(Array.isArray(c.locations) ? c.locations : []).map(l => l?.path ?? l)]).filter(v => typeof v === 'string');
      for (const c of content) {
        for (const match of (c.content?.text ?? c.text ?? '').matchAll(/\b(?:Writing|Editing|Creating) ["'“‘`]?(.+?)(?=\.{3}|…|["'”’`\r\n]|$)/g)) {
          const name = match[1].trim();
          if (name) files.push(path.isAbsolute(name) ? name : path.resolve(cwd, name));
        }
      }
    }
  }
  if (sandbox === 'read-only') return write ? 'deny' : null;
  if (write) return files.length > 0 && files.every(inside) ? 'approve' : null;
  if (net) return network ? 'approve' : null;
  return 'approve';
}
module.exports = { connectInteractive, interactiveRequest, interactiveResult, interactiveSandboxDecision };
