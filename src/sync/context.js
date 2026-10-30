'use strict';
const { createHash } = require('node:crypto');
const MARK = '[session-sync:v2:';
const OMITTED = '[Earlier context omitted to fit the sync budget.]';
const clipped = (text, limit) => {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, limit - 40))).replace(/\uFFFD$/, '') + '\n[Text truncated to fit sync budget.]';
};
const cost = ref => ref.bytes + 120;
function update(endpoint, ref, event, budget) {
  endpoint.active ||= { tail: [], tailBytes: 0, summary: null, compactKey: null, omitted: false };
  const active = endpoint.active;
  if (event.compact) {
    active.summary = ref; active.compactKey = ref.key; active.tail = []; active.tailBytes = 0; active.omitted = false;
  } else { active.tail.push(ref); active.tailBytes += cost(ref); }
  const available = budget - 1024 - (active.summary ? Math.min(cost(active.summary), Math.floor((budget - 1024) / 2)) : 0);
  while (active.tail.length > 1 && active.tailBytes > available) {
    active.tailBytes -= cost(active.tail.shift()); active.omitted = true;
  }
  if (active.tailBytes > available) active.omitted = true;
}
function snapshot(active, budget) {
  const value = { ...active, tail: [...active.tail], budget };
  value.key = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return value;
}
async function materialize(journal, active, budget) {
  const fs = require('node:fs/promises');
  const events = [], handle = await fs.open(journal, 'r');
  const usable = budget - 1024;
  let left = usable;
  async function read(ref, limit) {
    const bytes = Buffer.alloc(ref.length);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, ref.offset);
    if (bytesRead !== bytes.length) throw Error('Incomplete event archive');
    const event = JSON.parse(bytes.toString('utf8'));
    if (event.key !== ref.key) throw Error('Event archive mismatch');
    const text = clipped(event.text, Math.max(64, limit - 120));
    left -= Buffer.byteLength(text) + 120;
    const tool = event.tool && text !== event.text ? { ...event.tool, input: { truncated: true }, output: clipped(event.tool.output || '', Math.max(64, limit - 200)) } : event.tool;
    const shell = event.shell && text !== event.text ? { ...event.shell, command: clipped(event.shell.command, Math.max(64, Math.floor(limit / 4))),
      stdout: clipped(event.shell.stdout, Math.max(64, Math.floor(limit / 2))), stderr: clipped(event.shell.stderr, Math.max(64, Math.floor(limit / 4))) } : event.shell;
    return { ...event, text, ...(tool ? { tool } : {}), ...(shell ? { shell } : {}) };
  }
  try {
    if (active.summary) events.push(await read(active.summary, Math.min(cost(active.summary), Math.floor(usable / 2))));
    const tail = [...active.tail];
    let total = tail.reduce((sum, ref) => sum + cost(ref), 0);
    let omitted = active.omitted || total > left - 200;
    while (tail.length > 1 && total > left - 200) total -= cost(tail.shift());
    if (omitted) {
      events.push({ key: 'seed', role: 'user', text: OMITTED }); left -= Buffer.byteLength(OMITTED) + 120;
    }
    for (const ref of tail) {
      if (left < 200) break;
      events.push(await read(ref, Math.min(cost(ref), left)));
    }
  } finally { await handle.close(); }
  return events;
}
function render(events) { return events.map(e => `${MARK}${e.key}] (${e.origin || 'sync'}/${e.role})\n${e.text}`).join('\n\n'); }
module.exports = { update, snapshot, materialize, render };
