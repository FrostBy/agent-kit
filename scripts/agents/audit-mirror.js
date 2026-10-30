#!/usr/bin/env node
'use strict';
// Read-only: no hook(), app-server, credentials, caches or transcript writes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { extract, encode } = require('../../src/sync');
const { visible } = require('../../src/sync/presentation');
const SERVICE = /(?:<(?:\/?)(?:system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-caveat|user-memory-input|environment_context|user_instructions|turn_aborted|hook_prompt|additional_context|subagent_notification|agent-message|codex_internal_context|goal_context|bash-input|bash-stdout|bash-stderr|user_shell_command|persisted-output)\b|# AGENTS\.md instructions)/i;
function category(kind, row, context) {
  const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
  const use = blocks.find(b => b.type === 'tool_use'), result = blocks.find(b => b.type === 'tool_result');
  if (use) return `${kind}:call/${use.name}`;
  if (result) { const call = new Map(context.calls || []).get(result.tool_use_id); return `${kind}:result/${call?.name || 'unmatched'}`; }
  const p = row.payload;
  if (kind === 'codex' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p?.type)) return `${kind}:call/${p.name || p.type}`;
  if (kind === 'codex' && ['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p?.type)) {
    const call = new Map(context.calls || []).get(p.call_id); return `${kind}:result/${call?.payload?.name || 'unmatched'}`;
  }
  const role = row.message?.role || (p?.type === 'message' ? p.role : null);
  if (role) {
    const content = row.message?.content || p?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => b.text || '').join('\n') : '';
    const origin = row.origin?.kind || row.turnOrigin || (row.isMeta ? 'meta' : 'legacy');
    const tags = [...new Set([...text.matchAll(/<([\w-]+)(?:\s[^>]*)?>/g)].map(m => m[1]))];
    const service = tags.find(t => /^(?:bash-|user_shell_command|system-reminder|task-notification|local-command|command-|user-memory|environment_context|user_instructions|hook_prompt|turn_aborted|agent-message|codex_internal_context|goal_context)/.test(t));
    return `${kind}:${role}/${origin}${service ? '/' + service : ''}`;
  }
  return `${kind}:${row.type}${p?.type ? '/' + p.type : ''}`;
}
function classify(kind, entry, cwd) {
  if (kind === 'claude') {
    const display = visible([entry], cwd)[0], item = display.item;
    const raw = !item && ((entry.tool || display.role === 'assistant') && /^\[(?:Tool|Codex|claude tool|codex tool)\b/.test(display.text) || entry.tool && display.text.length > 320);
    const leak = display.role === 'user' && !entry.shell && SERVICE.test(display.text);
    let route = raw || leak ? 'RAW' : item?.type === 'FileChange' ? 'patch' : item?.type === 'CommandExecution'
      ? item.parsed_cmd?.some(p => ['read', 'search', 'list_files'].includes(p.type)) ? 'explored' : 'native exec'
      : item?.type === 'Plan' ? 'native plan' : item?.type === 'WebSearch' ? 'native web' : entry.tool ? 'summary' : 'message';
    const example = item ? `${item.type}${item.source === 'user_shell' ? ' (user)' : ''}` : entry.tool ? display.text : `${display.role} text (${display.text.length} chars)`;
    return { route, leak: Number(leak), example };
  }
  const rows = encode('claude', { id: 'audit', cwd, version: 'audit' }, [entry]);
  const calls = rows.flatMap(row => Array.isArray(row.message.content) ? row.message.content.filter(b => b.type === 'tool_use') : []);
  const text = rows.filter(row => row.message.role === 'assistant').flatMap(row => row.message.content || []).map(b => b.text || '').join('\n');
  const leak = rows.some(row => row.message.role === 'user' && typeof row.message.content === 'string' && !entry.shell && SERVICE.test(row.message.content));
  const body = text.replace(/\[session-sync:v2:[^\]]+\]\n/g, '').trim();
  const raw = !calls.length && ((entry.tool || entry.role === 'assistant') && /^\[(?:Tool|Codex|claude tool|codex tool)\b/.test(body) || entry.tool && body.length > 320);
  const route = raw || leak ? 'RAW' : entry.shell || calls.some(c => c.name === 'Bash') ? 'native exec'
    : calls.some(c => ['Edit', 'Write', 'MultiEdit'].includes(c.name)) ? 'patch'
      : calls.some(c => c.name === 'TodoWrite') ? 'native plan' : calls.some(c => ['WebSearch', 'WebFetch'].includes(c.name)) ? 'native web'
        : entry.tool ? 'summary' : 'message';
  // Samples are presentation labels/lengths, never conversation bodies, commands or tool arguments.
  return { route, leak: Number(leak), example: calls.length ? calls.map(c => c.name).join('+') : entry.shell ? 'Claude bash-mode input/output' : entry.tool ? text.replace(/\[session-sync:v2:[^\]]+\]\n/g, '').trim() : `${entry.role} text (${entry.text.length} chars)` };
}
async function auditFile(file, kind) {
  const stream = fs.createReadStream(file), reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const state = {}, table = new Map(); let records = 0, cwd = path.dirname(file), id = path.basename(file), rollback = false;
  const add = (label, display) => {
    const key = `${label} -> ${display.route}`, row = table.get(key) || { source: label, display: display.route, count: 0, userService: 0, example: String(display.example || '').replace(/\s+/g, ' ').slice(0, 100) };
    row.count++; row.userService += display.leak || 0; table.set(key, row);
  };
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { throw Error(`${kind}: malformed JSONL; refusing a misleading audit`); }
      records++;
      if (row.cwd) cwd = row.cwd;
      if (kind === 'claude' && row.sessionId && !row.isSidechain) id = row.sessionId;
      if (row.type === 'session_meta') { id = row.payload.id; cwd = row.payload.cwd; }
      const source = category(kind, row, state);
      if (row.type === 'event_msg' && row.payload?.type === 'thread_rolled_back') rollback = true;
      if (rollback) continue;
      const entries = extract(kind, [row], id, state);
      if (!entries.length) add(source, { route: 'skipped', example: row.type === 'assistant' || /:call\//.test(source) ? 'await completed result / non-text' : 'service/metadata/duplicate UI/non-text' });
      for (const entry of entries) {
        const label = entry.tool ? `${kind}:tool/${entry.tool.name}` : entry.shell ? `${kind}:user shell` : source;
        add(label, classify(kind, entry, cwd));
      }
    }
  } finally { reader.close(); stream.destroy(); }
  if (rollback) return { records, cwd, rows: [{ source: `${kind}:rollback`, display: 'skipped', count: records, userService: 0, example: 'fail-closed: entire rollback transcript excluded' }] };
  return { records, cwd, rows: [...table.values()] };
}
async function meta(file) {
  const stream = fs.createReadStream(file), rl = readline.createInterface({ input: stream });
  try { for await (const line of rl) { const row = JSON.parse(line); return row.type === 'session_meta' ? row.payload : null; } }
  catch { return null; } finally { rl.close(); stream.destroy(); }
}
function* files(root) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(file); else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
  }
}
async function audit({ claude, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), count = 3 } = {}) {
  if (!claude || !Number.isInteger(count) || count < 1) throw Error('Usage: audit-mirror.js --claude <transcript.jsonl> [--codex-home DIR] [--count 3] [--json]');
  const result = await auditFile(claude, 'claude'), rows = [...result.rows], inputs = [{ kind: 'claude', file: path.resolve(claude) }], norms = s => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s);
  let selected = 0, records = result.records;
  for (const file of files(path.join(codexHome, 'sessions'))) {
    const m = await meta(file);
    if (!m || !['cli', 'vscode'].includes(m.source) || /broker|session-sync/i.test(m.originator || '') || m.parent_thread_id || !m.cwd || ![result.cwd, process.cwd()].some(dir => norms(dir) === norms(m.cwd))) continue;
    const next = await auditFile(file, 'codex'); rows.push(...next.rows); records += next.records; inputs.push({ kind: 'codex', file });
    if (++selected >= count) break;
  }
  const merged = new Map();
  for (const row of rows) { const key = `${row.source} -> ${row.display}`; const old = merged.get(key); if (old) { old.count += row.count; old.userService += row.userService; } else merged.set(key, { ...row }); }
  const table = [...merged.values()].sort((a, b) => a.source.localeCompare(b.source) || a.display.localeCompare(b.display));
  return { files: 1 + selected, codexFiles: selected, inputs, records, raw: table.filter(r => r.display === 'RAW').reduce((n, r) => n + r.count, 0), userService: table.reduce((n, r) => n + r.userService, 0), rows: table };
}
async function main(args = process.argv.slice(2)) {
  const options = {}; let json = false;
  for (let n = 0; n < args.length; n++) {
    if (args[n] === '--json') json = true;
    else if (['--claude', '--codex-home', '--count'].includes(args[n])) { const key = args[n]; const value = args[++n]; if (!value) throw Error(`Missing ${key}`); options[key === '--codex-home' ? 'codexHome' : key.slice(2)] = key === '--count' ? Number(value) : value; }
    else throw Error(`Unknown option ${args[n]}`);
  }
  const report = await audit(options);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('| Source category | Mirror display | Count | Example |\n| --- | --- | ---: | --- |');
    for (const row of report.rows) console.log(`| ${row.source} | ${row.display} | ${row.count} | ${row.example.replaceAll('|', '/')} |`);
    console.log(`Files=${report.files} (interactive non-broker Codex=${report.codexFiles}), records=${report.records}, RAW=${report.raw}, service-user=${report.userService}`);
  }
  if (report.raw || report.userService || report.codexFiles < (options.count || 3)) process.exitCode = 1;
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { audit, auditFile, classify };
