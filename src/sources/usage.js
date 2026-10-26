'use strict';
const path = require('path');
const { CLAUDE_DIR, readJson } = require('../util');
const cache = require('../cache');

const CREDS = path.join(CLAUDE_DIR, '.credentials.json');
const oauth = () => readJson(CREDS)?.claudeAiOauth || null;

// Undocumented endpoint behind `/usage`: rate-limit it hard and never block the render on it.
async function refresh() {
  const tok = oauth()?.accessToken;
  if (!tok) return;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) cache.write('usage', await res.json());
}

const load = (now, ttlSec = 120) => (oauth() ? cache.getStale('usage', ttlSec * 1000, now) : null);

function plan() {
  const o = oauth();
  if (!o) return { label: 'API', api: true };
  const t = o.subscriptionType || '';
  const mult = /(\d+x)/.exec(o.rateLimitTier || '');
  return { label: `${t.charAt(0).toUpperCase()}${t.slice(1)}${mult ? ` ${mult[1]}` : ''}`, api: false, team: ['team', 'enterprise'].includes(t) };
}

module.exports = { refresh, load, plan };
