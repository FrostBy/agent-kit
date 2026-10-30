#!/usr/bin/env node
// Живая сессия внешнего агента (Codex через общий app-server, Kimi через -S) с почтовым ящиком.
// Сообщения - файлы в <state>/<name>.inbox/ (любое имя, порядок по имени): во время хода Codex
// уходят как turn/steer, после хода - новым ходом в ту же сессию. Команды в файле: /interrupt, /exit.
// Выход: <name>.out.md - последний ответ агента, <name>.history.md - все ходы, <name>.log - события,
// <name>.state.json - {status: starting|running|idle|reconnecting|done|error, turns, threadId|sessionId, lastTurnStatus}.
// Десктопный Codex и обычный `codex exec` не затрагиваются: подключение - обычный клиент демона
// через `codex app-server proxy`, config.toml не меняется, настройки идут параметрами потока.
'use strict';
const { spawn } = require('node:child_process');
const { connectProxy } = require('../../src/agents/codex-client');
const { plain } = require('../../src/agents/codex-path');
const { syncThreads } = require('../../src/agents/sync-protection');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SYNC_BROKER = '1';
const argv = process.argv.slice(2);
const opt = { images: [], claudeConfigDirs: [] };
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  const v = () => { const value = argv[++i]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${k}`); return value; };
  if (k === '--agent') opt.agent = v();
  else if (k === '--name') opt.name = v();
  else if (k === '--state') opt.state = v();
  else if (k === '--prompt') opt.prompt = v();
  else if (k === '--cwd') opt.cwd = v();
  else if (k === '--model') opt.model = v();
  else if (k === '--effort') opt.effort = v();
  else if (k === '--sandbox') opt.sandbox = v();
  else if (k === '--network') opt.network = true;
  else if (k === '--search') opt.search = true;
  else if (k === '--image') opt.images.push(v());
  else if (k === '--idle-min') opt.idleMin = Number(v());
  else if (k === '--claude-config-dir') opt.claudeConfigDirs.push(v());
  else throw new Error(`unknown arg ${k}`);
}
if (!opt.agent || !opt.name || !opt.state || !opt.prompt) {
  console.error('usage: agent-broker --agent codex|kimi --name X --state DIR --prompt FILE [--cwd DIR] [--model M] [--effort E] [--sandbox read-only|workspace-write] [--network] [--search] [--image PNG]... [--idle-min 60] [--claude-config-dir DIR]...');
  process.exit(2);
}
if (!/^[\w-]+$/.test(opt.name)) throw Error('Invalid agent name');
if (!['codex', 'kimi'].includes(opt.agent)) throw Error('Invalid agent');
opt.cwd = path.resolve(opt.cwd ?? process.cwd());
opt.idleMin ??= 60;
if (!Number.isFinite(opt.idleMin) || opt.idleMin <= 0) throw Error('Invalid --idle-min');
const base = path.join(path.resolve(opt.state), opt.name);
const inbox = `${base}.inbox`;
fs.mkdirSync(inbox, { recursive: true });
let previous;
if (opt.agent === 'codex') {
  try { previous = JSON.parse(fs.readFileSync(`${base}.state.json`, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (previous?.agent === 'codex' && previous.threadId && !/^[\w-]+$/.test(previous.threadId)) throw Error('Invalid saved thread ID');
if (previous?.pid && previous.pid !== process.pid && !['done', 'error'].includes(previous.status)) {
  let live = true; try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
  if (live) throw Error('Broker state is owned by a live process');
}
const state = { ...(previous?.agent === opt.agent ? previous : {}), agent: opt.agent, status: 'starting', turns: previous?.agent === opt.agent ? previous.turns || 0 : 0, pid: process.pid };
const save = () => fs.writeFileSync(`${base}.state.json`, JSON.stringify(state, null, 2));
const log = (s) => fs.appendFileSync(`${base}.log`, `[${new Date().toISOString()}] ${s}\n`);
const finishTurn = (text) => {
  state.turns++;
  fs.writeFileSync(`${base}.out.md`, text ?? '');
  fs.appendFileSync(`${base}.history.md`, `\n\n## Ход ${state.turns}\n\n${text ?? ''}\n`);
  log(`turn ${state.turns} done`);
};
let lastActivity = Date.now();
const takeInbox = () => {
  const files = fs.readdirSync(inbox).filter((f) => !f.startsWith('.')).sort();
  return files.map((f) => {
    const p = path.join(inbox, f);
    const text = fs.readFileSync(p, 'utf8');
    fs.renameSync(p, path.join(inbox, `.sent-${Date.now()}-${f}`));
    return text.trim();
  });
};
let shutdownCodex;
const done = (status, code = 0) => {
  if (shutdownCodex) return shutdownCodex(status, code);
  state.status = status;
  save();
  log(`exit ${status}`);
  process.exit(code);
};

if (opt.agent === 'codex') runCodex();
else if (opt.agent === 'kimi') runKimi();
else throw new Error(`unknown agent ${opt.agent}`);

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
      approvalPolicy: 'never',
      ...(opt.model ? { model: opt.model } : {}),
      ...(opt.sandbox ? { sandbox: opt.sandbox } : {}),
      ...(Object.keys(config).length ? { config } : {}),
    };
  };

  function connect() {
    if (closing) return;
    const c = connectProxy({ env: process.env, mode: 'proxy', spawn, log, timeout: REQUEST_MS,
      onNotification: msg => onMessage(c, msg),
      onDisconnect: why => {
        clearInterval(c.ticker); log(`connection lost: ${why}`);
        if (!closing) reconnect();
      } });
    conn = c;
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

  shutdownCodex = async (status, code = 0) => {
    if (closing) return;
    closing = true; clearInterval(conn?.ticker);
    state.archived = false;
    try {
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
      conn?.close(); process.exit(code);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void done('done'); });
  process.on('beforeExit', () => { if (!closing) void done('done'); });

  function onMessage(c, msg) {
    if (closing) return;
    const m = msg.method;
    const p = msg.params ?? {};
    if (p.threadId && threadId && p.threadId !== threadId) return;
    lastActivity = Date.now();
    if (m === 'turn/started') { turnId = p.turn?.id ?? turnId; state.status = 'running'; state.turnId = turnId; save(); log(`turn started ${turnId}`); }
    else if (m === 'item/completed') {
      const item = p.item ?? {};
      if (item.type === 'agentMessage') lastText = item.text ?? lastText;
      else if (item.type === 'commandExecution') log(`cmd ${String(item.command ?? '').slice(0, 200)}`);
      else if (item.type === 'fileChange') log(`files ${JSON.stringify((item.changes ?? []).map((ch) => ch.path)).slice(0, 300)}`);
    } else if (m === 'turn/completed') completeTurn(p.turn ?? {}, lastText);
    else if (m === 'error') {
      log(`error ${JSON.stringify(p).slice(0, 400)}`);
      if (isDrain(p.error ?? p)) c.lost('server draining');
    }
  }

  function completeTurn(turn, text) {
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
      queue.push(...takeInbox());
      while (!closing && queue.length && conn?.alive) {
        const text = queue.shift();
        try { await handle(text); }
        catch (e) {
          if (isDrain(e)) { queue.unshift(text); log('message kept for after reconnect'); conn?.lost('request failed: draining'); break; }
          log(`message failed ${JSON.stringify(e).slice(0, 300)}`);
          finishTurn(`[broker] сообщение не принято сервером: ${JSON.stringify(e).slice(0, 300)}`);
          state.status = turnId ? 'running' : 'idle';
          save();
        }
      }
    } finally {
      busy = false;
    }
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
      c.ticker = setInterval(() => {
        pump();
        if (!closing && state.status === 'idle' && Date.now() - lastActivity > opt.idleMin * 60_000) void done('done');
      }, 1000);
      pump();
    } catch (e) {
      log(`boot failed ${JSON.stringify(e).slice(0, 400)}`);
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
  let session = null;
  const turn = (text) => new Promise((resolve) => {
    state.status = 'running';
    save();
    const args = ['-m', model, ...(session ? ['-S', session] : []), '-p', text];
    const p = spawn(process.env.AGENT_BROKER_KIMI || 'kimi', args, { windowsHide: true, cwd: opt.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; lastActivity = Date.now(); });
    p.stderr.on('data', (d) => { err += d; log(`kimi stderr ${String(d).trim().slice(0, 300)}`); });
    p.on('error', (error) => { log(error.message); done('error', 1); });
    p.on('exit', (code) => {
      // Kimi печатает «To resume this session: kimi -r session_<id>» в stderr.
      const m = `${out}\n${err}`.match(/kimi -r (session_[\w-]+)/);
      if (m) { session = m[1]; state.sessionId = session; }
      log(`kimi exit ${code}`);
      finishTurn(out.replace(/\n?To resume this session:.*$/s, '').trim());
      state.status = 'idle';
      save();
      resolve();
    });
  });
  (async () => {
    await turn(fs.readFileSync(opt.prompt, 'utf8'));
    for (;;) {
      const msgs = takeInbox();
      for (const text of msgs) {
        if (text === '/exit') done('done');
        if (text === '/interrupt') continue;
        await turn(text);
      }
      if (Date.now() - lastActivity > opt.idleMin * 60_000) done('done');
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}
