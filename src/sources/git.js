'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cache = require('../cache');

// --no-optional-locks: our background `git status` must not grab index.lock while the user commits.
const git = (dir, args, timeout = 3000) => new Promise((res) =>
  execFile('git', ['--no-optional-locks', '-C', dir, ...args], { timeout, windowsHide: true, maxBuffer: 16 << 20 },
    (err, out) => res(err ? null : out)));

function parseStatus(text) {
  const r = { branch: '?', ahead: 0, behind: 0, changed: 0, staged: 0, untracked: 0, conflicts: 0 };
  for (const l of text.split('\n')) {
    if (l.startsWith('# branch.head ')) r.branch = l.slice(14);
    else if (l.startsWith('# branch.ab ')) { const [a, b] = l.slice(12).split(' '); r.ahead = +a; r.behind = -b; }
    else if (l.startsWith('? ')) r.untracked++;
    else if (l.startsWith('u ')) { r.conflicts++; r.changed++; }
    else if (/^[12] /.test(l)) { r.changed++; if (l[2] !== '.') r.staged++; }
  }
  return r;
}

function parseNumstat(text) {
  let add = 0, del = 0;
  for (const l of (text || '').split('\n')) {
    const [a, d] = l.split('\t');
    if (a && a !== '-') { add += +a || 0; del += +d || 0; }
  }
  return { add, del };
}

async function repoState(dir, opts = {}) {
  const st = await git(dir, ['status', '--porcelain=v2', '--branch']);
  if (st == null) return null;
  const r = { dir, ...parseStatus(st), add: 0, del: 0, stash: 0 };
  const jobs = [];
  // `diff HEAD` fails in a repo without commits; plain `diff` still counts unstaged lines there.
  if (r.changed) jobs.push((async () => Object.assign(r, parseNumstat((await git(dir, ['diff', 'HEAD', '--numstat'])) ?? (await git(dir, ['diff', '--numstat'])))))());
  if (opts.stash) jobs.push(git(dir, ['stash', 'list']).then((s) => { r.stash = s ? s.split('\n').filter(Boolean).length : 0; }));
  await Promise.all(jobs);
  return r;
}

function findRepoRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

function findChildRepos(root, depth) {
  const out = [];
  (function walk(d, lvl) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (fs.existsSync(path.join(p, '.git'))) out.push(p);
      else if (lvl < depth) walk(p, lvl + 1);
    }
  })(root, 1);
  return out.sort();
}

async function collect(cwd, opts) {
  const root = findRepoRoot(cwd);
  if (root) return { mode: 'repo', root, repo: await repoState(root, opts) };
  const children = findChildRepos(cwd, opts.depth ?? 2);
  if (!children.length) return null;
  const repos = (await Promise.all(children.map((c) => repoState(c, opts)))).filter(Boolean);
  return { mode: 'umbrella', root: cwd, repos };
}

const cacheKey = (cwd) => `git-${require('crypto').createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16)}`;

async function refresh(cwd, opts) {
  const g = await collect(cwd, opts);
  if (g) cache.write(cacheKey(cwd), g);
  return g;
}

// A slow repo (or twelve of them) must not stall the render: past the budget we show the last known state
// and finish the scan in a detached process — an in-process promise would keep Node (and Claude Code) waiting.
async function load(cwd, opts = {}) {
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(undefined), opts.budgetMs ?? 400); });
  const g = await Promise.race([refresh(cwd, opts), timeout]);
  clearTimeout(timer);
  if (g !== undefined) return g;
  const c = cache.read(cacheKey(cwd));
  if (!(c?.attemptAt && Date.now() - c.attemptAt < 30_000)) {
    cache.writeRaw(cacheKey(cwd), { ...c, attemptAt: Date.now() });
    cache.spawnWorker('git', [JSON.stringify({ cwd, opts })]);
  }
  return c?.data ?? null;
}

module.exports = { load, refresh, collect, repoState, parseStatus, parseNumstat, findRepoRoot, findChildRepos };
