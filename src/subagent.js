'use strict';
const { tokens, duration, sparkline } = require('./util');
const { makeTheme } = require('./theme');

const shortModel = (id) => (id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const STATUS = { running: 'info', completed: 'ok', failed: 'crit', killed: 'muted' };

function renderTask(task, config, now, theme) {
  const show = new Set(config.subagent?.show || []);
  const parts = [theme.paint(STATUS[task.status] || 'muted', `${theme.icon('agent')}${task.name || task.agentType || 'agent'}`)];
  if (show.has('type') && task.name && task.agentType) parts.push(theme.paint('muted', task.agentType));
  if (show.has('model') && task.model) parts.push(theme.paint('model', shortModel(task.model)));
  if (show.has('effort') && task.effort != null) parts.push(theme.paint('muted', String(task.effort)));
  if (show.has('tokens') && task.tokenCount != null) {
    let s = tokens(task.tokenCount);
    if (task.contextWindowSize) {
      const pct = Math.round((task.tokenCount / task.contextWindowSize) * 100);
      s += ` ${theme.sev(pct, `${pct}%`)}`;
    }
    parts.push(s);
  }
  if (show.has('spark') && task.tokenSamples?.length > 1) parts.push(theme.paint('info', sparkline(task.tokenSamples)));
  if (show.has('elapsed') && task.startTime) parts.push(theme.paint('muted', duration(now - task.startTime)));
  if (show.has('label') && task.label) parts.push(theme.paint('muted', task.label));
  return parts.join(theme.paint('separator', ' · '));
}

function renderSubagents(input, config, now = Date.now()) {
  const theme = makeTheme(config);
  return (input.tasks || []).map((task) => JSON.stringify({ id: task.id, content: renderTask(task, config, now, theme) }));
}

module.exports = { renderSubagents, renderTask };
