'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const wakeTypes = new Set(['question', 'approval', 'turn.completed', 'error', 'agent.exited']);
const summary = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 320);
function readEvents(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  // The broker may be appending the final line while a reader is scanning it.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function eventWriter(base, name) {
  const file = `${base}.events.jsonl`, instance = randomUUID();
  const existing = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  if (existing.length && existing.at(-1) !== 10) fs.truncateSync(file, existing.lastIndexOf(10) + 1);
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  const history = readEvents(file);
  let seq = history.at(-1)?.seq || 0;
  const emit = (type, payload = {}, context = {}) => {
    const event = { v: 1, id: `${name}:${instance}:${++seq}`, seq, at: new Date().toISOString(), from: name,
      type, turnId: context.turnId ?? null, requestId: context.requestId ?? null,
      summary: summary(context.summary ?? payload.message ?? type), payload };
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
    return event;
  };
  const resolved = new Set(history.filter(e => e.type === 'request.resolved').map(e => e.requestId));
  for (const event of history) if (['question', 'approval'].includes(event.type) && !resolved.has(event.requestId)) {
    emit('request.resolved', { reason: 'broker restarted' }, { requestId: event.requestId, turnId: event.turnId, summary: 'broker restarted' });
  }
  return emit;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function lock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.mesh-events.lock');
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid;
      try { pid = Number(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (!pid || alive(pid)) throw Object.assign(Error('An events waiter already owns this DIR'), { code: 'EVENTS_LOCKED' });
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
}
function cursor(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.mesh-events.cursor.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function saveCursor(dir, value) {
  const file = path.join(dir, '.mesh-events.cursor.json'), tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function eventFiles(dir, suffix = '.events.jsonl') {
  // Match the statusline's scratchpad layout: brokers can also live one directory down.
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const matches = name => name.endsWith(suffix) && /^[\w-]+$/.test(name.slice(0, -suffix.length));
    if (entry.isFile() && matches(entry.name)) return [entry.name];
    if (!entry.isDirectory() || entry.name.endsWith('.inbox') || entry.name.startsWith('.')) return [];
    return fs.readdirSync(path.join(dir, entry.name)).filter(matches).map(f => path.join(entry.name, f));
  });
}
function brokerStates(dir) {
  let files;
  try { files = eventFiles(dir, '.state.json'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.flatMap(file => {
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return [];
      if (e instanceof SyntaxError) return [{ unreadable: true }];
      throw e;
    }
    return [{ ...state, base: path.join(dir, file.slice(0, -'.state.json'.length)) }];
  });
}
function hasLiveBroker(dir) {
  return brokerStates(dir).some(state => state.unreadable || (!['done', 'error'].includes(state.status) && alive(state.pid)));
}
function detectDeaths(dir) {
  for (const state of brokerStates(dir)) {
    if (['done', 'error'].includes(state.status) || !state.pid || alive(state.pid)) continue;
    const events = readEvents(`${state.base}.events.jsonl`);
    if (events.some(e => e.type === 'agent.exited' && e.payload?.pid === state.pid)) continue;
    eventWriter(state.base, path.basename(state.base))('agent.exited', { reason: 'unexpected', pid: state.pid }, { summary: 'Broker process died unexpectedly' });
  }
}
async function nextEvent(dir, { timeoutMin = 120, pollMs = 250, signal, wakeOnly = false } = {}) {
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw Error('Invalid events timeout/poll interval');
  const release = lock(dir), deadline = Date.now() + timeoutMin * 60000;
  try {
    for (;;) {
      if (wakeOnly) detectDeaths(dir);
      else signal?.throwIfAborted();
      const seen = cursor(dir), candidates = [];
      for (const file of eventFiles(dir)) {
        const events = readEvents(path.join(dir, file));
        const resolved = new Set(events.filter(e => e.type === 'request.resolved').map(e => e.requestId));
        const next = events.find(e => e.seq > (seen[file] || 0) && wakeTypes.has(e.type) &&
          (!wakeOnly || e.type !== 'agent.exited' || ['error', 'unexpected'].includes(e.payload?.reason) || e.payload?.status === 'error' || e.payload?.code > 0) &&
          !(['question', 'approval'].includes(e.type) && resolved.has(e.requestId)));
        if (next) candidates.push({ ...next, file });
      }
      candidates.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      if (candidates.length) {
        const event = candidates[0];
        // Consumption is the cursor ACK, committed under the same exclusive waiter lock.
        seen[event.file] = event.seq; saveCursor(dir, seen);
        return event;
      }
      if (Date.now() >= deadline) return null;
      if (wakeOnly && !hasLiveBroker(dir)) return null;
      signal?.throwIfAborted();
      await sleep(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
    }
  } finally { release(); }
}
function ack(dir, id) {
  const release = lock(dir);
  try {
    const seen = cursor(dir);
    for (const file of eventFiles(dir)) {
      const event = readEvents(path.join(dir, file)).find(e => e.id === id);
      if (event) { seen[file] = Math.max(seen[file] || 0, event.seq); saveCursor(dir, seen); return; }
    }
    throw Error('Unknown event ID');
  } finally { release(); }
}
function formatEvent(event, dir) {
  const script = path.resolve(__dirname, '../../scripts/agents/broker.js').replace(/\\/g, '/');
  const stateDir = path.resolve(dir, path.dirname(event.file || '.'));
  const target = `--name ${event.from} --state ${JSON.stringify(stateDir)}`;
  let command;
  if (event.type === 'question') command = `answer ${target} --request ${event.requestId} --file ANSWERS.json (or --text for one question)`;
  else if (event.type === 'approval') command = `approve ${target} --request ${event.requestId} (or deny)`;
  else command = `event consumed; full result: ${path.join(stateDir, event.from + '.out.md')}`;
  return `[mesh] ${event.from} ${event.type}${event.requestId ? ` requestId=${event.requestId}` : ''}: ${event.summary}\n${command.startsWith('event ') ? '' : `node "${script}" `}${command}\neventId=${event.id}`;
}
function questionResult(params, payload) {
  const questions = params.questions || [];
  if (!questions.length) throw Error('Request has no questions');
  let result = payload.result;
  if (payload.text !== undefined) {
    if (questions.length !== 1 || typeof payload.text !== 'string' || !payload.text.trim()) throw Error('Use --file for multiple questions');
    result = { answers: { [questions[0].id]: { answers: [payload.text] } } };
  }
  const answers = result?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== questions.length) throw Error('Expected answers for every question ID');
  for (const q of questions) {
    const values = Object.hasOwn(answers, q.id) && answers[q.id]?.answers;
    if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim())) throw Error(`Invalid answer for ${q.id}`);
    if (q.options?.length && !q.isOther && values.some(v => !q.options.some(o => o.label === v))) throw Error(`Unknown option for ${q.id}`);
  }
  return { answers };
}
function approvalResult(method, params, approve) {
  if (method === 'item/permissions/requestApproval') {
    // A bare approval grants exactly the requested permissions, for this turn only.
    return { permissions: approve ? params.permissions : {}, scope: 'turn' };
  }
  const decision = approve ? 'accept' : 'decline';
  if (params.availableDecisions && !params.availableDecisions.includes(decision)) throw Error(`Decision ${decision} is not available`);
  return { decision };
}
async function runCommand(argv) {
  const [command, ...args] = argv, opt = {};
  const values = new Set(['--name', '--state', '--request', '--text', '--file', '--event', '--timeout-min']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--next') { opt.next = true; continue; }
    if (!values.has(key) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw Error(`Invalid argument ${key}`);
    opt[key.slice(2)] = args[++i];
  }
  if (!opt.state) throw Error('--state DIR is required');
  const dir = path.resolve(opt.state);
  if (command === 'events') {
    if (!opt.next) throw Error('events requires --next');
    const event = await nextEvent(dir, { timeoutMin: Number(opt['timeout-min'] ?? 120), pollMs: Number(process.env.BROKER_POLL_MS ?? 250) });
    if (!event) { process.exitCode = 1; return; }
    console.log(formatEvent(event, dir)); return;
  }
  if (command === 'ack') { if (!opt.event) throw Error('--event ID is required'); ack(dir, opt.event); return; }
  if (!/^[\w-]+$/.test(opt.name || '')) throw Error('Invalid agent name');
  if (['answer', 'approve', 'deny'].includes(command) && !opt.request) throw Error('--request ID is required');
  if (command === 'answer' && (Number(opt.text !== undefined) + Number(opt.file !== undefined) !== 1)) throw Error('answer requires --text or --file JSON');
  const state = JSON.parse(fs.readFileSync(path.join(dir, `${opt.name}.state.json`), 'utf8'));
  if (state.agent !== 'codex' || ['done', 'error'].includes(state.status) || !alive(state.pid)) throw Error('No live Codex broker');
  const envelope = { v: 1, id: randomUUID(), type: command, payload: { requestId: opt.request,
    ...(opt.text !== undefined ? { text: opt.text } : {}), ...(opt.file ? { result: JSON.parse(fs.readFileSync(opt.file, 'utf8')) } : {}) } };
  const inbox = path.join(dir, `${opt.name}.inbox`), tmp = path.join(inbox, `.tmp-${envelope.id}`);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, path.join(inbox, `${String(Date.now()).padStart(15, '0')}-${envelope.id}.command.json`));
  console.log(`queued ${envelope.id}`);
}
module.exports = { eventWriter, nextEvent, ack, formatEvent, questionResult, approvalResult, runCommand, hasLiveBroker, brokerStates, alive, detectDeaths };
