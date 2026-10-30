'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const MARK = '[session-sync:v2:';
// Claude: 10,000 characters. Codex: ceil(UTF-8 bytes / 4) <= 16,000 tokens.
// Byte caps are conservative for Claude too, including all labels and acknowledgement markers.
const LIMITS = { claude: 10000, codex: 64000 };
const hash = text => createHash('sha256').update(text).digest('hex');
function chunk(text, position, available) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, position + available);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(position, end).toString('utf8'), next: end, complete: end === bytes.length };
}
async function event(file, ref) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(ref.length);
    if ((await handle.read(bytes, 0, bytes.length, ref.offset)).bytesRead !== bytes.length) throw Error('Incomplete event archive');
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.key !== ref.key) throw Error('Event archive mismatch');
    return value;
  } finally { await handle.close(); }
}
function acknowledge(endpoint, marks) {
  for (const item of endpoint.inflight || []) {
    if (!marks.has(item.key)) continue;
    if (item.snapshot) {
      if (endpoint.snapshot?.key !== item.snapshot) continue;
      endpoint.snapshot.position = item.next;
      if (item.complete) { endpoint.compactAcknowledged = endpoint.snapshot.compactKey; endpoint.snapshot = null; }
    } else {
      const ref = endpoint.pending.find(ref => ref.key === item.ref);
      if (!ref) continue;
      if (item.complete) endpoint.pending = endpoint.pending.filter(ref => ref.key !== item.ref);
      else ref.position = item.next;
    }
  }
  endpoint.inflight = (endpoint.inflight || []).filter(item => !marks.has(item.key));
}
async function output(kind, endpoint, journal, budget, context) {
  const limit = Math.min(LIMITS[kind], budget), blocks = [], inflight = [];
  let used = 0;
  async function block(text, identity, position, descriptor) {
    const key = hash(`${identity}:${position}:${limit}`), prefix = `${MARK}${key}]\n`;
    const available = limit - used - Buffer.byteLength(prefix) - (blocks.length ? 2 : 0);
    if (available < 128) return false;
    const part = chunk(text, position, available);
    blocks.push(prefix + part.text); used += Buffer.byteLength(prefix + part.text) + (blocks.length > 1 ? 2 : 0);
    inflight.push({ key, ...descriptor, next: part.next, complete: part.complete });
    return part.complete;
  }
  if (endpoint.snapshot) {
    const snapshot = endpoint.snapshot;
    const entries = await context.materialize(journal, snapshot, snapshot.budget || budget);
    const text = 'Current active context from the paired session (replaces the pending backlog; continued across hooks).\n' + context.render(entries);
    await block(text, snapshot.key, snapshot.position || 0, { snapshot: snapshot.key });
  } else {
    for (const ref of endpoint.pending) {
      const value = await event(journal, ref);
      const text = `Historical observation (${value.origin}/${value.role}); completed tools are not live calls.\n${value.text}`;
      if (!await block(text, ref.key, ref.position || 0, { ref: ref.key })) break;
    }
  }
  endpoint.inflight = inflight;
  return blocks.length ? blocks.join('\n\n') : null;
}
module.exports = { LIMITS, acknowledge, output, event };
