'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
const HARNESS = process.argv.some((arg) => arg === '--codex' || arg === '--codex-native') ? 'codex' : 'claude';
const CONFIG_PATH = process.env.AGENT_STATUSLINE_CONFIG || (HARNESS === 'codex'
  ? path.join(CODEX_DIR, 'statusline.json')
  : process.env.CLAUDE_STATUSLINE_CONFIG || path.join(CLAUDE_DIR, 'statusline.json'));
const CACHE_DIR = path.join(os.tmpdir(), 'agent-statusline');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Write-then-rename: a concurrent render must never read a half-written file.
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toEpoch = (v) => (typeof v === 'string' ? Date.parse(v) / 1000 : v);

const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`);

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m` : `${s}s`;
}

const until = (epochSec, now) => duration((epochSec - now / 1000) * 1000);

const money = (usd) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`);

function bar(pct, width, full = '▰', empty = '▱') {
  const n = Math.round((clamp(pct, 0, 100) / 100) * width);
  return full.repeat(n) + empty.repeat(width - n);
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(values) {
  if (!values?.length) return '';
  const lo = Math.min(...values), hi = Math.max(...values);
  return values.map((v) => SPARK[hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * (SPARK.length - 1))]).join('');
}

function isMergeable(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  if (!isMergeable(base) || !isMergeable(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

const forwardSlashes = (p) => p.split(path.sep).join('/');

module.exports = {
  HOME, CLAUDE_DIR, CODEX_DIR, HARNESS, CONFIG_PATH, CACHE_DIR,
  readJson, writeJson, clamp, toEpoch, tokens, duration, until, money, bar, sparkline, deepMerge, forwardSlashes,
};
