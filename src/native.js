'use strict';
const { render, renderLines } = require('./render');
const { byId, optsFor } = require('./widgets');
const { detectLang } = require('./i18n');
const { stripVTControlCharacters } = require('util');
const path = require('node:path');

function execDetail(command) {
  const text = command.trim();
  const match = /^(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s*([\s\S]*)$/.exec(text);
  if (!match) return text;
  const executable = path.win32.basename(match[1] || match[2] || match[3]);
  const args = match[4].replace(/[\r\n\t]+/g, ' ').trim();
  const detail = executable + (args ? ' ' + args : '');
  return detail.length > 40 ? detail.slice(0, 39) + '\u2026' : detail;
}

async function renderNative(snapshot, config, now = Date.now(), sources = {}) {
  if (snapshot?.schema_version !== 1 || typeof snapshot.cwd !== 'string' || !snapshot.model?.id) {
    throw new Error('expected a schema_version=1 snapshot from patched Codex');
  }
  const cw = snapshot.context_window || {};
  const windows = (snapshot.rate_limits || []).flatMap(({ id, primary, secondary }) => [primary, secondary].flatMap((w, i) => {
    if (!w || !Number.isFinite(w.used_percentage)) return [];
    const minutes = w.window_minutes;
    const label = minutes > 0 ? minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m` : i ? 'secondary' : 'primary';
    return [{ label: id === 'codex' ? label : `${id} ${label}`, used_percentage: w.used_percentage, resets_at: w.resets_at, window_seconds: minutes > 0 ? minutes * 60 : null }];
  }));
  const input = {
    ...snapshot,
    harness: 'codex',
    mode: ['default', 'auto', 'plan', 'read-only'].includes(snapshot.mode) ? snapshot.mode : null,
    context_window: cw.context_window_size > 0 ? cw : null,
    workspace: { project_dir: snapshot.project_dir || snapshot.cwd, current_dir: snapshot.cwd },
    quota_windows: windows,
    token_usage: { input_tokens: cw.total_input_tokens, output_tokens: cw.total_output_tokens, cached_input_tokens: cw.cached_input_tokens, reasoning_output_tokens: cw.reasoning_output_tokens },
  };
  const labels = detectLang(config) === 'ru'
    ? { waiting_approval: 'ждёт подтверждения', waiting_input: 'ждёт ответа', failed: 'ошибка' }
    : { waiting_approval: 'awaits approval', waiting_input: 'awaits reply', failed: 'failed' };
  const activity = snapshot.activity ? {
    ...snapshot.activity,
    tool: snapshot.activity.tool?.name === 'exec' && typeof snapshot.activity.tool.detail === 'string'
      ? { ...snapshot.activity.tool, detail: execDetail(snapshot.activity.tool.detail) } : snapshot.activity.tool,
    agent_attention: (Array.isArray(snapshot.activity.agent_attention) ? snapshot.activity.agent_attention : [])
      .filter((alert) => alert && typeof alert.name === 'string' && alert.name.trim() && Object.hasOwn(labels, alert.status))
      .map((alert) => ({ ...alert, label: labels[alert.status] })),
  } : null;
  const cfg = { ...config, links: false,
    lines: config.lines.map((line) => line.filter((item) => (typeof item === 'string' ? item : item?.id) !== 'mode')),
    widgets: { ...config.widgets, context: { ...config.widgets?.context, ...(cw.used_tokens == null ? { used: false, left: false } : {}) } } };
  const [mode] = renderLines({ ...cfg, lines: [['mode']] }, { in: input, now });
  let rows = renderLines(cfg, { in: input, now, transcript: activity });
  const alert = activity?.agent_attention[0];
  if (alert && rows.map(stripVTControlCharacters).some((line) => line.includes(`${alert.name} ${alert.label}`) && line.length > (snapshot.columns || 80) - 4)) {
    cfg.widgets.subagents = { ...config.widgets?.subagents, attentionRows: true };
    rows = renderLines(cfg, { in: input, now, transcript: activity });
  }
  const rowBudget = Math.min(32, Math.max(mode ? 2 : 1, (snapshot.rows || 24) - 8));
  const maxLines = Math.min(rowBudget - (mode ? 2 : 0),
    Number.isFinite(config.maxLines) ? Math.max(1, Math.floor(config.maxLines)) : 4);
  const available = Math.max(1, Math.min(maxLines, rowBudget - (mode ? 2 : 0) - Number(!!cfg.gapAfter)) - rows.length - 1);
  cfg.widgets.git = { ...config.widgets?.git, max: Math.min(optsFor(byId.git, cfg).max, available) };
  const lines = (await render(input, cfg, now, { ...sources, usage: () => null, today: () => null, plan: () => null, transcript: () => activity })).slice(0, maxLines);
  // Codex discards empty stdout lines; blank braille preserves the mode spacer.
  if (mode) lines.push('\u2800', mode);
  if (cfg.gapAfter && lines.length && lines.length < rowBudget) lines.push('\u2800');
  return lines;
}

module.exports = { renderNative };
