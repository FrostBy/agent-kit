'use strict';
const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('../util');
const cache = require('../cache');
const { costOf } = require('../pricing');

const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

function jsonlIn(dir, dayStart, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    try { const st = fs.statSync(fp); if (st.mtimeMs >= dayStart) out.push({ fp, size: st.size }); } catch { /* deleted mid-scan */ }
  }
}

// Subagents write their own transcripts under <session>/subagents/; skipping them undercounts spend.
function listTodaysTranscripts(dayStart) {
  const root = path.join(CLAUDE_DIR, 'projects');
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, p.name);
    jsonlIn(dir, dayStart, out);
    let sessions = [];
    try { sessions = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) if (s.isDirectory()) jsonlIn(path.join(dir, s.name, 'subagents'), dayStart, out);
  }
  return out;
}

// Transcripts reach gigabytes: the timestamp is read by substring first, and only today's assistant rows are parsed.
// lastIndexOf, because the top-level "timestamp" key sits at the end of a row, after nested tool results.
// Each content block of one response is its own row repeating the same usage, so rows are deduplicated by message+request.
function scan(text, st, dayStart, pricing) {
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"usage"') || !line.includes('"assistant"')) continue;
    const i = line.lastIndexOf('"timestamp":"');
    if (i < 0) continue;
    const ts = Date.parse(line.slice(i + 13, line.indexOf('"', i + 13)));
    if (!(ts >= dayStart)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || !m?.usage) continue;
    const key = `${m.id}:${o.requestId}`;
    if (key === st.lastKey) continue;
    st.lastKey = key;
    const usd = costOf(m.model, m.usage, pricing);
    if (usd == null) { if (m.model && m.model !== '<synthetic>') st.unpriced = m.model; continue; }
    st.cost += usd;
  }
  return st;
}

const CHUNK = 16 << 20;

// Chunked: a single readSync is capped at ~2 GB, and partial trailing lines carry over to the next chunk
// so the saved offset always lands on a line boundary for the next incremental pass.
function scanFile(fp, st, dayStart, pricing) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = st.offset, carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const end = data.lastIndexOf(0x0a) + 1;
      if (end) scan(data.subarray(0, end).toString('utf8'), st, dayStart, pricing);
      carry = Buffer.from(data.subarray(end));
      st.offset = pos - carry.length;
    }
  } finally { fs.closeSync(fd); }
}

async function refresh(now = Date.now(), pricing) {
  const dayStart = startOfDay(now);
  const prev = cache.read('today')?.data;
  const files = prev?.dayStart === dayStart ? prev.files : {};
  let total = 0, sessions = 0, unpriced = null;
  for (const { fp, size } of listTodaysTranscripts(dayStart)) {
    let st = files[fp];
    if (!st || size < st.offset) st = { offset: 0, cost: 0, lastKey: null, unpriced: null };
    try { scanFile(fp, st, dayStart, pricing); } catch { continue; }
    files[fp] = st;
    if (st.cost > 0) { total += st.cost; if (!fp.includes(`${path.sep}subagents${path.sep}`)) sessions++; }
    unpriced = unpriced || st.unpriced;
  }
  cache.write('today', { dayStart, total, sessions, unpriced, files });
}

function load(now, ttlSec = 300) {
  const d = cache.getStale('today', ttlSec * 1000, now);
  return d && d.dayStart === startOfDay(now) ? { total: d.total, sessions: d.sessions, unpriced: d.unpriced } : null;
}

module.exports = { refresh, load, scan, startOfDay, listTodaysTranscripts };
