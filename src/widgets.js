'use strict';
const path = require('path');
const { execSync } = require('child_process');
const { tokens, duration, until, money, bar, toEpoch, readJson, writeJson } = require('./util');
const cacheMod = require('./cache');

const bool = (d, desc) => ({ type: 'bool', default: d, desc });
const num = (d, min, max, desc) => ({ type: 'number', default: d, min, max, desc });
const str = (d, desc) => ({ type: 'string', default: d, desc });

function contextText(cw, o, t, autoCompactWindow) {
  if (cw?.used_percentage == null) return null;
  const originalSize = cw.context_window_size;
  const u = cw.current_usage;
  const used = cw.used_tokens ?? (u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : originalSize * cw.used_percentage / 100);
  const size = autoCompactWindow > 0 && originalSize > 0 ? Math.min(originalSize, autoCompactWindow) : originalSize;
  const pct = Math.round(autoCompactWindow > 0 && size > 0 ? used / size * 100 : cw.used_percentage);
  const parts = [o.label && t.paint('muted', o.label)].filter(Boolean);
  if (o.bar) parts.push(t.sev(pct, bar(pct, o.bar, t.icon('barFull'), t.icon('barEmpty'))));
  if (o.percent) parts.push(t.sev(pct, `${pct}%`));
  if (size && o.used) parts.push(t.paint('muted', `${tokens(used)}/${tokens(size)}`));
  if (size && o.left) parts.push(t.paint('muted', `${tokens(Math.max(0, size - used))} left`));
  return parts.join(' ');
}

function limitText(t, label, pct, resetsAt, windowSec, now, o) {
  if (pct == null) return null;
  pct = Math.round(pct);
  const reset = resetsAt ? toEpoch(resetsAt) : null;
  let runsOut = null;
  if (reset && o.pace) {
    const left = reset - now / 1000;
    const elapsed = 100 - (left / windowSec) * 100;
    const hitIn = ((100 - pct) / (pct / elapsed)) / 100 * windowSec;
    // The margin damps early-window noise; it shrinks with the time left so a late overrun (98% with 6% left) still warns.
    const margin = (o.paceMargin ?? 10) * (left / windowSec);
    if (elapsed > 1 && pct - elapsed > margin && hitIn < left) runsOut = duration(hitIn * 1000);
  }
  const v = (s) => (runsOut ? t.paint('crit', s) : t.sev(pct, s));
  let s = `${t.paint('muted', label)} ${o.bar ? `${v(bar(pct, o.bar, t.icon('barFull'), t.icon('barEmpty')))} ` : ''}${v(`${pct}%`)}`;
  if (reset && o.countdown) s += t.paint('muted', ` ${t.iconSp('reset')}${until(reset, now)}`);
  if (runsOut) s += t.paint('crit', ` out in ${runsOut}`);
  return s;
}

const delta = (t, add, del) => [add && t.paint('ok', `+${add}`), del && t.paint('crit', `−${del}`)].filter(Boolean).join(' ');

const cut = (s, n) => (n && s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Claude Code reports the drive letter in either case on Windows (z:\ and Z:\ in one session).
const normDir = (p) => { const x = path.resolve(p) + path.sep; return process.platform === 'win32' ? x.toLowerCase() : x; };
const isInside = (child, dir) => !!child && normDir(child).startsWith(normDir(dir));

function repoBits(t, r, o, pad = 0) {
  return [
    `${t.paint('muted', t.iconSp('branch'))}${t.paint('branch', cut(r.branch, o.branchMax).padEnd(pad))}`,
    o.aheadBehind && (r.ahead || r.behind) && t.paint('info', [r.ahead && `${r.ahead} to push`, r.behind && `${r.behind} to pull`].filter(Boolean).join(' ')),
    o.lines && delta(t, r.add, r.del),
    o.untracked && r.untracked && t.paint('warn', `${t.icon('untracked')}${r.untracked}`),
    r.conflicts && t.paint('crit', `!${r.conflicts}`),
    o.stash && r.stash && t.paint('muted', `${t.icon('stash')}${r.stash}`),
  ].filter(Boolean).join(' ');
}

const PR = { approved: ['ok', 'approved'], changes_requested: ['crit', 'changes'], pending: ['warn', 'pending'], draft: ['muted', 'draft'] };

const W = [];
const def = (w) => W.push(w);

def({ id: 'model', group: 'session', desc: { en: 'Model', ru: 'Модель' }, render: (d, o, t) => d.in.model?.display_name && t.paint('model', d.in.model.display_name) });
def({ id: 'effort', group: 'session', desc: { en: 'Effort level', ru: 'Уровень effort' }, render: (d, o, t) => d.in.effort?.level && t.paint('muted', d.in.effort.level) });
def({ id: 'thinking', group: 'session', desc: { en: 'Extended thinking enabled', ru: 'Extended thinking включён' }, render: (d, o, t) => d.in.thinking?.enabled && t.paint('muted', `${t.iconSp('thinking')}think`) });
def({ id: 'fast', group: 'session', desc: 'Fast mode', render: (d, o, t) => d.in.fast_mode && t.paint('warn', `${t.iconSp('fast')}fast`) });
def({ id: 'mode', group: 'session', desc: { en: 'Codex mode (Shift+Tab to cycle)', ru: 'Режим Codex (Shift+Tab для переключения)' }, render: (d, o, t) => {
  const text = { default: 'default mode', auto: '⏵⏵ auto mode on', plan: '⏸\uFE0E plan mode on', 'read-only': 'read-only mode' }[d.in.mode];
  return text && t.paint({ auto: 'warn', plan: 'info' }[d.in.mode] || 'muted', text)
    + (d.in.mode === 'read-only' ? '' : t.paint('muted', ' (shift+tab to cycle)'));
} });
def({ id: 'plan', group: 'session', desc: { en: 'Plan: Pro / Max 5x / Max 20x / API; Team/Enterprise highlighted', ru: 'Тариф: Pro / Max 5x / Max 20x / API; Team/Enterprise подсвечивается' }, needs: ['plan'], render: (d, o, t) => d.plan && t.paint(d.plan.team ? 'warn' : 'muted', d.plan.label) });
def({ id: 'session-name', group: 'session', desc: { en: 'Session name', ru: 'Имя сессии' }, opts: { max: num(24, 8, 80, { en: 'Max length', ru: 'Макс. длина' }) },
  render: (d, o, t) => d.in.session_name && t.paint('muted', d.in.session_name.length > o.max ? `${d.in.session_name.slice(0, o.max - 1)}…` : d.in.session_name) });
def({ id: 'duration', group: 'session', desc: { en: 'Session duration', ru: 'Длительность сессии' }, render: (d, o, t) => d.in.cost?.total_duration_ms > 0 && t.paint('muted', `${t.iconSp('clock')}${duration(d.in.cost.total_duration_ms)}`) });
def({ id: 'api-time', group: 'session', desc: { en: 'Share of time waiting for the API', ru: 'Доля времени на ожидание API' }, render: (d, o, t) => {
  const c = d.in.cost || {};
  return c.total_duration_ms > 0 && c.total_api_duration_ms != null && t.paint('muted', `api ${Math.round((c.total_api_duration_ms / c.total_duration_ms) * 100)}%`);
} });
def({ id: 'version', group: 'session', desc: { en: 'Harness version', ru: 'Версия харнеса' }, render: (d, o, t) => d.in.version && t.paint('muted', `v${d.in.version}`) });
def({ id: 'style', group: 'session', desc: { en: 'Output style, if not default', ru: 'Output style, если не default' }, render: (d, o, t) => d.in.output_style?.name && d.in.output_style.name !== 'default' && t.paint('muted', d.in.output_style.name) });
def({ id: 'vim', group: 'session', desc: { en: 'Vim mode', ru: 'Режим vim' }, render: (d, o, t) => d.in.vim?.mode && t.paint(d.in.vim.mode === 'INSERT' ? 'ok' : 'info', d.in.vim.mode) });
def({ id: 'agent', group: 'session', desc: { en: 'Agent name (--agent)', ru: 'Имя агента (--agent)' }, render: (d, o, t) => d.in.agent?.name && t.paint('info', `${t.iconSp('agent')}${d.in.agent.name}`) });
def({ id: 'permission-mode', group: 'session', desc: { en: 'Permission mode, if not default (from transcript)', ru: 'Режим разрешений, если не default (из транскрипта)' }, needs: ['transcript'], render: (d, o, t) => {
  const m = d.transcript?.permissionMode;
  if (!m || m === 'default') return null;
  return `${t.paint('muted', 'mode')} ${/bypass/i.test(m) ? t.paint('crit', `${t.iconSp('warn')}${m}`) : t.paint('warn', m)}`;
} });

def({ id: 'context', group: 'context', desc: { en: 'Context: bar, %, used/window', ru: 'Контекст: полоска, %, занято/окно' },
  needs: ['settings'],
  opts: { label: str('ctx', { en: 'Label', ru: 'Подпись' }), bar: num(5, 0, 40, { en: 'Bar width, 0 — none', ru: 'Ширина полоски, 0 — без неё' }), percent: bool(true, { en: 'Percent', ru: 'Процент' }), used: bool(true, { en: 'Tokens used / window size', ru: 'Занято токенов / размер окна' }), left: bool(false, { en: 'Tokens left', ru: 'Сколько токенов осталось' }) },
  render: (d, o, t) => {
    return contextText(d.in.context_window, o, t, d.autoCompactWindow);
  } });
def({ id: 'context-breakdown', group: 'context', desc: { en: 'Context by type: fresh input / cache read / cache write', ru: 'Контекст по типам: свежий ввод / чтение кэша / запись кэша' }, render: (d, o, t) => {
  const u = d.in.context_window?.current_usage;
  return u && t.paint('muted', `in ${tokens(u.input_tokens || 0)} · rd ${tokens(u.cache_read_input_tokens || 0)} · wr ${tokens(u.cache_creation_input_tokens || 0)}`);
} });

const PACE = { en: "Forecast 'out in …' when burning faster than the window", ru: 'Прогноз «out in …», если расход быстрее окна' };
const limitOpts = (label) => ({ label: str(label, { en: 'Label', ru: 'Подпись' }), bar: num(5, 0, 20, { en: 'Bar width, 0 — none', ru: 'Ширина полоски, 0 — без неё' }), countdown: bool(true, { en: 'Countdown to reset', ru: 'Отсчёт до сброса' }), pace: bool(true, PACE), paceMargin: num(10, 0, 50, { en: 'Pace threshold, pp', ru: 'Порог темпа, п.п.' }) });

def({ id: 'limits', group: 'limits', desc: { en: 'Codex quota windows, with their actual durations', ru: 'Окна лимитов Codex с фактической длительностью' }, opts: limitOpts(''),
  render: (d, o, t) => {
    return (d.in.quota_windows || []).map((w) => limitText(t, o.label || w.label, w.used_percentage, w.resets_at, w.window_seconds, d.now, o)).filter(Boolean).join('   ') || null;
  } });

def({ id: 'limit-5h', group: 'limits', desc: { en: '5-hour limit', ru: 'Лимит за 5 часов' }, opts: limitOpts('5h'),
  render: (d, o, t) => limitText(t, o.label, d.in.rate_limits?.five_hour?.used_percentage, d.in.rate_limits?.five_hour?.resets_at, 5 * 3600, d.now, o) });
def({ id: 'limit-7d', group: 'limits', desc: { en: 'Weekly limit', ru: 'Лимит за неделю' }, opts: limitOpts('7d'),
  render: (d, o, t) => limitText(t, o.label, d.in.rate_limits?.seven_day?.used_percentage, d.in.rate_limits?.seven_day?.resets_at, 7 * 86400, d.now, o) });
def({ id: 'limit-model', group: 'limits', desc: { en: 'Per-model weekly limits (Fable etc.), usage API', ru: 'Недельные лимиты по моделям (Fable и т.п.), usage API' }, needs: ['usage'],
  opts: { countdown: bool(false, { en: 'Countdown to reset', ru: 'Отсчёт до сброса' }), pace: bool(true, PACE), paceMargin: num(10, 0, 50, { en: 'Pace threshold, pp', ru: 'Порог темпа, п.п.' }) },
  render: (d, o, t) => {
    const ls = (d.usage?.limits || []).filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name);
    return ls.map((l) => limitText(t, l.scope.model.display_name, l.percent, l.resets_at, 7 * 86400, d.now, o)).filter(Boolean).join(t.paint('muted', ' · ')) || null;
  } });
def({ id: 'limit-spend', group: 'limits', desc: { en: 'Gateway spend limit', ru: 'Лимит трат гейтвея' }, render: (d, o, t) => {
  const s = d.in.rate_limits?.spend_limit;
  if (s?.used_percentage == null) return null;
  const txt = s.used_usd != null && s.limit_usd != null ? `${money(s.used_usd)}/${money(s.limit_usd)}` : `${Math.round(s.used_percentage)}%`;
  return `${t.paint('muted', 'spend')} ${t.sev(s.used_percentage, txt)}`;
} });
def({ id: 'extra-usage', group: 'limits', desc: { en: 'Purchased credits (extra usage), usage API', ru: 'Докупленные кредиты (extra usage), usage API' }, needs: ['usage'], render: (d, o, t) => {
  const e = d.usage?.extra_usage;
  if (!e?.is_enabled) return null;
  const pct = e.utilization ?? 0;
  return `${t.paint('muted', 'extra')} ${t.sev(pct, e.used_credits != null && e.monthly_limit ? `${e.used_credits}/${e.monthly_limit}` : `${Math.round(pct)}%`)}`;
} });
def({ id: 'week-breakdown', group: 'limits', desc: { en: 'Where the week went: Claude Code / chats / Cowork, usage API', ru: 'На что ушла неделя: Claude Code / чаты / Cowork, usage API' }, needs: ['usage'], opts: { min: num(1, 0, 50, { en: 'Hide shares below, %', ru: 'Скрывать доли меньше, %' }) },
  render: (d, o, t) => {
    const rows = (d.usage?.seven_day_breakdown?.rows || []).filter((r) => r.percent >= o.min);
    return rows.length ? t.paint('muted', rows.map((r) => `${r.display_name} ${r.percent}%`).join(' · ')) : null;
  } });

const PAID = { paid: true, needs: ['plan', 'usage'] };
def({ id: 'cost', group: 'money', desc: { en: 'Session cost', ru: 'Стоимость сессии' }, ...PAID, render: (d, o, t) => d.in.cost?.total_cost_usd > 0 && `${money(d.in.cost.total_cost_usd)} ${t.paint('muted', 'session')}` });
def({ id: 'burn-rate', group: 'money', desc: { en: '$ per hour, current session', ru: '$ в час по текущей сессии' }, ...PAID, render: (d, o, t) => {
  const c = d.in.cost || {};
  return c.total_cost_usd > 0 && c.total_duration_ms > 60_000 && t.paint('muted', `${money(c.total_cost_usd / (c.total_duration_ms / 3.6e6))}/h`);
} });
def({ id: 'cost-today', group: 'money', desc: { en: "Today's spend across all sessions (from transcripts)", ru: 'Расход за сегодня по всем сессиям (из транскриптов)' }, paid: true, needs: ['today', 'plan', 'usage'], opts: { sessions: bool(false, { en: 'Session count', ru: 'Число сессий' }) },
  render: (d, o, t) => d.today && d.today.total > 0 && `${money(d.today.total)}${d.today.unpriced ? '+' : ''} ${t.paint('muted', `today${o.sessions ? ` (${d.today.sessions})` : ''}`)}` });
def({ id: 'session-lines', group: 'money', desc: { en: 'Lines changed by Claude this session', ru: 'Строки, изменённые Claude за сессию' }, render: (d, o, t) => {
  const s = delta(t, d.in.cost?.total_lines_added || 0, d.in.cost?.total_lines_removed || 0);
  return s && `${t.paint('muted', `${t.iconSp('edit')}claude`)} ${s}`;
} });

def({ id: 'cache', group: 'cache', desc: { en: 'Prompt cache: warm/cold, when it expires', ru: 'Кэш промптов: тёплый/остыл, когда остынет' }, opts: { under: num(5, 0, 60, { en: 'Show only when fewer minutes are left, 0 — always', ru: 'Показывать, только если до остывания меньше N минут, 0 — всегда' }) },
  render: (d, o, t) => {
    const c = d.in.prompt_cache;
    if (!c?.caching_observed) return null;
    if (!c.warm) return `${t.paint('muted', 'cache')} ${t.paint('warn', 'cold')}`;
    const left = c.expires_at ? c.expires_at - d.now / 1000 : null;
    if (o.under && (left == null || left >= o.under * 60)) return null;
    const color = left != null && left < 60 ? 'crit' : left != null && left < 180 ? 'warn' : 'ok';
    return `${t.paint('muted', 'cache')} ${t.paint(color, left != null ? until(c.expires_at, d.now) : 'warm')}`;
  } });
def({ id: 'cache-hit', group: 'cache', desc: { en: 'Cache hit ratio and misses', ru: 'Доля попаданий в кэш и промахи' }, render: (d, o, t) => {
  const c = d.in.prompt_cache;
  if (c?.hit_ratio == null) return null;
  const pct = Math.round(c.hit_ratio * 100);
  return `${t.paint('muted', 'hit')} ${t.paint(pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'crit', `${pct}%`)}${c.misses ? t.paint('muted', ` ✗${c.misses}`) : ''}`;
} });

def({ id: 'git', group: 'git', desc: { en: 'Git: branch, commits to push/pull, +/− lines, untracked; in an umbrella folder a row per changed repo and Σ', ru: 'Git: ветка, коммиты to push/pull, +/− строк, untracked; в папке-зонтике строка на каждое изменённое репо и Σ' }, needs: ['git'],
  opts: {
    depth: num(2, 1, 4, { en: 'Repo search depth in umbrella', ru: 'Глубина поиска репо в зонтике' }), max: num(4, 1, 20, { en: 'How many dirty repos to show', ru: 'Сколько грязных репо показывать' }),
    showClean: bool(false, { en: 'Show clean repo count', ru: 'Показывать число чистых репо' }), branchMax: num(24, 0, 80, { en: 'Truncate branch name, 0 — never', ru: 'Обрезать имя ветки, 0 — не обрезать' }),
    rows: bool(true, { en: 'Umbrella: one line per repo', ru: 'Зонтик: каждое репо отдельной строкой' }),
    aheadBehind: bool(true, { en: 'Commits to push / to pull', ru: 'Коммиты to push / to pull' }),
    lines: bool(true, { en: '+/− lines', ru: '+/− строк' }), untracked: bool(true, { en: 'Untracked files', ru: 'Неотслеживаемые файлы' }), stash: bool(false, { en: 'Stash count (extra git call)', ru: 'Число stash (лишний вызов git)' }),
    budgetMs: num(400, 100, 3000, { en: 'Git time budget, ms', ru: 'Бюджет на git, мс' }),
  },
  render: (d, o, t) => {
    const g = d.git;
    if (!g) return null;
    const root = t.paint('repo', path.basename(g.root));
    if (g.mode === 'repo') return g.repo && `${root} ${repoBits(t, g.repo, o)}`;
    const dirty = g.repos.filter((r) => r.changed || r.untracked || r.ahead || r.behind || r.conflicts || (o.stash && r.stash));
    const name = (r) => path.relative(g.root, r.dir).split(path.sep).join('/');
    const dot = t.paint('muted', ' · ');
    let s = `${root} ${t.paint('muted', `— ${dirty.length} of ${g.repos.length} repos changed`)}`;
    if (o.showClean && g.repos.length > dirty.length) s += t.paint('muted', ` ✓${g.repos.length - dirty.length}`);
    if (!dirty.length) return s;
    const picked = dirty.slice(0, o.max);
    const nw = o.rows ? Math.max(0, ...picked.map((r) => name(r).length)) : 0;
    const bw = o.rows ? Math.max(0, ...picked.map((r) => cut(r.branch, o.branchMax).length)) : 0;
    const shown = picked.map((r) => `${t.paint('repo', name(r).padEnd(nw))}${o.rows ? '  ' : ' '}${repoBits(t, r, o, bw)}`);
    if (!o.rows) for (const r of shown) s += `${dot}${r}`;
    const more = dirty.length > o.max && t.paint('muted', `+${dirty.length - o.max} more`);
    const add = dirty.reduce((n, r) => n + (r.add || 0), 0), del = dirty.reduce((n, r) => n + (r.del || 0), 0);
    const sum = o.lines && dirty.length > 1 && (add || del) && `${t.paint('muted', t.icon('sum'))} ${delta(t, add, del)}`;
    if (o.rows) {
      const here = picked.map((r) => isInside(d.in.workspace?.current_dir, r.dir));
      // Claude Code trims leading whitespace of each line; U+2800 (blank braille) is not whitespace but renders empty.
      const mark = here.some(Boolean) ? (i) => (here[i] ? `${t.paint('info', t.icon('dir'))} ` : '\u2800 ') : () => '';
      const tail = [more, sum].filter(Boolean).join('   ');
      return { text: null, rows: [...shown.map((r, i) => mark(i) + r), tail && mark(-1) + tail].filter(Boolean) };
    }
    if (more) s += ` ${more}`;
    if (sum) s += `${dot}${sum}`;
    return s;
  } });
def({ id: 'worktree', group: 'git', desc: { en: 'Worktree name', ru: 'Имя worktree' }, render: (d, o, t) => {
  const n = d.in.worktree?.name || d.in.workspace?.git_worktree;
  return n && t.paint('info', `${t.icon('worktree')}${n}`);
} });
def({ id: 'repo', group: 'git', desc: { en: 'Repository owner/name, clickable', ru: 'owner/name репозитория, кликабельно' }, render: (d, o, t) => {
  const r = d.in.workspace?.repo;
  return r?.name && t.link(`https://${r.host}/${r.owner}/${r.name}`, t.paint('repo', `${r.owner}/${r.name}`));
} });
def({ id: 'pr', group: 'git', desc: { en: 'PR/MR: number and review state, clickable', ru: 'PR/MR: номер и статус ревью, кликабельно' }, opts: { state: bool(true, { en: 'Review state', ru: 'Статус ревью' }) }, render: (d, o, t) => {
  const p = d.in.pr;
  if (!p?.number) return null;
  const [color, word] = PR[p.review_state] || ['muted', ''];
  const icon = { approved: 'approved', changes_requested: 'changes', pending: 'pending', draft: 'draft' }[p.review_state];
  const text = `${p.kind === 'mr' ? '!' : '#'}${p.number}${o.state && icon ? ` ${t.iconSp(icon)}${word}` : ''}`;
  return t.paint(color, t.link(p.url, text));
} });

def({ id: 'dir', group: 'dir', desc: { en: 'Current folder', ru: 'Текущая папка' }, opts: { full: bool(false, { en: 'Full path', ru: 'Полный путь' }) }, render: (d, o, t) => {
  const p = d.in.workspace?.current_dir || d.in.cwd;
  return p && t.paint('dir', `${t.iconSp('dir')}${o.full ? p : path.basename(p)}`);
} });
def({ id: 'project-dir', group: 'dir', desc: { en: 'Launch folder, if different from current', ru: 'Папка запуска, если отличается от текущей' }, render: (d, o, t) => {
  const w = d.in.workspace || {};
  return w.project_dir && w.current_dir && path.resolve(w.project_dir) !== path.resolve(w.current_dir) && t.paint('muted', `⌂${path.basename(w.project_dir)}`);
} });
def({ id: 'added-dirs', group: 'dir', desc: { en: 'Folders added via /add-dir', ru: 'Число папок, добавленных через /add-dir' }, render: (d, o, t) => d.in.workspace?.added_dirs?.length > 0 && t.paint('muted', `+${d.in.workspace.added_dirs.length} dirs`) });

def({ id: 'activity', group: 'activity', desc: { en: 'Tool running right now', ru: 'Инструмент, который выполняется сейчас' }, needs: ['transcript'], opts: { detail: bool(true, { en: 'Argument: file, command, host', ru: 'Аргумент: файл, команда, хост' }) },
  render: (d, o, t) => {
    const x = d.transcript?.tool;
    return x && t.paint('info', `${t.iconSp('tool')}${x.name}${o.detail && x.detail ? ` ${t.paint('muted', x.detail)}` : ''}`);
  } });
def({ id: 'todos', group: 'activity', desc: { en: 'Todo / task progress', ru: 'Прогресс todo / задач' }, needs: ['transcript'], render: (d, o, t) => {
  const x = d.transcript?.todos;
  return x && x.total > 0 && `${t.iconSp('todo')}${t.paint(x.done === x.total ? 'ok' : 'info', `${x.done}/${x.total}`)}`;
} });
def({ id: 'subagents', group: 'activity', desc: { en: 'Subagents and attention signals', ru: 'Сабагенты и сигналы внимания' }, needs: ['transcript'], render: (d, o, t) => {
  const parts = [];
  if (d.transcript?.agents > 0) parts.push(`${t.paint('muted', 'agents')} ${t.paint('info', d.transcript.agents)}`);
  const alerts = d.transcript?.agent_attention || [];
  if (alerts[0]?.label) {
    const text = `${alerts[0].name} ${alerts[0].label}${alerts.length > 1 ? ` (+${alerts.length - 1})` : ''}`;
    const alert = t.paint(alerts[0].status === 'failed' ? 'crit' : 'warn', text);
    if (o.attentionRows) return { text: parts[0] || null, rows: [alert] };
    parts.push(alert);
  }
  return parts.join(t.paint('muted', ' · ')) || null;
} });

def({ id: 'clock', group: 'misc', desc: { en: 'Clock', ru: 'Время' }, opts: { seconds: bool(false, { en: 'With seconds', ru: 'С секундами' }) }, render: (d, o, t) => {
  const x = new Date(d.now);
  const hh = String(x.getHours()).padStart(2, '0'), mm = String(x.getMinutes()).padStart(2, '0');
  return t.paint('muted', `${t.iconSp('clock')}${hh}:${mm}${o.seconds ? `:${String(x.getSeconds()).padStart(2, '0')}` : ''}`);
} });
def({ id: 'text', group: 'misc', desc: { en: 'Custom text', ru: 'Произвольный текст' }, opts: { value: str('', { en: 'Text', ru: 'Текст' }), color: str('muted', { en: 'Color', ru: 'Цвет' }) }, render: (d, o, t) => o.value && t.paint(o.color, o.value) });
def({ id: 'cmd', group: 'misc', desc: { en: 'Output of your own command (cached)', ru: 'Вывод своей команды (кэшируется)' }, opts: { command: str('', { en: 'Command', ru: 'Команда' }), ttl: num(30, 1, 3600, { en: 'Cache, sec', ru: 'Кэш, сек' }), color: str('muted', { en: 'Color', ru: 'Цвет' }) },
  render: (d, o, t) => {
    if (!o.command) return null;
    const key = cacheMod.file(`cmd-${Buffer.from(o.command).toString('hex').slice(0, 32)}`);
    const c = readJson(key);
    if (c && d.now - c.at < o.ttl * 1000) return c.out ? t.paint(o.color, c.out) : null;
    let out = '';
    try { out = execSync(o.command, { timeout: 500, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { /* show nothing on failure */ }
    try { writeJson(key, { at: d.now, out }); } catch { /* cache is best-effort */ }
    return out ? t.paint(o.color, out) : null;
  } });

for (const id of ['codex', 'kimi']) {
  def({ id, group: 'session', desc: { en: id + ' executor: model, context, tokens and limits', ru: id + ': модель, контекст, токены и лимиты' }, needs: [id],
    opts: { tokens: bool(false, { en: 'Session token totals', ru: 'Токены сессии' }), exclude: str('', { en: 'Hide in paths separated by ;', ru: 'Скрывать в путях через ;' }), maxAge: num(120, 0, 10080, { en: 'Maximum session age, minutes', ru: 'Макс. возраст сессии, мин' }), idleAfter: num(10, 0, 10080, { en: 'Hide after inactivity, minutes', ru: 'Скрывать после бездействия, мин' }) },
    accepts: (d, o, updatedAt = d.now) => {
      const root = d.in.workspace?.project_dir || d.in.workspace?.current_dir || d.in.cwd || process.cwd();
      return d.in.harness !== 'codex' && d.now - updatedAt <= Math.min(o.maxAge, o.idleAfter) * 60000
        && !o.exclude.split(';').some((p) => p.trim() && isInside(root, p.trim()));
    },
    render: (d, o, t) => {
      const source = d[id];
      if (!source) return null;
      const agents = (source.agents || [source]).filter((a) => byId[id].accepts(d, o, a.updatedAt));
      // One row per agent: pad plain text before painting so name/model/effort line up in columns.
      const col = (get) => Math.max(0, ...agents.map((a) => (get(a) || '').length));
      const nw = col((a) => a.name), mw = col((a) => a.input.model?.display_name), ew = col((a) => a.input.effort?.level);
      const pad = (s, w) => (w ? (s || '').padEnd(w) : s);
      const rendered = agents.map((agent) => {
        const input = agent.input, u = input.token_usage, rows = agents.length > 1;
        const parts = [[nw && t.paint('muted', rows ? pad(agent.name, nw) : agent.name), mw && t.paint('model', rows ? pad(input.model?.display_name, mw) : input.model?.display_name), ew && t.paint('muted', rows ? pad(input.effort?.level, ew) : input.effort?.level)].filter((s) => s && s.trim()).join(' '),
          contextText(input.context_window, optsFor(byId.context, {}), t),
          o.tokens && u && t.paint('muted', 'in ' + tokens(u.input_tokens || 0) + ' out ' + tokens(u.output_tokens || 0) + ' cache ' + tokens(u.cached_input_tokens || 0)),
          agent.limited && t.paint('crit', agent.limitWindow ? `limit ${agent.limitWindow}` : 'limit')].filter(Boolean);
        return parts.join(t.paint('separator', o.separator));
      }).filter(Boolean);
      const quotas = agents.find((a) => a.input.quota_windows?.length)?.input.quota_windows || [];
      const limits = quotas.map((w) => limitText(t, w.label, w.used_percentage, w.resets_at, w.window_seconds, d.now, optsFor(byId['limit-5h'], {}))).filter(Boolean);
      if (rendered.length > 1) {
        // Claude Code trims leading whitespace; U+2800 keeps the continuation rows indented under the first agent.
        const indent = '⠀' + ' '.repeat(id.length);
        const first = [rendered[0], ...limits].join(t.paint('separator', o.separator));
        return { text: null, rows: [t.paint('muted', id) + ' ' + first, ...rendered.slice(1).map((r) => indent + r)] };
      }
      const parts = [...rendered, ...limits].filter(Boolean);
      return parts.length ? t.paint('muted', id) + ' ' + parts.join(t.paint('separator', o.separator)) : null;
    } });
}

const GROUPS = { session: { en: 'Model & session', ru: 'Модель и сессия' }, context: { en: 'Context', ru: 'Контекст' }, limits: { en: 'Limits', ru: 'Лимиты' }, money: { en: 'Money & edits', ru: 'Деньги и правки' }, cache: { en: 'Prompt cache', ru: 'Кэш промптов' }, git: 'Git', dir: { en: 'Folders', ru: 'Папки' }, activity: { en: 'Live activity', ru: 'Живая активность' }, misc: { en: 'Misc', ru: 'Прочее' } };
const byId = Object.fromEntries(W.map((w) => [w.id, w]));

function optsFor(w, config) {
  const defaults = Object.fromEntries(Object.entries(w.opts || {}).map(([k, v]) => [k, v.default]));
  return { separator: config.separator ?? '   ', ...defaults, ...(config.widgets?.[w.id] || {}) };
}

module.exports = { WIDGETS: W, byId, GROUPS, optsFor };
