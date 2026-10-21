'use strict';

const ANSI = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};
const COLOR_NAMES = Object.keys(ANSI);

// Checked by eye in Windows Terminal: glyphs missing from Cascadia Mono come from a fallback font and can be
// wider than a cell; the gear overlaps a single space, so it carries its own extra one.
const ICONS = {
  unicode: {
    branch: '⎇', ahead: '↑', behind: '↓', untracked: '?', stash: '≡', edit: '✎', reset: '↻', pace: '▲',
    approved: '✓', changes: '❌', pending: '•', draft: '◌', thinking: '💭', fast: '»', clock: '◷',
    cacheWarm: '●', cacheCold: '○', warn: '⚠️', tool: '⚙ ', agent: '◆', todo: '📋', sum: 'Σ', dir: '▸',
    barFull: '▰', barEmpty: '▱', worktree: '⑂', link: '🔗',
  },
  ascii: {
    branch: 'git:', ahead: '^', behind: 'v', untracked: '?', stash: 'st:', edit: 'ed:', reset: '@', pace: '!',
    approved: 'ok', changes: 'x', pending: '..', draft: 'dr', thinking: 'T', fast: 'F', clock: '',
    cacheWarm: 'c+', cacheCold: 'c-', warn: '!!', tool: 'run:', agent: 'ag:', todo: 'todo', sum: 'sum', dir: '',
    barFull: '#', barEmpty: '-', worktree: 'wt:', link: '',
  },
  nerd: {
    branch: '', ahead: '', behind: '', untracked: '', stash: '', edit: '', reset: '', pace: '',
    approved: '', changes: '', pending: '', draft: '', thinking: '', fast: '', clock: '',
    cacheWarm: '', cacheCold: '', warn: '', tool: '', agent: '', todo: '', sum: 'Σ', dir: '',
    barFull: '█', barEmpty: '░', worktree: '', link: '',
  },
};

function makeTheme(config) {
  const colorOn = config.color !== false && !process.env.NO_COLOR;
  const icons = ICONS[config.icons] || ICONS.unicode;
  const colors = config.colors || {};

  function code(spec) {
    if (!spec) return null;
    if (ANSI[spec]) return `${ANSI[spec]}`;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(spec);
    return m ? `38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}` : null;
  }

  // Semantic keys ("ok", "branch") resolve through config.colors first, so users restyle without touching widgets.
  function paint(key, text) {
    if (text === '' || text == null) return '';
    if (!colorOn) return String(text);
    const c = code(colors[key] !== undefined ? colors[key] : key);
    return c ? `\x1b[${c}m${text}\x1b[0m` : String(text);
  }

  const thresholds = config.thresholds || { warn: 50, crit: 80 };
  const sevKey = (pct) => (pct >= thresholds.crit ? 'crit' : pct >= thresholds.warn ? 'warn' : 'ok');
  const sev = (pct, text) => paint(sevKey(pct), text);
  const link = (url, text) => (colorOn && url && config.links !== false ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);

  return { paint, sev, sevKey, link, icon: (n) => icons[n] ?? '', iconSp: (n) => (icons[n] ? `${icons[n]} ` : ''), icons, colorOn };
}

module.exports = { makeTheme, ICONS, COLOR_NAMES };
