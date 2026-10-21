'use strict';

// USD per million tokens, first-party API list prices (Oct 2026). Override via config `pricing`.
// `read` is listed explicitly because cache-read discounts differ per model (0.025x on Fable 5.1, 0.05x on Opus 5.5).
const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, read: 0.25 },
  'claude-mythos-5-1': { in: 10, out: 50, read: 0.25 },
  'claude-fable-5': { in: 10, out: 50, read: 1 },
  'claude-mythos-5': { in: 10, out: 50, read: 1 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2 },
  'claude-opus-5': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-7': { in: 5, out: 25, read: 0.5 },
  'claude-opus-4-6': { in: 5, out: 25, read: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2 },
  'claude-sonnet-5': { in: 2, out: 10, read: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, read: 0.3 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01, longIn: 0.5, longOut: 2.5, longRead: 0.05, longAbove: 100_000 },
  'claude-haiku-4-5': { in: 1, out: 5, read: 0.1 },
};

const WRITE_5M = 1.25, WRITE_1H = 2, FAST = 2;

// Transcripts carry dated ids (claude-haiku-4-5-20251001); strip the date to find the base model.
function priceFor(model, table = PRICES) {
  if (!model) return null;
  return table[model] || table[model.replace(/-\d{8}$/, '')] || null;
}

function costOf(model, u, table) {
  const p = priceFor(model, table);
  if (!p || !u) return null;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  const read = u.cache_read_input_tokens || 0;
  const input = u.input_tokens || 0;
  const long = p.longAbove && input + read + w5m + w1h > p.longAbove;
  const pin = long ? p.longIn : p.in, pout = long ? p.longOut : p.out, pread = long ? p.longRead : p.read;
  const usd = (input * pin + w5m * pin * WRITE_5M + w1h * pin * WRITE_1H + read * pread + (u.output_tokens || 0) * pout) / 1e6;
  return u.speed === 'fast' ? usd * FAST : usd;
}

module.exports = { PRICES, priceFor, costOf };
