'use strict';
const { HARNESS, CONFIG_PATH, readJson, writeJson, deepMerge } = require('./util');

const DEFAULTS = {
  lines: [
    ['model', 'effort', 'fast', '|', 'context', '|', 'activity', '|', 'todos', '|', 'subagents'],
    ['limit-5h', '|', 'limit-7d', '|', 'limit-model'],
    ['cost', '|', 'cost-today', '|', 'cache', '|', 'pr'],
    ['git', '|', 'worktree'],
  ],
  separator: '   ',
  gapAfter: true,
  money: 'auto',
  lang: 'auto',
  icons: 'unicode',
  color: true,
  links: true,
  thresholds: { warn: 50, crit: 80 },
  usageTtl: 120,
  todayTtl: 300,
  colors: {
    model: 'cyan', muted: 'gray', ok: 'green', warn: 'yellow', crit: 'red', info: 'cyan',
    branch: 'magenta', repo: 'blue', dir: 'blue', separator: 'gray',
  },
  widgets: {},
  subagent: { show: ['type', 'model', 'effort', 'tokens', 'spark', 'elapsed', 'label'] },
};

const CODEX_DEFAULTS = deepMerge(DEFAULTS, {
  maxLines: 4,
  lines: [
    DEFAULTS.lines[0],
    ['limits'],
    DEFAULTS.lines[2],
    DEFAULTS.lines[3],
  ],
});

function load(p = CONFIG_PATH) {
  return deepMerge(HARNESS === 'codex' ? CODEX_DEFAULTS : DEFAULTS, readJson(p) || {});
}

const save = (cfg, p = CONFIG_PATH) => writeJson(p, cfg);

module.exports = { DEFAULTS, CODEX_DEFAULTS, load, save, CONFIG_PATH };
