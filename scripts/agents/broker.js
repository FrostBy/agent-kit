#!/usr/bin/env node
// Живая сессия внешнего агента (Codex через общий app-server, Kimi через -S) с почтовым ящиком.
// Сообщения - файлы в <state>/<name>.inbox/ (любое имя, порядок по имени): во время хода Codex
// уходят как turn/steer, после хода - новым ходом в ту же сессию. Команды в файле: /interrupt, /exit.
// Выход: <name>.out.md - последний ответ агента, <name>.history.md - все ходы, <name>.log - события,
// <name>.state.json - {status: starting|running|idle|reconnecting|done|error, turns, lastTurnAt, threadId|sessionId, lastTurnStatus}.
// Подкоманды оркестратора: `send` (сообщение в inbox и ожидание конца хода) и `wait` (ожидание конца
// текущего/следующего хода): обе печатают <name>.out.md и выходят 0, при мёртвом pid или таймауте - 1.
// Десктопный Codex и обычный `codex exec` не затрагиваются: подключение - обычный клиент демона
// через `codex app-server proxy`, config.toml не меняется, настройки идут параметрами потока.
'use strict';
const { spawn } = require('node:child_process');
const { connectProxy } = require('../../src/agents/codex-client');
const { plain } = require('../../src/agents/codex-path');
const { syncThreads } = require('../../src/agents/sync-protection');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { eventWriter, questionResult, approvalResult, alive } = require('../../src/agents/mesh');

process.env.SESSION_SYNC_BROKER = '1';
const argv = process.argv.slice(2);
if (['answer', 'approve', 'deny', 'interrupt', 'exit', 'events', 'ack'].includes(argv[0])) {
  require('../../src/agents/mesh').runCommand(argv).catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
if (argv[0] === 'send' || argv[0] === 'wait') {
  runSendWait(argv[0], argv.slice(1)).catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
const opt = { images: [], claudeConfigDirs: [] };
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  const v = () => { const value = argv[++i]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${k}`); return value; };
  if (k === '--agent') opt.agent = v();
  else if (k === '--name') opt.name = v();
  else if (k === '--state') opt.state = v();
  else if (k === '--prompt') opt.prompt = v();
  else if (k === '--resume') opt.resume = true;
  else if (k === '--cwd') opt.cwd = v();
  else if (k === '--model') opt.model = v();
  else if (k === '--effort') opt.effort = v();
  else if (k === '--sandbox') opt.sandbox = v();
  else if (k === '--approval-policy') opt.approvalPolicy = v();
  else if (k === '--network') opt.network = true;
  else if (k === '--search') opt.search = true;
  else if (k === '--image') opt.images.push(v());
  else if (k === '--idle-min') opt.idleMin = Number(v());
  else if (k === '--claude-config-dir') opt.claudeConfigDirs.push(v());
  else throw new Error(`unknown arg ${k}`);
}
if (!opt.agent || !opt.name || !opt.state || (!opt.prompt && !opt.resume)) {
  console.error('usage: agent-broker --agent codex|kimi --name X --state DIR --prompt FILE [--cwd DIR] [--model M] [--effort E] [--sandbox read-only|workspace-write] [--network] [--search] [--image PNG]... [--idle-min 15] [--claude-config-dir DIR]...');
  process.exit(2);
}
if (!/^[\w-]+$/.test(opt.name)) throw Error('Invalid agent name');
if (!['codex', 'kimi'].includes(opt.agent)) throw Error('Invalid agent');
opt.approvalPolicy ??= 'never';
if (!['never', 'on-request', 'on-failure', 'untrusted'].includes(opt.approvalPolicy)) throw Error('Invalid --approval-policy');
opt.cwd = path.resolve(opt.cwd ?? process.cwd());
opt.idleMin ??= 15;
if (!Number.isFinite(opt.idleMin) || opt.idleMin <= 0) throw Error('Invalid --idle-min');
const base = path.join(path.resolve(opt.state), opt.name);
const inbox = `${base}.inbox`;
fs.mkdirSync(inbox, { recursive: true });
let previous;
{
  try { previous = JSON.parse(fs.readFileSync(`${base}.state.json`, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (opt.resume && (previous?.agent !== opt.agent || !(opt.agent === 'codex' ? previous?.threadId : previous?.sessionId))) throw Error('Cannot resume: no saved threadId/sessionId');
if (previous?.agent === 'codex' && previous.threadId && !/^[\w-]+$/.test(previous.threadId)) throw Error('Invalid saved thread ID');
if (previous?.pid && previous.pid !== process.pid && !['done', 'error'].includes(previous.status)) {
  let live = true; try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
  if (live) throw Error('Broker state is owned by a live process');
}
const state = { ...(previous?.agent === opt.agent ? previous : {}), agent: opt.agent, status: 'starting', turns: previous?.agent === opt.agent ? previous.turns || 0 : 0, pid: process.pid };
state.launch = { agent: opt.agent, cwd: opt.cwd, model: opt.model, effort: opt.effort, sandbox: opt.sandbox,
  approvalPolicy: opt.approvalPolicy, network: !!opt.network, search: !!opt.search, idleMin: opt.idleMin, claudeConfigDirs: opt.claudeConfigDirs };
if (opt.resume) state.turnId = null;
const relative = path.relative(path.join(require('node:os').tmpdir(), 'claude'), path.resolve(opt.state)).split(path.sep);
if (relative.length >= 3 && relative[0] !== '..' && relative[2] === 'scratchpad' && /^[\w-]+$/.test(relative[1])) {
  state.owner = relative[1];
  if (!state.ownerPid) void require('../../src/sync/process-cache').identity('claude').then(id => {
    if (id) { state.ownerPid = Number(id.split(':')[0]); save(); }
  });
}
const save = () => fs.writeFileSync(`${base}.state.json`, JSON.stringify(state, null, 2));
save();
const log = (s) => fs.appendFileSync(`${base}.log`, `[${new Date().toISOString()}] ${s}\n`);
const emit = eventWriter(base, opt.name);
const finishTurn = (text) => {
  state.turns++;
  state.lastTurnAt = new Date().toISOString();
  fs.writeFileSync(`${base}.out.md`, text ?? '');
  fs.appendFileSync(`${base}.history.md`, `\n\n## Ход ${state.turns}\n\n${text ?? ''}\n`);
  log(`turn ${state.turns} done`);
  emit('turn.completed', { status: state.lastTurnStatus ?? 'completed' }, { turnId: state.turnId, summary: text || state.lastTurnStatus || 'completed' });
};
let lastActivity = Date.now();
const takeInbox = () => {
  const files = fs.readdirSync(inbox).filter((f) => !f.startsWith('.')).sort();
  return files.map((f) => {
    const p = path.join(inbox, f);
    const text = fs.readFileSync(p, 'utf8');
    fs.renameSync(p, path.join(inbox, `.sent-${Date.now()}-${f}`));
    if (f.endsWith('.command.json') && opt.agent === 'codex') {
      try {
        const command = JSON.parse(text);
        if (!command || typeof command !== 'object' || Array.isArray(command)) throw Error('Invalid command');
        return command;
      }
      catch { return { v: 1, type: 'invalid', payload: {} }; }
    }
    return text.trim();
  });
};
let shutdownCodex;
const done = (status, code = 0, reason = status === 'error' ? 'error' : 'exit') => {
  if (shutdownCodex) return shutdownCodex(status, code, reason);
  state.status = status;
  save();
  log(`exit ${status}`);
  emit('agent.exited', { status, code, reason, pid: process.pid }, { summary: `Agent exited: ${reason} (${code})` });
  process.exit(code);
};

if (opt.agent === 'codex') runCodex();
else if (opt.agent === 'kimi') runKimi();
else throw new Error(`unknown agent ${opt.agent}`);
if (state.owner) setInterval(() => {
  if (state.ownerPid && !alive(state.ownerPid)) void done('done', 0, 'owner');
}, 1000);

function runCodex() {
  // Демон Codex перезапускается (обновление десктопа, «Server is draining»): соединение тогда
  // поднимается заново и поток продолжается по threadId; ход, убитый перезапуском, продолжается
  // одним автоматическим сообщением. running - только пока ход жив.
  const RETRY_MS = [2000, 5000, 10000, 20000, 30000, 60000, 60000, 120000];
  let conn = null;
  let threadId = state.threadId || null;
  let turnId = state.turnId || null;
  let closing = false;
  let lastText = null;
  let attempt = 0;
  const resumedTurns = new Set();
  const queue = [];
  let busy = false;
  const pending = new Map();
  state.pendingRequests = [];
  function resolveRequest(id, reason) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.connection.resolvedRequests.add(entry.rpcId);
    state.pendingRequests = [...pending.keys()]; save();
    emit('request.resolved', { reason }, { requestId: id, turnId: entry.params.turnId, summary: reason });
  }
  function invalidate(reason, connection) {
    for (const [id, entry] of pending) if (!connection || entry.connection === connection) resolveRequest(id, reason);
  }
  function onRequest(c, msg) {
    const p = msg.params ?? {};
    if (closing || c !== conn || !threadId || p.threadId !== threadId) return;
    if (c.resolvedRequests.has(msg.id)) return;
    const question = msg.method === 'item/tool/requestUserInput';
    const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(msg.method);
    if (!question && !approval) { c.respond(msg.id, undefined, { code: -32601, message: 'broker: not supported' }); return; }
    if (p.turnId && ((turnId && p.turnId !== turnId) || state.status === 'idle')) { c.respond(msg.id, undefined, { code: -32602, message: 'Stale turn' }); return; }
    if ([...pending.values()].some(e => e.connection === c && e.rpcId === msg.id)) return;
    const id = randomUUID();
    pending.set(id, { connection: c, rpcId: msg.id, method: msg.method, params: p, type: question ? 'question' : 'approval' });
    state.pendingRequests = [...pending.keys()]; save();
    emit(question ? 'question' : 'approval', { ...p, method: msg.method }, { requestId: id, turnId: p.turnId,
      summary: question ? (p.questions || []).map(q => q.question).join('; ') : p.reason || p.command || msg.method });
  }
  const input = (text, images = []) => [
    { type: 'text', text, text_elements: [] },
    ...images.map((p) => ({ type: 'localImage', path: path.resolve(p) })),
  ];
  const isDrain = (e) =>
    e?.reason === 'disconnected' ||
    e?.data?.reason === 'serverShuttingDown' ||
    /draining|reconnecting after/i.test(e?.message ?? '');
  const threadParams = () => {
    const config = { shell_environment_policy: { inherit: 'all', set: { SESSION_SYNC_BROKER: '1' } } };
    if (opt.network) config['sandbox_workspace_write'] = { network_access: true };
    if (opt.search) config.web_search = 'live';
    return {
      cwd: opt.cwd,
      approvalPolicy: opt.approvalPolicy,
      ...(opt.model ? { model: opt.model } : {}),
      ...(opt.sandbox ? { sandbox: opt.sandbox } : {}),
      ...(Object.keys(config).length ? { config } : {}),
    };
  };

  function connect() {
    if (closing) return;
    const c = connectProxy({ env: process.env, mode: 'proxy', spawn, log, timeout: REQUEST_MS,
      onNotification: msg => onMessage(c, msg),
      onRequest: msg => onRequest(c, msg),
      onDisconnect: why => {
        clearInterval(c.ticker); log(`connection lost: ${why}`);
        invalidate('disconnected', c);
        if (!closing) emit('error', { source: 'transport', message: why, retriable: true }, { turnId, summary: why });
        if (!closing) reconnect();
      } });
    conn = c;
    c.resolvedRequests = new Set();
    c.ticker = setInterval(() => {
      pollInbox();
      if (!closing && !busy && !queue.length && state.status === 'idle' && Date.now() - lastActivity > opt.idleMin * 60_000) void done('done', 0, 'idle');
    }, 1000);
    c.ready.then(() => boot(c), () => {});
  }

  function reconnect() {
    if (attempt >= RETRY_MS.length) { log('reconnect: attempts exhausted'); void done('error', 1); return; }
    const wait = RETRY_MS[attempt++];
    state.status = 'reconnecting';
    save();
    log(`reconnect in ${wait} ms (attempt ${attempt})`);
    setTimeout(connect, wait);
  }

  // Ответ на запрос может не прийти при живом соединении (2026-10-30: turn/start висел час,
  // статус idle). Таймаут считает соединение потерянным: сообщение вернётся в очередь,
  // поток продолжится после переподключения по threadId. Это подтверждение запроса, не работа
  // модели: turn/start отвечает за доли секунды, ход идёт событиями. Поток на длинной истории
  // поднимается дольше - ему больше времени.
  const REQUEST_MS = Number(process.env.BROKER_REQUEST_MS ?? 90_000);
  const SLOW = new Set(['thread/start', 'thread/resume']);
  const request = (method, params, limit) => conn?.request(method, params,
    limit ?? (SLOW.has(method) ? REQUEST_MS * 10 / 3 : REQUEST_MS))
    ?? Promise.reject({ reason: 'disconnected', message: 'no connection' });
  const notify = (method, params) => conn?.notify(method, params);

  shutdownCodex = async (status, code = 0, reason) => {
    if (closing) return;
    closing = true; clearInterval(conn?.ticker);
    invalidate('agent exited');
    state.archived = false;
    try {
      if (turnId && reason === 'owner') await request('turn/interrupt', { threadId, turnId }, Math.min(REQUEST_MS, 5000)).catch(() => {});
      if (threadId) {
        if (syncThreads({ env: process.env, claudeConfigDirs: opt.claudeConfigDirs }).has(threadId)) {
          log(`archive skipped: protected sync thread ${threadId}`);
          return;
        }
        await request('thread/archive', { threadId }, Math.min(REQUEST_MS, 5000));
        state.archived = true;
      }
    } catch (error) { log(`archive failed: ${error.message || JSON.stringify(error)}`); }
    finally {
      state.status = status; save(); log(`exit ${status} archived ${state.archived}`);
      emit('agent.exited', { status, code, reason, pid: process.pid }, { turnId, summary: `Agent exited: ${reason} (${code})` });
      conn?.close(); process.exit(code);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void done('done'); });
  process.on('beforeExit', () => { if (!closing) void done('done'); });

  function onMessage(c, msg) {
    if (closing || c !== conn) return;
    const m = msg.method;
    const p = msg.params ?? {};
    if (p.threadId && threadId && p.threadId !== threadId) return;
    lastActivity = Date.now();
    if (m === 'serverRequest/resolved') {
      c.resolvedRequests.add(p.requestId);
      for (const [id, entry] of pending) if (entry.connection === c && entry.rpcId === p.requestId) resolveRequest(id, 'server resolved');
    } else if (m === 'turn/started') { turnId = p.turn?.id ?? turnId; state.status = 'running'; state.turnId = turnId; save(); log(`turn started ${turnId}`); }
    else if (m === 'item/completed') {
      const item = p.item ?? {};
      if (item.type === 'agentMessage') lastText = item.text ?? lastText;
      else if (item.type === 'commandExecution') log(`cmd ${String(item.command ?? '').slice(0, 200)}`);
      else if (item.type === 'fileChange') log(`files ${JSON.stringify((item.changes ?? []).map((ch) => ch.path)).slice(0, 300)}`);
    } else if (m === 'turn/completed') completeTurn(p.turn ?? {}, lastText);
    else if (m === 'error') {
      log(`error ${JSON.stringify(p).slice(0, 400)}`);
      emit('error', p, { turnId, summary: p.error?.message || p.message || 'Codex error' });
      if (isDrain(p.error ?? p)) c.lost('server draining');
    }
  }

  function completeTurn(turn, text) {
    invalidate('turn completed');
    const status = turn.status ?? 'completed';
    log(`turn completed ${status} ${turn.error ? JSON.stringify(turn.error).slice(0, 300) : ''}`);
    state.lastTurnStatus = status;
    finishTurn(status === 'completed' ? text : `[broker] ход завершился со статусом ${status}${turn.error ? `: ${JSON.stringify(turn.error).slice(0, 300)}` : ''}\n\n${text ?? ''}`);
    lastText = null;
    turnId = null;
    state.status = 'idle';
    state.turnId = null;
    save();
    pump();
  }

  const startTurn = async (text, images = []) => {
    const params = { threadId, input: input(text, images), ...(opt.effort ? { effort: opt.effort } : {}) };
    let res;
    try {
      res = await request('turn/start', params);
    } catch (error) {
      // Поток заархивировали снаружи, пока брокер был подключен: turn/start отвечает
      // "thread not found"/"is archived". Один раз возвращаем поток из архива и повторяем.
      if (!/thread not found|is archived/i.test(error?.message ?? '')) throw error;
      log(`turn/start rejected (${error.message}); unarchive and resume thread ${threadId}`);
      await request('thread/unarchive', { threadId });
      state.archived = false; save();
      await request('thread/resume', { threadId, ...threadParams() });
      attempt = 0;
      res = await request('turn/start', params);
    }
    turnId = res.turn?.id ?? turnId;
    state.status = 'running';
    state.turnId = turnId;
    save();
  };

  async function handle(text) {
    if (text === '/exit') {
      if (turnId) await request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      await done('done'); return;
    }
    if (text === '/interrupt') {
      if (turnId) { log('interrupt'); await request('turn/interrupt', { threadId, turnId }).catch(() => undefined); }
      return;
    }
    if (turnId) {
      log(`steer ${text.slice(0, 120)}`);
      await request('turn/steer', { threadId, expectedTurnId: turnId, input: input(text) }).catch((e) => {
        if (isDrain(e)) throw e;
        log('steer failed, queued as next turn');
        queue.push(text);
      });
    } else {
      log(`next turn ${text.slice(0, 120)}`);
      await startTurn(text);
    }
  }

  async function pump() {
    if (closing || busy || !threadId || !conn?.alive || state.status === 'reconnecting') return;
    busy = true;
    try {
      while (!closing && queue.length && conn?.alive) {
        const text = queue.shift();
        try { await handle(text); }
        catch (e) {
          if (isDrain(e)) { queue.unshift(text); log('message kept for after reconnect'); conn?.lost('request failed: draining'); break; }
          log(`message failed ${JSON.stringify(e).slice(0, 300)}`);
          emit('error', { source: 'message', ...e }, { turnId, summary: e.message || 'Message rejected' });
          state.lastTurnStatus = 'failed';
          finishTurn(`[broker] сообщение не принято сервером: ${JSON.stringify(e).slice(0, 300)}`);
          state.status = turnId ? 'running' : 'idle';
          save();
        }
      }
    } finally {
      busy = false;
    }
  }

  async function control(command) {
    lastActivity = Date.now();
    if (command.v !== 1 || !command.payload || typeof command.payload !== 'object') throw Error('Invalid typed inbox command');
    const { type, payload } = command;
    if (type === 'interrupt' || type === 'exit') {
      invalidate(type);
      await handle(type === 'exit' ? '/exit' : '/interrupt'); return;
    }
    if (!['answer', 'approve', 'deny'].includes(type)) throw Error('Unknown inbox command');
    const entry = pending.get(payload.requestId);
    if (!entry || entry.connection !== conn || !conn?.alive) throw Error('Stale or resolved request ID');
    if ((type === 'answer') !== (entry.type === 'question')) throw Error('Wrong response type for request');
    const result = type === 'answer' ? questionResult(entry.params, payload) : approvalResult(entry.method, entry.params, type === 'approve');
    entry.connection.respond(entry.rpcId, result);
    resolveRequest(payload.requestId, type);
  }
  function pollInbox() {
    if (closing) return;
    // Never put decisions behind an awaited turn/start or turn/steer RPC.
    for (const value of takeInbox()) {
      const command = typeof value === 'object' ? value : ['/exit', '/interrupt'].includes(value) ? { v: 1, type: value.slice(1), payload: {} } : null;
      if (command) void control(command).catch(error => {
        log(`command failed: ${error.message}`);
        emit('error', { source: 'inbox', commandId: command.id, message: error.message }, { requestId: command.payload?.requestId, turnId, summary: error.message });
      });
      else queue.push(value);
    }
    void pump();
  }

  async function boot(c) {
    try {
      await request('initialize', { clientInfo: { name: 'claude-agent-broker', version: '2' } });
      notify('initialized', {});
      if (!threadId) {
        const res = await request('thread/start', threadParams());
        threadId = res.thread?.id;
        state.threadId = threadId; state.archived = false;
        state.model = res.model;
        state.sandbox = res.sandbox;
        save();
        log(`thread ${threadId} model ${res.model} cwd ${res.cwd}`);
        attempt = 0;
        const first = fs.readFileSync(opt.prompt, 'utf8');
        await startTurn(first, opt.images).catch((e) => { if (isDrain(e)) queue.push(first); throw e; });
      } else {
        const stored = state.archived ? null : await request('thread/read', { threadId, includeTurns: false });
        if (state.archived || /[\\/]archived_sessions[\\/]/.test(plain(stored?.thread?.path) || '')) {
          await request('thread/unarchive', { threadId }); state.archived = false; save();
        }
        let res;
        try { res = await request('thread/resume', { threadId, ...threadParams() }); }
        catch (error) {
          if (!/is archived/i.test(error.message || '')) throw error;
          await request('thread/unarchive', { threadId }); state.archived = false; save();
          res = await request('thread/resume', { threadId, ...threadParams() });
        }
        attempt = 0;
        const turns = res.thread?.turns ?? [];
        const last = turns[turns.length - 1];
        log(`thread resumed, status ${JSON.stringify(res.thread?.status)}, last turn ${last?.id} ${last?.status}`);
        if (turnId && last?.id === turnId && last.status === 'inProgress') {
          state.status = 'running';
          save();
        } else if (turnId) {
          // Ход, шедший до обрыва, закончился без нас: забираем итог или продолжаем убитый ход.
          const mine = last?.id === turnId ? last : null;
          const text = [...(mine?.items ?? [])].reverse().find((i) => i.type === 'agentMessage')?.text ?? lastText;
          if (mine?.status === 'completed') completeTurn(mine, text);
          else if (!resumedTurns.has(turnId)) {
            resumedTurns.add(turnId);
            log(`turn ${turnId} lost in restart -> continue`);
            turnId = null;
            await startTurn('Сессия оборвалась из-за перезапуска сервера Codex. Продолжай текущую задачу с того места, где остановился; итоговый отчёт - как требовала задача.');
          } else completeTurn(mine ?? { status: 'interrupted' }, text);
        } else {
          state.status = 'idle';
          save();
        }
      }
      pollInbox();
    } catch (e) {
      log(`boot failed ${JSON.stringify(e).slice(0, 400)}`);
      emit('error', { source: 'boot', ...e }, { turnId, summary: e.message || 'Codex boot failed' });
      if (!threadId && !isDrain(e)) { await done('error', 1); return; }
      c.lost('boot failed');
    }
  }

  connect();
}

function runKimi() {
  // Kimi в режиме -p не принимает сообщения посреди хода: ящик читается после хода и уходит
  // следующим сообщением в ту же сессию (kimi -S <id>).
  const model = opt.model ?? 'kimi-code/kimi-for-coding';
  let session = state.sessionId || null;
  let active;
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => done('done'));
  const exit = done;
  shutdownCodex = (status, code, reason) => {
    if (closing) return;
    closing = true; active?.kill(); shutdownCodex = null; exit(status, code, reason);
  };
  setInterval(() => {
    if (closing || !active) return;
    const files = fs.readdirSync(inbox).filter(f => !f.startsWith('.')).sort();
    for (const file of files) if (fs.readFileSync(path.join(inbox, file), 'utf8').trim() === '/exit') {
      fs.renameSync(path.join(inbox, file), path.join(inbox, `.sent-${file}`)); done('done'); return;
    }
  }, 1000);
  const turn = (text) => new Promise((resolve) => {
    state.status = 'running';
    save();
    const args = ['-m', model, ...(session ? ['-S', session] : []), '-p', text];
    const p = spawn(process.env.AGENT_BROKER_KIMI || 'kimi', args, { windowsHide: true, cwd: opt.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    active = p;
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; lastActivity = Date.now(); });
    p.stderr.on('data', (d) => { err += d; log(`kimi stderr ${String(d).trim().slice(0, 300)}`); });
    p.on('error', (error) => { log(error.message); done('error', 1); });
    p.on('exit', (code) => {
      active = null;
      if (closing) { resolve(); return; }
      // Kimi печатает «To resume this session: kimi -r session_<id>» в stderr.
      const m = `${out}\n${err}`.match(/kimi -r (session_[\w-]+)/);
      if (m) { session = m[1]; state.sessionId = session; }
      log(`kimi exit ${code}`);
      state.lastTurnStatus = code === 0 ? 'completed' : 'failed';
      finishTurn(out.replace(/\n?To resume this session:.*$/s, '').trim());
      state.status = 'idle';
      lastActivity = Date.now();
      save();
      resolve();
    });
  });
  (async () => {
    if (!opt.resume) await turn(fs.readFileSync(opt.prompt, 'utf8'));
    else { state.status = 'idle'; save(); }
    while (!closing) {
      const msgs = takeInbox();
      for (const text of msgs) {
        if (text === '/exit') { done('done'); return; }
        if (text === '/interrupt') continue;
        await turn(text);
      }
      if (Date.now() - lastActivity > opt.idleMin * 60_000) { done('done', 0, 'idle'); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}

}
async function runSendWait(mode, args) {
  // Оркестратор живёт короче хода агента и не получает сигнал о его конце; эти подкоманды ждут
  // роста счётчика turns в state.json и печатают итог хода. Только файлы, без зависимостей.
  const sub = { name: undefined, state: undefined, message: undefined, text: undefined, timeoutMin: 120 };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const v = () => { const value = args[++i]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${k}`); return value; };
    if (k === '--name') sub.name = v();
    else if (k === '--state') sub.state = v();
    else if (k === '--message') sub.message = v();
    else if (k === '--text') sub.text = v();
    else if (k === '--timeout-min') sub.timeoutMin = Number(v());
    else throw new Error(`unknown arg ${k}`);
  }
  if (!sub.name || !sub.state) { console.error(`usage: broker.js ${mode} --name X --state DIR` + (mode === 'send' ? ' (--message FILE | --text "...")' : '') + ' [--timeout-min 120]'); process.exit(2); }
  if (!/^[\w-]+$/.test(sub.name)) throw Error('Invalid agent name');
  if (!Number.isFinite(sub.timeoutMin) || sub.timeoutMin <= 0) throw Error('Invalid --timeout-min');
  if (mode === 'send' && !sub.message && sub.text === undefined) { console.error('broker.js send: нужен --message FILE или --text "..."'); process.exit(2); }
  const dir = path.resolve(sub.state);
  const basePath = path.join(dir, sub.name);
  const stateFile = `${basePath}.state.json`;
  let lastSeen = null;
  const readState = () => {
    try { return (lastSeen = JSON.parse(fs.readFileSync(stateFile, 'utf8'))); }
    catch (error) { return error.code === 'ENOENT' ? null : lastSeen; }
  };
  const initial = readState();
  if (!initial) { console.error(`broker.js ${mode}: нет ${stateFile} - брокер не запускался`); process.exit(1); }
  let revived;
  let spawnError;
  if (!alive(initial.pid)) {
    if (mode !== 'send') throw Error(`broker.js ${mode}: процесс брокера ${initial.pid} не жив (status ${initial.status})`);
    if (!(initial.agent === 'codex' ? initial.threadId : initial.agent === 'kimi' && initial.sessionId)) throw Error('broker.js send: процесс не жив; нет сохранённого threadId/sessionId для продолжения');
    if (!initial.launch) throw Error('broker.js send: нет сохранённых параметров запуска; перезапустите брокер явно');
    const launch = [__filename, '--resume', '--agent', initial.agent, '--name', sub.name, '--state', dir];
    for (const [key, flag] of Object.entries({ cwd: '--cwd', model: '--model', effort: '--effort', sandbox: '--sandbox', approvalPolicy: '--approval-policy', idleMin: '--idle-min' })) {
      if (initial.launch[key] !== undefined) launch.push(flag, String(initial.launch[key]));
    }
    for (const flag of ['network', 'search']) if (initial.launch[flag]) launch.push(`--${flag}`);
    for (const profile of initial.launch.claudeConfigDirs || []) launch.push('--claude-config-dir', profile);
    revived = spawn(process.execPath, launch, { detached: true, windowsHide: true, stdio: 'ignore', cwd: initial.launch.cwd, env: process.env });
    revived.on('error', error => { spawnError = error; });
    revived.unref();
  }
  if (mode === 'send') {
    const text = sub.message ? fs.readFileSync(sub.message, 'utf8') : sub.text;
    const inboxDir = `${basePath}.inbox`;
    fs.mkdirSync(inboxDir, { recursive: true });
    const tmp = path.join(inboxDir, `.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, text);
    // Имя по возрастанию: нулёвый timestamp + pid, чтобы не пересекаться с соседними писателями.
    fs.renameSync(tmp, path.join(inboxDir, `${String(Date.now()).padStart(15, '0')}-${process.pid}`));
  }
  const baseline = initial.turns || 0;
  const deadline = Date.now() + sub.timeoutMin * 60_000;
  const pollMs = Number(process.env.BROKER_POLL_MS ?? 1500);
  for (;;) {
    const s = readState() ?? {};
    if (spawnError) throw spawnError;
    // Конец хода: turns вырос и агент больше не в работе. Steer во время хода тоже дождётся конца.
    if ((s.turns || 0) > baseline && ['idle', 'done', 'error'].includes(s.status)) {
      process.stdout.write(fs.existsSync(`${basePath}.out.md`) ? fs.readFileSync(`${basePath}.out.md`, 'utf8') : '');
      process.exit(0);
    }
    if (!alive(revived?.pid ?? s.pid ?? initial.pid)) { console.error(`broker.js ${mode}: процесс брокера ${revived?.pid ?? s.pid ?? initial.pid} завершился до конца хода`); process.exit(1); }
    if (Date.now() > deadline) { console.error(`broker.js ${mode}: таймаут ${sub.timeoutMin} мин, ход не завершился (turns ${s.turns ?? '?'} из ${baseline})`); process.exit(1); }
    await require('node:timers/promises').setTimeout(pollMs);
  }
}
}
