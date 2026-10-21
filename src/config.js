'use strict';
const { CONFIG_PATH, readJson, writeJson, deepMerge } = require('./util');

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

function load(p = CONFIG_PATH) {
  return deepMerge(DEFAULTS, readJson(p) || {});
}

const save = (cfg, p = CONFIG_PATH) => writeJson(p, cfg);

module.exports = { DEFAULTS, load, save, CONFIG_PATH };
