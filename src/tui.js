'use strict';
const readline = require('readline');
const config = require('./config');
const { WIDGETS, GROUPS, byId } = require('./widgets');
const { renderLines, loadData } = require('./render');
const { makeTheme, COLOR_NAMES, ICONS } = require('./theme');
const { sample, sampleSources, codexSample } = require('./sample');
const { HARNESS } = require('./util');
const { detectLang, tr, makeT, UI } = require('./i18n');

const out = process.stdout;
const write = (s) => out.write(s);
const ESC = '\x1b[';

const GLOBAL = [
  { key: 'lang', label: UI.g_lang, type: 'enum', values: ['auto', 'en', 'ru'] },
  { key: 'money', label: UI.g_money, type: 'enum', values: ['auto', 'always'] },
  { key: 'gapAfter', label: UI.g_gap, type: 'bool' },
  ...(HARNESS === 'codex' ? [{ key: 'maxLines', label: UI.g_maxLines, type: 'number', min: 1, max: 32 }] : []),
  { key: 'icons', label: UI.g_icons, type: 'enum', values: Object.keys(ICONS) },
  { key: 'separator', label: UI.g_separator, type: 'string' },
  { key: 'thresholds.warn', label: UI.g_warn, type: 'number', min: 1, max: 99 },
  { key: 'thresholds.crit', label: UI.g_crit, type: 'number', min: 1, max: 100 },
  { key: 'color', label: UI.g_color, type: 'bool' },
  { key: 'links', label: UI.g_links, type: 'bool' },
  { key: 'usageTtl', label: UI.g_usageTtl, type: 'number', min: 30, max: 3600 },
  { key: 'todayTtl', label: UI.g_todayTtl, type: 'number', min: 30, max: 3600 },
  ...Object.keys(config.DEFAULTS.colors).map((k) => ({ key: `colors.${k}`, label: { en: `${UI.g_colorKey.en}: ${k}`, ru: `${UI.g_colorKey.ru}: ${k}` }, type: 'color' })),
];

const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; }

function run() {
  if (!process.stdin.isTTY) {
    out.write(`${makeT(detectLang(config.load()))('needTty')}\n`);
    process.exit(1);
  }
  const cfg = config.load();
  const lang = detectLang(cfg);
  const T = makeT(lang);
  let dirty = false, quitArmed = false, mode = 'layout', cursor = 0, sub = 0, filter = '', input = null, msg = '';
  const now = Date.now();
  const fakeGit = {
    mode: 'umbrella', root: process.cwd(), repos: [
      { dir: `${process.cwd()}/api`, branch: 'main', ahead: 1, behind: 0, changed: 3, untracked: 1, conflicts: 0, add: 120, del: 14, stash: 0 },
      { dir: `${process.cwd()}/web`, branch: 'feat/login', ahead: 0, behind: 2, changed: 1, untracked: 0, conflicts: 0, add: 8, del: 2, stash: 1 },
      { dir: `${process.cwd()}/infra`, branch: 'main', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0, add: 0, del: 0, stash: 0 },
    ],
  };
  let previewData = null;
  const demo = HARNESS === 'codex' ? codexSample(now, process.cwd()) : null;
  const previewSources = demo ? { usage: () => null, today: () => null, plan: () => demo.plan, transcript: () => demo.activity } : sampleSources(now);
  loadData(demo?.input || sample(now, process.cwd()), { ...cfg, lines: [WIDGETS.map((w) => w.id)] }, now, { ...previewSources, git: () => demo?.git || fakeGit })
    .then((d) => { previewData = d; draw(); });

  function rows() {
    const r = [];
    cfg.lines.forEach((line, li) => {
      r.push({ kind: 'line', li });
      line.forEach((it, ii) => r.push({ kind: 'item', li, ii, id: typeof it === 'string' ? it : it.id }));
    });
    r.push({ kind: 'newline' });
    return r;
  }

  const current = () => rows()[Math.min(cursor, rows().length - 1)];
  const touch = () => { dirty = true; };

  function insertAt(id) {
    const c = current();
    if (c.kind === 'newline') { cfg.lines.push([id]); cursor = rows().length - 2; }
    else if (c.kind === 'line') { cfg.lines[c.li].push(id); }
    else { cfg.lines[c.li].splice(c.ii + 1, 0, id); cursor++; }
    touch();
  }

  function move(dir) {
    const c = current();
    if (c.kind !== 'item') return;
    const line = cfg.lines[c.li];
    const ni = c.ii + dir;
    if (ni >= 0 && ni < line.length) { [line[c.ii], line[ni]] = [line[ni], line[c.ii]]; cursor += dir; }
    else if (dir < 0 && c.li > 0) { cfg.lines[c.li - 1].push(line.splice(c.ii, 1)[0]); cursor -= 1; }
    else if (dir > 0 && c.li < cfg.lines.length - 1) { cfg.lines[c.li + 1].unshift(line.splice(c.ii, 1)[0]); cursor += 1; }
    touch();
  }

  function remove() {
    const c = current();
    if (c.kind === 'item') { cfg.lines[c.li].splice(c.ii, 1); touch(); }
    else if (c.kind === 'line' && cfg.lines.length > 1) { cfg.lines.splice(c.li, 1); touch(); }
    cursor = Math.min(cursor, rows().length - 1);
  }

  const pickerList = () => WIDGETS.filter((w) => !filter || w.id.includes(filter) || tr(w.desc, lang).toLowerCase().includes(filter.toLowerCase()));
  const optList = () => { const c = current(); const w = c?.kind === 'item' && byId[c.id]; return w ? Object.entries(w.opts || {}).map(([k, o]) => ({ key: `widgets.${w.id}.${k}`, ...o, label: tr(o.desc, lang) })) : []; };
  const fieldList = () => (mode === 'options' ? optList() : GLOBAL);
  const fieldValue = (f) => { const v = getPath(cfg, f.key); return v === undefined ? f.default : v; };

  function adjust(f, dir) {
    const v = fieldValue(f);
    if (f.type === 'bool') setPath(cfg, f.key, !v);
    else if (f.type === 'number') setPath(cfg, f.key, Math.min(f.max ?? 1e9, Math.max(f.min ?? 0, (v ?? 0) + dir)));
    else if (f.type === 'enum') { const i = f.values.indexOf(v); setPath(cfg, f.key, f.values[(i + dir + f.values.length) % f.values.length]); }
    else if (f.type === 'color') { const i = COLOR_NAMES.indexOf(v); setPath(cfg, f.key, COLOR_NAMES[(i + dir + COLOR_NAMES.length) % COLOR_NAMES.length]); }
    else return;
    touch();
  }

  function draw() {
    const theme = makeTheme(cfg);
    const W = out.columns || 100, H = out.rows || 30;
    const lines = [];
    const rule = (title) => theme.paint('muted', `── ${title} ${'─'.repeat(Math.max(0, W - title.length - 5))}`);
    lines.push(`${theme.paint('model', 'claude-statusline')} ${dirty ? theme.paint('warn', T('unsaved')) : theme.paint('ok', T('saved'))}   ${theme.paint('muted', msg)}`);
    lines.push(rule(T('preview')));
    if (previewData) for (const l of renderLines(cfg, previewData, theme)) lines.push(l);
    else lines.push(theme.paint('muted', T('loading')));

    if (mode === 'layout') {
      lines.push(rule(T('layout')));
      const rs = rows();
      const view = Math.max(5, H - lines.length - 6);
      const start = Math.max(0, Math.min(cursor - Math.floor(view / 2), rs.length - view));
      rs.slice(start, start + view).forEach((r, k) => {
        const sel = start + k === cursor;
        const mark = sel ? theme.paint('warn', '▸ ') : '  ';
        if (r.kind === 'line') lines.push(`${mark}${theme.paint('model', `${T('line')} ${r.li + 1}`)}`);
        else if (r.kind === 'newline') lines.push(`${mark}${theme.paint('muted', T('newLine'))}`);
        else if (r.id === '|') lines.push(`${mark}   ${theme.paint('muted', `${cfg.separator.trim() || '│'}  ${T('separator')}`)}`);
        else lines.push(`${mark}   ${r.id.padEnd(18)} ${theme.paint('muted', tr(byId[r.id]?.desc, lang) || T('unknownWidget'))}`);
      });
      lines.push(rule(T('keys')));
      lines.push(theme.paint('muted', T('layoutKeys')));
    } else if (mode === 'picker') {
      lines.push(rule(`${T('addWidget')}  ${filter ? `${T('filter')}: ${filter}` : T('typeToFilter')}`));
      const list = pickerList();
      const view = Math.max(5, H - lines.length - 3);
      const start = Math.max(0, Math.min(sub - Math.floor(view / 2), list.length - view));
      list.slice(start, start + view).forEach((w, k) => {
        const sel = start + k === sub;
        lines.push(`${sel ? theme.paint('warn', '▸ ') : '  '}${w.id.padEnd(18)} ${theme.paint('muted', `${tr(GROUPS[w.group], lang)}: ${tr(w.desc, lang)}`)}`);
      });
      lines.push(theme.paint('muted', T('pickerKeys')));
    } else {
      const fields = fieldList();
      lines.push(rule(mode === 'options' ? `${T('options')}: ${current()?.id}` : T('global')));
      if (!fields.length) lines.push(theme.paint('muted', T('noOptions')));
      fields.forEach((f, k) => {
        const sel = k === sub;
        let v = fieldValue(f);
        if (f.type === 'bool') v = v ? theme.paint('ok', '✓') : theme.paint('muted', '×');
        else if (f.type === 'color') v = theme.paint(f.key.split('.').pop(), v);
        else v = JSON.stringify(v);
        if (input && sel) v = `${input.text}${theme.paint('warn', '▏')}`;
        lines.push(`${sel ? theme.paint('warn', '▸ ') : '  '}${tr(f.label, lang).padEnd(36)} ${v}`);
      });
      lines.push(theme.paint('muted', input ? T('inputKeys') : T('fieldKeys')));
    }
    write(`${ESC}H${ESC}2J${lines.join('\n')}`);
  }

  function save() { config.save(cfg); dirty = false; msg = `${T('writtenTo')} ${config.CONFIG_PATH}`; }

  function quit() {
    write(`${ESC}?25h${ESC}?1049l`);
    process.stdin.setRawMode(false);
    process.exit(0);
  }

  function onKey(str, key = {}) {
    msg = '';
    const name = key.name;
    if (key.ctrl && name === 'c') return quit();

    if (input) {
      if (name === 'escape') input = null;
      else if (name === 'return') { setPath(cfg, input.key, input.text); input = null; touch(); }
      else if (name === 'backspace') input.text = input.text.slice(0, -1);
      else if (str && !key.ctrl && str >= ' ') input.text += str;
      return draw();
    }

    if (mode === 'layout') {
      const n = rows().length;
      if (name === 'up' || name === 'k') cursor = Math.max(0, cursor - 1);
      else if (name === 'down' || name === 'j') cursor = Math.min(n - 1, cursor + 1);
      else if (str === 'K') move(-1);
      else if (str === 'J') move(1);
      else if (str === 'a') { mode = 'picker'; sub = 0; filter = ''; }
      else if (str === 'd' || name === 'delete') remove();
      else if (str === '|') insertAt('|');
      else if (str === 'n') { cfg.lines.push([]); cursor = rows().length - 2; touch(); }
      else if (str === 'g') { mode = 'global'; sub = 0; }
      else if (name === 'return' && current()?.kind === 'item' && current().id !== '|') { mode = 'options'; sub = 0; }
      else if (name === 'return' && current()?.kind === 'newline') { cfg.lines.push([]); touch(); }
      else if (str === 's') save();
      else if (str === 'q') {
        if (dirty && !quitArmed) { quitArmed = true; msg = T('quitConfirm'); return draw(); }
        return quit();
      }
      quitArmed = false;
      return draw();
    }

    if (mode === 'picker') {
      const list = pickerList();
      if (name === 'escape') mode = 'layout';
      else if (name === 'up') sub = Math.max(0, sub - 1);
      else if (name === 'down') sub = Math.min(list.length - 1, sub + 1);
      else if (name === 'return' && list[sub]) { insertAt(list[sub].id); mode = 'layout'; }
      else if (name === 'backspace') { filter = filter.slice(0, -1); sub = 0; }
      else if (str && str.length === 1 && str >= ' ') { filter += str; sub = 0; }
      return draw();
    }

    const fields = fieldList();
    const f = fields[sub];
    if (name === 'escape') { mode = 'layout'; sub = 0; }
    else if (name === 'up') sub = Math.max(0, sub - 1);
    else if (name === 'down') sub = Math.min(fields.length - 1, sub + 1);
    else if (f && (name === 'left' || name === 'right')) adjust(f, name === 'left' ? -1 : 1);
    else if (f && str === ' ') adjust(f, 1);
    else if (f && name === 'return') {
      if (f.type === 'string' || f.type === 'color') input = { key: f.key, text: String(fieldValue(f) ?? '') };
      else adjust(f, 1);
    } else if (str === 's') save();
    return draw();
  }

  write(`${ESC}?1049h${ESC}?25l`);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', onKey);
  out.on('resize', draw);
  draw();
}

module.exports = { run };
