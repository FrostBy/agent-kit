'use strict';
const { render, renderLines } = require('./render');
const { byId, optsFor } = require('./widgets');
const { detectLang } = require('./i18n');
const { stripVTControlCharacters } = require('util');

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
    agent_attention: (Array.isArray(snapshot.activity.agent_attention) ? snapshot.activity.agent_attention : [])
      .filter((alert) => alert && typeof alert.name === 'string' && alert.name.trim() && Object.hasOwn(labels, alert.status))
      .map((alert) => ({ ...alert, label: labels[alert.status] })),
  } : null;
  const cfg = { ...config, links: false, widgets: { ...config.widgets, context: { ...config.widgets?.context, ...(cw.used_tokens == null ? { used: false, left: false } : {}) } } };
  let rows = renderLines(cfg, { in: input, now, transcript: activity });
  const alert = activity?.agent_attention[0];
  if (alert && rows.map(stripVTControlCharacters).some((line) => line.includes(`${alert.name} ${alert.label}`) && line.length > (snapshot.columns || 80) - 4)) {
    cfg.widgets.subagents = { ...config.widgets?.subagents, attentionRows: true };
    rows = renderLines(cfg, { in: input, now, transcript: activity });
  }
  const maxLines = Math.min(32, Math.max(1, (snapshot.rows || 24) - 8));
  const available = Math.max(1, maxLines - rows.length - Number(!!cfg.gapAfter) - 1);
  cfg.widgets.git = { ...config.widgets?.git, max: Math.min(optsFor(byId.git, cfg).max, available) };
  const lines = (await render(input, cfg, now, { ...sources, usage: () => null, today: () => null, plan: () => null, transcript: () => activity })).slice(0, maxLines);
  if (cfg.gapAfter && lines.length && lines.length < maxLines) lines.push('\u2800');
  return lines;
}

module.exports = { renderNative };
