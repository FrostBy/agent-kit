'use strict';
const { byId, optsFor } = require('./widgets');
const { makeTheme } = require('./theme');
const gitSrc = require('./sources/git');
const usageSrc = require('./sources/usage');
const transcriptSrc = require('./sources/transcript');
const todaySrc = require('./sources/today');
const cache = require('./cache');

const itemId = (it) => (typeof it === 'string' ? it : it?.id);

function neededSources(config) {
  return new Set(config.lines.flat().flatMap((it) => byId[itemId(it)]?.needs || []));
}

// Sources are loaded only for widgets present in the layout, so an unused git scan or API call costs nothing.
async function loadData(input, config, now, sources = {}) {
  const needs = neededSources(config);
  // Claude's `cd` moves current_dir into one repo of an umbrella, which would hide the others.
  const cwd = input.workspace?.project_dir || input.workspace?.current_dir || input.cwd || process.cwd();
  const s = {
    git: (dir, o) => gitSrc.load(dir, o),
    usage: () => usageSrc.load(now, config.usageTtl),
    plan: () => usageSrc.plan(),
    transcript: () => transcriptSrc.load(input.transcript_path),
    today: () => todaySrc.load(now, config.todayTtl),
    codex: (accepts) => require('./sources/codex').load(cwd, now, undefined, accepts, input.scratchpad_dir),
    kimi: (accepts) => require('./sources/kimi').load(cwd, now, undefined, accepts, input.scratchpad_dir),
    ...sources,
  };
  const external = (id) => {
    const w = byId[id];
    const options = config.lines.flat().filter((it) => itemId(it) === id)
      .map((it) => ({ ...optsFor(w, config), ...(typeof it === 'object' ? it : {}) }));
    const accepts = (updatedAt) => options.some((o) => w.accepts({ in: input, now }, o, updatedAt));
    return needs.has(id) && accepts(now) ? s[id](accepts) : null;
  };
  const data = {
    codex: external('codex'),
    kimi: external('kimi'),
    in: input,
    now,
    git: needs.has('git') ? await s.git(cwd, optsFor(byId.git, config)) : null,
    usage: needs.has('usage') ? s.usage() : null,
    plan: needs.has('plan') ? s.plan() : null,
    transcript: needs.has('transcript') ? s.transcript() : null,
    today: needs.has('today') ? s.today() : null,
  };
  data.paying = config.money === 'always' || paying(input, data.plan, data.usage);
  return data;
}

// A subscriber pays real money only after extra usage kicks in. Credits spent before this session
// are not its doing, so the baseline is the credit count at the session's first render.
function paying(input, plan, usage) {
  if (plan?.api) return true;
  const e = usage?.extra_usage;
  if (!e?.is_enabled || e.used_credits == null || !input.session_id) return false;
  const base = cache.read('extra-base') || {};
  if (base[input.session_id] == null) { base[input.session_id] = e.used_credits; cache.writeRaw('extra-base', base); }
  return e.used_credits > base[input.session_id];
}

function renderLines(config, data, theme = makeTheme(config)) {
  const sep = theme.paint('separator', config.separator);
  return config.lines.flatMap((items) => {
    const segments = [[]], rows = [];
    for (const it of items) {
      if (it === '|') { segments.push([]); continue; }
      const w = byId[itemId(it)];
      if (!w || (w.paid && !data.paying)) continue;
      const opts = typeof it === 'object' ? { ...optsFor(w, config), ...it } : optsFor(w, config);
      let out = null;
      // One broken widget must not blank the whole status line.
      try { out = w.render(data, opts, theme); } catch { out = null; }
      if (out?.rows) { rows.push(...out.rows); out = out.text; }
      if (out) segments[segments.length - 1].push(out);
    }
    return [segments.filter((sg) => sg.length).map((sg) => sg.join(' ')).join(sep), ...rows];
  }).filter(Boolean);
}

async function render(input, config, now = Date.now(), sources) {
  return renderLines(config, await loadData(input, config, now, sources));
}

module.exports = { render, renderLines, loadData, neededSources };
