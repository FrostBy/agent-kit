'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const { slug, activated } = require('./activation');
const context = require('./context');
const names = require('./names');
const { humanClaude, userText, cleanText } = require('./messages');
const { claudeShell, codexShells, summary: shellSummary } = require('./user-shell');
const { claudeCalls } = require('./tool-mapping');
const { toolSummary } = require('./tool-summary');
const delivery = require('./delivery');
const { acquire } = require('./lease');
const processCache = require('./process-cache');
const { version } = require('./versions');
const { createCodexMirror } = require('./codex-mirror');
const MARK = '[session-sync:v2:';
const digest = x => createHash('sha256').update(x).digest('hex');
const other = kind => kind === 'claude' ? 'codex' : 'claude';
const same = (a, b) => { const norm = x => process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x); return norm(a) === norm(b); };
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const scope = new AsyncLocalStorage();

async function canonical(file) {
  let parent = path.resolve(file), tail = [];
  for (;;) {
    try { parent = await fs.realpath(parent); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  }
  return path.join(parent, ...tail);
}

// 8.3 short names and the \\?\ prefix differ textually from canonical paths; compare resolved paths.
async function samePath(a, b) {
  if (same(a, b)) return true;
  const plain = p => p.replace(/^\\\\\?\\/, '');
  return same(await canonical(plain(a)), await canonical(plain(b)));
}

async function withConfig(config, fn) {
  
  for (const key of ['cwd', 'stateDir', 'claudeProjectsDir', 'codexSessionsDir', 'codexHome']) {
    if (!config[key] || !path.isAbsolute(config[key])) throw Error(`Real config requires absolute ${key}`);
  }
  if (!same(config.codexSessionsDir, path.join(config.codexHome, 'sessions'))) throw Error('Invalid Codex sessions directory');
  const roots = await Promise.all([config.stateDir, config.claudeProjectsDir, config.codexSessionsDir, path.join(config.codexHome, 'archived_sessions')].map(canonical));
  const index = await canonical(path.join(config.codexHome, 'session_index.jsonl'));
  return scope.run({ roots, index }, fn);
}

async function confined(file) {
  const real = scope.getStore();
  if (real) {
    const resolved = await canonical(file);
    if (same(resolved, real.index) || real.roots.some(root => {
      const relative = path.relative(root, resolved);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })) return resolved;
    throw Error(`Real mode refuses path outside configured directories: ${file}`);
  }
  throw Error('Writes require an explicit sync configuration');
}

async function write(file, text, exclusive = false) {
  file = await confined(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (exclusive) return fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
  if (scope.getStore()) {
    // Real transcripts are created exclusively; existing sessions only receive hook context.
    if (file.endsWith('.jsonl') && !same(file, scope.getStore().index)) throw Error('Refusing to rewrite an existing session');
    try { await fs.copyFile(file, `${file}.bak-session-sync`, 1); }
    catch (e) { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e; }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { flag: 'wx' });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function rows(file) {
  const bytes = await fs.readFile(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // A writer may still be flushing its last record; never consume a partial line.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => ['text', 'input_text', 'output_text'].includes(b.type) ? b.text : '').filter(Boolean).join('\n');
}

function extract(kind, records, sessionId, context = {}) {
  if (kind === 'codex' && records.some(r => r.type === 'event_msg' && r.payload?.type === 'thread_rolled_back')) {
    throw Error('Codex rollback requires reconciliation; refusing to export reverted turns');
  }
  const result = [], calls = new Map(context.calls || []);
  const push = (id, role, text, compact = false) => {
    if (!text || (!compact && text.includes(MARK))) return;
    result.push({ key: digest(`${kind}:${sessionId}:${id}:${text}`), origin: kind, role, text, ...(context.model ? { model: context.model } : {}), ...(compact ? { compact: true } : {}) });
  };
  const pushTool = (id, text, name, input, output, details = {}) => {
    const before = result.length; push(id, 'assistant', text);
    if (result.length === before) return;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
    result.at(-1).tool = { name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_'), input: input && typeof input === 'object' ? input : { input }, output, ...details };
  };
  const pushShell = (id, shell) => {
    const before = result.length; push(`user-shell:${id}`, 'user', shellSummary(shell));
    if (result.length > before) result.at(-1).shell = shell;
  };
  for (const [localIndex, r] of records.entries()) {
    if (kind === 'claude' && r.session_sync_key) continue;
    if (r.message?.model) context.model = r.message.model;
    if ((r.type === 'turn_context' || r.type === 'session_meta') && r.payload?.model) context.model = r.payload.model;
    const index = (context.ordinal || 0) + localIndex;
    const compact = kind === 'codex' && (r.type === 'compacted' || (r.type === 'response_item' && r.payload?.type === 'compacted'));
    if (compact) {
      const p = r.payload || r;
      const history = p.replacement_history;
      if (!Array.isArray(history)) throw Error('Compaction missing replacement_history');
      const visible = history.filter(item => item.type === 'message' && ['user', 'assistant'].includes(item.role))
        .map(item => ({ role: item.role, text: item.role === 'user' ? userText('codex', {}, item) : textBlocks(item.content) })).filter(item => item.text);
      const summary = typeof p.message === 'string' && p.message ? cleanText('codex', p.message) : visible.shift()?.text;
      calls.clear();
      delete context.userShell;
      const compactId = p.id ?? index;
      push(compactId, 'user', summary || '[Compacted context: no visible summary.]', true);
      for (const [n, item] of visible.entries()) if (item.text !== summary) push(`${compactId}:replacement:${n}`, item.role, item.text);
      continue;
    }
    if (kind === 'claude') {
      if (!r.isSidechain && r.type === 'system' && r.subtype === 'compact_boundary') {
        calls.clear(); delete context.userShell; push(r.uuid ?? index, 'user', '[Compacted context: summary pending.]', true); continue;
      }
      if (!r.isSidechain && r.isCompactSummary) {
        calls.clear(); delete context.userShell; push(r.uuid ?? index, 'user', cleanText('claude', textBlocks(r.message?.content)), true); continue;
      }
      if (r.isSidechain || r.isMeta || r.isCompactSummary || r.type === 'attachment' || !r.message) continue;
      const p = r.message;
      if (!['user', 'assistant'].includes(p.role)) continue;
      if (p.role === 'user' && !humanClaude(r)) continue;
      if (p.role === 'user') {
        const shell = claudeShell(r, textBlocks(p.content), context, index);
        if (shell?.handled) { if (shell.shell) pushShell(shell.id, shell.shell); continue; }
        if (userText('claude', r, p)) delete context.userShell;
      }
      const blocks = Array.isArray(p.content) ? p.content : [];
      push(r.uuid ?? index, p.role, p.role === 'user' ? userText('claude', r, p) : textBlocks(p.content));
      for (const [n, b] of blocks.entries()) {
        if (b.type === 'tool_use') calls.set(b.id, { id: `${r.uuid}:${n}`, name: b.name, input: b.input, timestamp: r.timestamp });
        if (b.type === 'tool_result') {
          const call = calls.get(b.tool_use_id);
          if (!call) continue;
          const info = r.toolUseResult || {}, elapsed = Date.parse(r.timestamp) - Date.parse(call.timestamp);
          const duration = info.durationMs ?? info.duration_ms ?? (Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined);
          pushTool(`${call.id}:tool`, `[claude tool ${call.name}]\n${JSON.stringify(call.input)}\nResult:\n${textBlocks(b.content)}`, call.name, call.input, textBlocks(b.content), {
            isError: b.is_error === true, ...(Number.isInteger(info.exitCode ?? info.exit_code) ? { exitCode: info.exitCode ?? info.exit_code } : {}),
            ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
          });
          calls.delete(b.tool_use_id);
        }
      }
    } else {
      if (r.type !== 'response_item') continue;
      const p = r.payload, id = p.id ?? r.ordinal ?? index;
      if (['web_search_call', 'image_generation_call'].includes(p.type) && p.status === 'completed') {
        const name = p.type === 'web_search_call' ? 'web_search' : 'image_generation_call';
        pushTool(`${id}:tool`, `[codex tool ${name}]\nCompleted operation.`, name, { action: p.action }, 'Completed operation.');
        continue;
      }
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        if (p.role === 'user') for (const { index, shell } of codexShells(p)) pushShell(`${id}:${index}`, shell);
        push(id, p.role, p.role === 'user' ? userText('codex', r, p) : textBlocks(p.content));
      }
      if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) calls.set(p.call_id ?? p.id, { id, payload: p });
      if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
        const call = calls.get(p.call_id);
        if (!call) continue;
        const c = call.payload;
        const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        const exit = output?.match(/Process exited with code (-?\d+)/), duration = output?.match(/Wall time:\s*([\d.]+) seconds/);
        const failedPatch = c.name === 'apply_patch' && /^(?:Error:|Failed to|apply_patch.*failed|Invalid patch)/i.test(output || '');
        pushTool(`${call.id}:tool`, `[codex tool ${c.name ?? c.type}]\n${c.arguments ?? c.input ?? JSON.stringify(c.action)}\nResult:\n${output}`, c.name ?? c.type, c.arguments ?? c.input ?? c.action, output, {
          ...(exit ? { exitCode: Number(exit[1]), isError: Number(exit[1]) !== 0 } : {}),
          ...(failedPatch || p.is_error || p.output?.success === false ? { isError: true } : {}),
          ...(duration ? { durationMs: Number(duration[1]) * 1000 } : {}), isIncomplete: /Process running with session ID/i.test(output || ''),
        });
        calls.delete(p.call_id);
      }
    }
  }
  context.calls = [...calls]; context.ordinal = (context.ordinal || 0) + records.length;
  return result;
}

function encode(kind, endpoint, entries) {
  let parentUuid = null;
  let importedTodos = [];
  const timestamp = new Date().toISOString();
  if (kind === 'claude') entries = entries.flatMap(entry => {
    if (entry.shell) return [
      { ...entry, role: 'user', rawContent: `<bash-input>${entry.shell.command}</bash-input>` },
      { ...entry, role: 'user', rawContent: `<bash-stdout>${entry.shell.stdout}</bash-stdout><bash-stderr>${entry.shell.stderr}</bash-stderr>` },
    ];
    if (!entry.tool) return [entry];
    const calls = claudeCalls(entry.tool);
    if (!calls) return [{ ...entry, role: 'assistant', text: toolSummary(entry.tool) }];
    return calls.flatMap((call, n) => {
      const id = `toolu_sync_${entry.key.slice(0, 24)}_${n}`;
      const output = (entry.tool.output || '').split(/(?:^|\n)Final output:\r?\n/).at(-1);
      const toolUseResult = call.name === 'TodoWrite' ? { oldTodos: importedTodos, newTodos: call.input.todos }
        : call.name === 'Bash' ? { stdout: entry.tool.isError ? '' : output, stderr: entry.tool.isError ? output : '', interrupted: false, isImage: false }
        : call.name === 'Edit' ? { filePath: call.input.file_path, oldString: call.input.old_string, newString: call.input.new_string,
          originalFile: call.input.old_string, userModified: false, replaceAll: false, importedFragment: true,
          structuredPatch: [{ oldStart: 1, oldLines: call.input.old_string.split('\n').length, newStart: 1, newLines: call.input.new_string.split('\n').length,
            lines: [...call.input.old_string.split('\n').map(line => '-' + line), ...call.input.new_string.split('\n').map(line => '+' + line)] }] } : undefined;
      if (call.name === 'TodoWrite') importedTodos = call.input.todos;
      return [{ ...entry, role: 'assistant', blocks: [{ type: 'tool_use', id, name: call.name, input: call.input }] },
        { ...entry, role: 'user', toolUseResult, blocks: [{ type: 'tool_result', tool_use_id: id, content: output,
          ...(entry.tool.isError ? { is_error: true } : {}) }] }];
    });
  });
  return entries.map((e, index) => {
    const text = `${MARK}${e.key}]\n${e.text}`;
    if (kind === 'claude') {
      const uuid = randomUUID(), row = { type: e.role, uuid, parentUuid, sessionId: endpoint.id, isSidechain: false, session_sync_key: e.key,
        cwd: endpoint.cwd, version: endpoint.version, timestamp,
        ...(e.toolUseResult ? { toolUseResult: e.toolUseResult } : {}),
        message: e.role === 'user' ? { role: 'user', content: e.rawContent ?? e.blocks ?? text } : {
          id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: e.model || endpoint.model || 'unknown', content: e.blocks || [{ type: 'text', text }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 }
        } };
      parentUuid = uuid;
      return row;
    }
    return { timestamp, type: 'response_item', payload: { type: 'message', id: `msg_${randomUUID()}`,
      role: e.role, ...(e.role === 'assistant' ? { phase: 'final_answer' } : {}),
      content: [{ type: e.role === 'user' ? 'input_text' : 'output_text', text }] } };
  });
}

async function createMirror(pair, kind, config, events, options) {
  const endpoint = pair[kind], title = names.title(pair[other(kind)], other(kind));
  endpoint.cwd = await canonical(config.cwd);
  if (kind === 'codex') {
    await createCodexMirror(endpoint, title, events, config, {
      env: options.env || process.env, connect: options.connectCodex || config.connectCodex,
      checkpoint: options.checkpoint, confined, deadline: options.deadline, cutoff: pair.archiveSize, compactKey: pair.claude.active?.compactKey ?? null,
    });
    endpoint.appliedTitle = title;
    return;
  }
  const found = await version(kind, config, pair, options);
  if (typeof found === 'object') { found.cache[kind] = { value: found.value, at: Date.now() }; await write(found.file, JSON.stringify(found.cache)); }
  endpoint.version = typeof found === 'string' ? found : found.value;
  endpoint.model = pair[other(kind)].extraction?.model || 'unknown';
  const seed = encode(kind, endpoint, events);
  {
    if (!seed.some(row => row.type === 'user' && (typeof row.message.content === 'string'
      || row.message.content.some(block => block.type === 'text')))) {
      const first = encode(kind, endpoint, [{ role: 'user', key: 'seed', text: title }])[0];
      if (seed.length) seed[0].parentUuid = first.uuid;
      seed.unshift(first);
    }
    // Give prompt-only origins a completed assistant leaf before exposing them in resume.
    if (!seed.length || seed.at(-1).type !== 'assistant') {
      const tail = encode(kind, endpoint, [{ role: 'assistant', key: 'seed', text: 'Paired conversation imported. Ready to continue.' }])[0];
      tail.parentUuid = seed.at(-1)?.uuid ?? null;
      seed.push(tail);
    }
    await write(endpoint.file, jsonl([
      { type: 'session-sync-mirror', sessionId: endpoint.id, pairId: pair.id }, ...seed,
      { type: 'custom-title', sessionId: endpoint.id, customTitle: title }
    ]), true);
  }
  endpoint.seeded = true;
  endpoint.appliedTitle = title;
  endpoint.pending = [];
}

async function lock(root, fn) {
  await confined(path.join(root, 'lock'));
  const release = acquire(root);
  if (!release) return null;
  try { return await fn(); } finally { release(); }
}

// Build per-cwd roots without touching user configuration.
function configuration(cwd, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const claudeHome = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  cwd = path.resolve(cwd);
  const identity = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  const contextTokens = Number(env.SESSION_SYNC_CONTEXT_TOKENS || 50000);
  return { cwd, claudeHome, codexHome, contextTokens, claudeProjectsDir: path.join(claudeHome, 'projects'),
    codexSessionsDir: path.join(codexHome, 'sessions'), stateDir: path.join(claudeHome, 'agent-kit', 'sync', digest(identity)) };
}

// Preserve byte offsets only through complete lines, including across UTF-8 boundaries.
async function incremental(file, previous = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const sample = async (at, length) => {
      const b = Buffer.alloc(length);
      const { bytesRead } = await handle.read(b, 0, length, at);
      return b.subarray(0, bytesRead).toString('hex');
    };
    let cursor = { ...previous }, offset = cursor.offset || 0;
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const reset = cursor.identity !== identity || stat.size < (cursor.size || 0)
      || (stat.size === cursor.size && stat.mtimeMs !== cursor.mtime)
      || (offset && await sample(Math.max(0, offset - 128), Math.min(128, offset)) !== cursor.anchor);
    if (reset) { cursor = {}; offset = 0; }
    const chunks = [], buffer = Buffer.alloc(256 * 1024);
    let position = offset;
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); position += bytesRead;
    }
    const bytes = Buffer.concat(chunks), end = bytes.lastIndexOf(10) + 1;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    const records = text.split('\n').filter(Boolean).map(JSON.parse);
    const marks = new Set([...text.matchAll(/\[session-sync:v2:([a-f0-9]{64}|seed)\]/g)].map(m => m[1]));
    offset += end;
    cursor = { ...cursor, offset, identity, size: stat.size, mtime: stat.mtimeMs,
      anchor: await sample(Math.max(0, offset - 128), Math.min(128, offset)) };
    return { records, marks, cursor, reset, bytesRead: bytes.length };
  } finally { await handle.close(); }
}

async function processInteractive(kind, { run = promisify(execFile), platform = process.platform, pid: ownPid = process.pid } = {}) {
  let commands;
  if (platform === 'win32') {
    const script = `$n=${ownPid}; $commands=@(); for($i=0;$i -lt 16;$i++){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$n"; if(!$p){break}; $commands+= @{name=$p.Name;command=$p.CommandLine}; $n=$p.ParentProcessId }; ConvertTo-Json -Compress -InputObject $commands`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 });
    commands = JSON.parse(stdout);
  } else {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,comm=,args='], { timeout: 2000 });
    const processes = new Map(stdout.trim().split('\n').map(line => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m ? [+m[1], { parent: +m[2], name: path.basename(m[3]), command: m[4] }] : [0, {}];
    }));
    commands = []; let pid = ownPid;
    for (let n = 0; n < 16 && processes.has(pid); n++) { const p = processes.get(pid); commands.push(p); pid = p.parent; }
  }
  const cli = commands.filter(p => new RegExp(`^${kind}(\\.exe)?$`, 'i').test(p.name)
    || new RegExp(`(?:^|\\s)["']?[^"'\\s]*[\\\\/]${kind}(?:\\.js)?["']?(?:\\s|$)`, 'i').test(p.command || ''));
  const excluded = kind === 'claude' ? /(?:^|\s)"?(?:-p|--print)"?(?:\s|=|$)/ : /(?:^|\s)"?(?:exec|review|app-server)"?(?:\s|$)/;
  return cli.length > 0 && !cli.some(p => typeof p.command !== 'string' || !p.command.trim() || excluded.test(p.command));
}

async function eligible(kind, input, records, env = process.env, interactive = () => processInteractive(kind)) {
  if (env.SESSION_SYNC_EXCLUDE || env.SESSION_SYNC_BROKER || input.agent_id || input.isSidechain || input.is_sidechain) return false;
  if (kind === 'codex') {
    const meta = records.find(r => r.type === 'session_meta')?.payload;
    if (meta?.source !== 'cli' || meta?.originator !== 'codex-tui' || meta.parent_thread_id) return false;
  }
  if (kind === 'claude' && /[\\/]subagents[\\/]|[\\/]agent-[^\\/]+\.jsonl$/i.test(input.transcript_path)) return false;
  return Boolean(await interactive());
}

async function append(file, text) {
  file = await confined(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

async function hook(kind, input, config = configuration(input.cwd), options = {}) {
  if (!['claude', 'codex'].includes(kind)) throw Error('Invalid client');
  if (!input.session_id || !input.transcript_path || !input.cwd || !same(input.cwd, config.cwd)) return null;
  if (!['SessionStart', 'UserPromptSubmit', 'Stop'].includes(input.hook_event_name)) return null;
  const env = options.env || process.env;
  options = { ...options, deadline: Date.now() + 27000 };
  // Environment and input exclusions are cheap and must override a cached interactive session.
  if (env.SESSION_SYNC_EXCLUDE || env.SESSION_SYNC_BROKER || input.agent_id || input.isSidechain || input.is_sidechain) return null;
  if (!await activated(config)) return null;
  const tokens = config.contextTokens ?? 50000;
  if (!Number.isFinite(tokens) || tokens < 512) throw Error('Sync context budget must be at least 512 tokens');
  const budget = Math.floor(tokens * 4);
  return withConfig(config, async () => {
    const root = await canonical(kind === 'claude' ? config.claudeProjectsDir : config.codexSessionsDir);
    const rel = path.relative(root, await canonical(input.transcript_path));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error('Transcript outside configured client directory');
    return lock(config.stateDir, async () => {
      const registryFile = path.join(config.stateDir, 'pairs.json');
      const registry = await readJson(registryFile, { version: 3, pairs: [] });
      if (registry.version !== 3 || !Array.isArray(registry.pairs)) throw Error('Invalid pair registry; legacy state must be imported explicitly');
      const mapping = registry.pairs.find(p => p[kind] === input.session_id);
      if (mapping && !/^[\w-]+$/.test(mapping.id)) throw Error('Invalid pair ID');
      let pair = mapping ? await readJson(path.join(config.stateDir, `${mapping.id}.json`)) : null;
      if (mapping && !pair) throw Error('Pair state missing');
      const beforePair = pair ? JSON.stringify(pair) : null;
      if (pair && ((pair[kind].file && !await samePath(pair[kind].file, input.transcript_path)) || !await samePath(pair[kind].cwd, config.cwd))) throw Error('Session transcript path changed');
      const reads = {};
      async function scan(client, endpoint) {
        if (endpoint.mirror && !endpoint.seeded) return null;
        const clientRoot = await canonical(client === 'claude' ? config.claudeProjectsDir : config.codexSessionsDir);
        const relative = path.relative(clientRoot, await canonical(endpoint.file));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Transcript outside configured client directory');
        let read;
        try { read = await incremental(endpoint.file, endpoint.active ? endpoint.cursor : undefined); }
        catch (e) {
          if (e.code === 'ENOENT' && ((endpoint.mirror && !endpoint.seeded) || (client === 'claude' && input.hook_event_name === 'SessionStart'))) return null;
          throw e;
        }
        const meta = client === 'codex' ? read.records.find(r => r.type === 'session_meta')?.payload : read.records.find(r => r.sessionId);
        endpoint.meta = meta ? (client === 'claude' ? { sessionId: meta.sessionId, cwd: meta.cwd, version: meta.version }
          : { id: meta.id, cwd: meta.cwd, source: meta.source, originator: meta.originator, cli_version: meta.cli_version, parent_thread_id: meta.parent_thread_id, session_sync: meta.session_sync }) : (read.reset ? null : endpoint.meta);
        if (endpoint.meta && (endpoint.meta.id ?? endpoint.meta.sessionId) !== endpoint.id) throw Error('Transcript/session ID mismatch');
        if (endpoint.meta?.cwd && !await samePath(endpoint.meta.cwd, config.cwd)) throw Error('Transcript cwd mismatch');
        return read;
      }
      const decisions = await processCache.decisions(config.stateDir);
      if (decisions.changed) await write(decisions.file, JSON.stringify(decisions.state));
      const decisionKey = `${kind}:${digest(input.session_id)}`;
      const sourceEndpoint = pair?.[kind] || { id: input.session_id, file: input.transcript_path, cwd: config.cwd };
      let cliIdentity = sourceEndpoint.cliIdentity;
      if (input.hook_event_name === 'SessionStart' || sourceEndpoint.eligible === undefined) {
        cliIdentity = options.cliIdentity !== undefined ? options.cliIdentity
          : options.interactive ? `test-parent:${process.ppid}` : await processCache.identity(kind);
      }
      const decision = decisions.state.entries[decisionKey];
      if (!pair && cliIdentity && decision?.cliIdentity === cliIdentity && same(decision.file, input.transcript_path)) return null;
      reads[kind] = await scan(kind, sourceEndpoint);
      const source = reads[kind]?.records || [];
      const eligibilityRecords = kind === 'codex' ? [{ type: 'session_meta', payload: { ...sourceEndpoint.meta,
        ...(sourceEndpoint.mirror && sourceEndpoint.managed === 'app-server' && sourceEndpoint.meta?.originator === 'agent-kit-session-sync'
          ? { source: 'cli', originator: 'codex-tui' } : {}) } }] : source;
      if (!pair && (source.some(r => r.type === 'session-sync-mirror') || sourceEndpoint.meta?.session_sync?.mirror || sourceEndpoint.meta?.originator === 'agent-kit-session-sync')) throw Error('Orphan mirror: refusing mirror of mirror');
      if (sourceEndpoint.eligible === undefined || (input.hook_event_name === 'SessionStart' && (!cliIdentity || sourceEndpoint.cliIdentity !== cliIdentity))) {
        sourceEndpoint.eligible = await eligible(kind, input, eligibilityRecords, env, options.interactive);
        sourceEndpoint.cliIdentity = cliIdentity;
      }
      sourceEndpoint.eligible = await eligible(kind, input, eligibilityRecords, env, async () => sourceEndpoint.eligible);
      if (!sourceEndpoint.eligible) {
        if (pair && JSON.stringify(pair) !== beforePair) await write(path.join(config.stateDir, `${pair.id}.json`), JSON.stringify(pair));
        else if (!pair) {
          processCache.remember(decisions.state, decisionKey, { file: input.transcript_path, cliIdentity });
          await write(decisions.file, JSON.stringify(decisions.state));
        }
        return null;
      }
      if (!pair) {
        const target = other(kind), id = randomUUID(), day = new Date().toISOString().slice(0, 10);
        const file = target === 'claude'
          ? path.join(config.claudeProjectsDir, slug(config.cwd), `${id}.jsonl`)
          : path.join(config.codexSessionsDir, ...day.split('-'), `rollout-${day}T00-00-00-${id}.jsonl`);
        pair = { id: randomUUID(), archiveSize: 0, known: [], [kind]: { ...sourceEndpoint, pending: [] },
          [target]: { id, file, cwd: config.cwd, mirror: true, seeded: false, pending: [] } };
        registry.pairs.push({ id: pair.id, claude: pair.claude.id, codex: pair.codex.id });
      } else pair[kind] = sourceEndpoint;
      const journal = path.join(config.stateDir, `${pair.id}.events`), known = new Set(pair.known);
      // An interrupted append is uncommitted until the atomic pair checkpoint records its size.
      await confined(journal);
      if (pair.archiveSize) {
        const st = await fs.stat(journal);
        if (st.size < pair.archiveSize) throw Error('Event archive truncated');
        if (st.size > pair.archiveSize) await fs.truncate(journal, pair.archiveSize);
      } else { try { await fs.truncate(journal, 0); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      const additions = [];
      for (const client of [kind, other(kind)]) {
        const endpoint = pair[client];
        const read = reads[client] || await scan(client, endpoint);
        if (!read) continue;
        if (read.reset) {
          if (endpoint.cursor && pair.archiveSize) for (const event of await rows(journal)) known.add(event.key);
          endpoint.extraction = {}; endpoint.active = null;
        }
        if (!endpoint.mirror) names.observe(endpoint, client, read.records, read.reset);
        endpoint.extraction ||= {};
        const events = extract(client, read.records, endpoint.id, endpoint.extraction);
        endpoint.cursor = read.cursor;
        delivery.acknowledge(endpoint, read.marks);
        const rebuilding = !endpoint.active;
        endpoint.active ||= { tail: [], tailBytes: 0, summary: null, compactKey: null, omitted: false };
        for (const event of events) if (!known.has(event.key) || rebuilding) {
          const text = JSON.stringify(event) + '\n', length = Buffer.byteLength(text);
          const ref = { key: event.key, offset: pair.archiveSize, length, bytes: Buffer.byteLength(event.text) };
          if (!known.has(event.key)) pair[other(client)].pending.push(ref);
          context.update(endpoint, ref, event, budget);
          additions.push(text); pair.archiveSize += length; known.add(event.key);
        }
      }
      pair.known = [...known].slice(-256);
      if (additions.length) await append(journal, additions.join(''));
      for (const client of ['claude', 'codex']) {
        const endpoint = pair[client], active = pair[other(client)].active;
        if (active && (((active.compactKey ?? null) !== (endpoint.compactAcknowledged ?? null) && active.compactKey !== endpoint.snapshot?.compactKey)
          || endpoint.pending.reduce((sum, ref) => sum + (ref.bytes ?? ref.length) + 120, 0) > budget - 1024)) {
          endpoint.snapshot = context.snapshot(active, budget); endpoint.pending = []; endpoint.inflight = [];
        }
      }
      if (!pair.codex.mirror) await names.sourceName(pair.codex, config, { env, connect: options.connectCodex || config.connectCodex, refresh: input.hook_event_name === 'SessionStart' && kind === 'codex' });
      const pairFile = path.join(config.stateDir, `${pair.id}.json`);
      if (!mapping || ['claude', 'codex'].some(client => pair[client].mirror && !pair[client].seeded)) await write(pairFile, JSON.stringify(pair));
      if (!mapping) await write(registryFile, JSON.stringify(registry));
      for (const client of ['claude', 'codex']) if (pair[client].mirror && !pair[client].seeded) {
        const active = pair[other(client)].active;
        const events = active && pair.archiveSize ? await context.materialize(journal, active, budget) : [];
        try {
          await createMirror(pair, client, config, events, { ...options, checkpoint: async () => {
            const entry = registry.pairs.find(entry => entry.id === pair.id); entry.codex = pair.codex.id;
            await write(pairFile, JSON.stringify(pair)); await write(registryFile, JSON.stringify(registry));
          } });
        } catch (error) {
          if (client !== 'codex') throw error;
          const message = `Codex mirror deferred: ${error.message || JSON.stringify(error)}\n`;
          await fs.appendFile(await confined(path.join(config.stateDir, 'sync.log')), message, { mode: 0o600 });
          await write(pairFile, JSON.stringify(pair));
          return null;
        }
        pair[client].snapshot = null;
        pair[client].compactAcknowledged = pair[client].seedState?.compactKey ?? active?.compactKey ?? null;
        delete pair[client].seedState;
      }
      for (const client of ['claude', 'codex']) {
        const endpoint = pair[client];
        if (!endpoint.mirror || !endpoint.seeded) continue;
        const title = names.title(pair[other(client)], other(client));
        if (endpoint.appliedTitle === title) continue;
        try {
          if (client === 'codex') await names.renameCodex(endpoint, title, config, { env, connect: options.connectCodex || config.connectCodex });
          else await append(endpoint.file, jsonl([{ type: 'custom-title', sessionId: endpoint.id, customTitle: title }]));
          endpoint.appliedTitle = title;
        } catch (error) { await fs.appendFile(await confined(path.join(config.stateDir, 'sync.log')), `Mirror rename deferred: ${error.message}\n`, { mode: 0o600 }); }
      }
      let output = null;
      if (input.hook_event_name !== 'Stop') {
        const text = await delivery.output(kind, pair[kind], journal, budget, context);
        if (text) output = { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } };
      }
      const checkpoint = JSON.stringify(pair);
      if (checkpoint !== beforePair) await write(pairFile, checkpoint);
      return output;
    });
  });
}

function hookConfigs(script) {
  const events = ['SessionStart', 'UserPromptSubmit', 'Stop'];
  const command = kind => `node "${script.replaceAll('\\', '/')}" hook ${kind}`;
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command: command('claude'), timeout: 30 }] }]]));
  const codex = events.map(event => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command('codex'))}\ntimeout = 30\n${event !== 'Stop' ? 'additionalContextLimit = 16000\n' : ''}`).join('\n');
  return { claude: { hooks }, codex };
}

module.exports = { configuration, hook, hookConfigs, incremental, extract, encode, eligible, processInteractive, withConfig, write, rows };
