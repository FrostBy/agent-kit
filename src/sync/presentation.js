'use strict';
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { codexItem } = require('./tool-mapping');
const { toolSummary } = require('./tool-summary');
function visible(entries, cwd = process.cwd()) {
  return entries.map(entry => {
    if (entry.shell) return { role: entry.role, text: entry.text, key: entry.key, item: codexItem({ name: 'Bash', input: { command: entry.shell.command },
      output: entry.shell.stdout + (entry.shell.stderr ? '\nStderr:\n' + entry.shell.stderr : ''), exitCode: entry.shell.exitCode, durationMs: entry.shell.durationMs, userShell: true }, entry.key, cwd) };
    const match = entry.text.match(/^\[(?:claude|codex) tool ([^\]]+)\]/);
    const text = entry.tool || match
      ? toolSummary(entry.tool || { name: match[1], output: entry.text.split('Result:\n')[1] || '' })
      : entry.text;
    return { role: entry.tool || match ? 'assistant' : entry.role, text, key: entry.key, ...(entry.tool ? { item: codexItem(entry.tool, entry.key, cwd) } : {}) };
  });
}
async function writePresentation(file, entries, threadId) {
  const original = await fs.readFile(file, 'utf8');
  if (original && !original.endsWith('\n')) throw Error('Partial rollout; refusing presentation append');
  const rows = original.split('\n').filter(Boolean).map(JSON.parse);
  const seen = new Set(rows.map(row => row.payload?.session_sync_key).filter(Boolean));
  const lastOrdinal = rows.findLast(row => Number.isSafeInteger(row.ordinal))?.ordinal;
  const timestamp = new Date().toISOString();
  const pending = entries.filter(entry => !seen.has(entry.key));
  if (!pending.length) return;
  const turnId = `session-sync-ui-${threadId}`;
  const event = payload => ({ timestamp, type: 'event_msg', payload });
  const events = [event({ type: 'task_started', turn_id: turnId, model_context_window: null })];
  for (const entry of pending) {
    if (entry.item) {
      events.push(event({ type: 'item_completed', thread_id: threadId, turn_id: turnId, item: entry.item,
        session_sync_key: entry.key, completed_at_ms: Date.now() }));
      continue;
    }
    events.push(event({ ...(entry.role === 'user'
      ? { type: 'user_message', message: entry.text, images: [], local_images: [], text_elements: [] }
      : { type: 'agent_message', message: entry.text, phase: 'final_answer' }),
      session_sync_key: entry.key }));
    // Paginated replay ignores legacy messages; legacy replay ignores these idless-copy items.
    events.push(event({ type: 'item_completed', thread_id: threadId, turn_id: turnId,
      item: entry.role === 'user'
        ? { type: 'UserMessage', id: `sync-ui-${entry.key}`, content: [{ type: 'text', text: entry.text, text_elements: [] }] }
        : { type: 'AgentMessage', id: `sync-ui-${entry.key}`, content: [{ type: 'Text', text: entry.text }], phase: 'final_answer' },
      completed_at_ms: Date.now() }));
  }
  events.push(event({ type: 'task_complete', turn_id: turnId, last_agent_message: null }));
  // Paginated recorders require a contiguous ordinal on every appended record.
  if (lastOrdinal !== undefined) events.forEach((row, index) => { row.ordinal = lastOrdinal + index + 1; });
  const backup = `${file}.bak-session-sync-ui`;
  try { await fs.copyFile(file, backup, 1); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, original + events.map(JSON.stringify).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    if (await fs.readFile(file, 'utf8') !== original) throw Error('Rollout changed while archived; refusing replacement');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
module.exports = { visible, writePresentation };
