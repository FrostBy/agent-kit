'use strict';

function sample(now = Date.now(), cwd = process.cwd()) {
  const s = Math.floor(now / 1000);
  return {
    cwd,
    session_id: 'preview',
    session_name: 'statusline preview',
    transcript_path: null,
    model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [], repo: { host: 'github.com', owner: 'you', name: 'project' } },
    version: '2.1.300',
    output_style: { name: 'default' },
    cost: { total_cost_usd: 4.37, total_duration_ms: 5_400_000, total_api_duration_ms: 1_900_000, total_lines_added: 248, total_lines_removed: 37 },
    context_window: {
      total_input_tokens: 84_000, total_output_tokens: 2100, context_window_size: 200_000, used_percentage: 42, remaining_percentage: 58,
      current_usage: { input_tokens: 1200, output_tokens: 2100, cache_creation_input_tokens: 4800, cache_read_input_tokens: 78_000 },
    },
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: s + 2400, requests: 31, misses: 1, hit_ratio: 0.93 },
    fast_mode: false,
    effort: { level: 'high' },
    thinking: { enabled: true },
    rate_limits: {
      five_hour: { used_percentage: 63, resets_at: s + 3600 },
      seven_day: { used_percentage: 41, resets_at: s + 3 * 86400 },
    },
    pr: { number: 128, url: 'https://github.com/you/project/pull/128', review_state: 'approved' },
  };
}

const sampleSources = (now) => ({
  usage: () => ({
    limits: [{ kind: 'weekly_scoped', percent: 18, resets_at: new Date(now + 3 * 86400e3).toISOString(), scope: { model: { display_name: 'Fable' } } }],
    seven_day_breakdown: { rows: [{ display_name: 'Claude Code', percent: 92 }, { display_name: 'Chats', percent: 8 }] },
  }),
  plan: () => ({ label: 'Max 20x', api: false }),
  transcript: () => ({ tool: { name: 'Edit', detail: 'render.js' }, agents: 2, todos: { done: 3, total: 7 }, permissionMode: 'acceptEdits' }),
  today: () => ({ total: 23.8, sessions: 5 }),
});

function codexSample(now = Date.now(), cwd = process.cwd()) {
  const path = require('path');
  const base = sample(now, cwd);
  const input = {
    harness: 'codex', session_id: 'demo', model: { display_name: 'gpt-6.1-sol' }, effort: base.effort,
    workspace: { project_dir: cwd, current_dir: path.join(cwd, 'api') }, cost: { total_duration_ms: 5_400_000 },
    context_window: { context_window_size: 475000, used_tokens: 199500, used_percentage: 42 },
    quota_windows: [
      { label: '5h', used_percentage: 63, resets_at: now / 1000 + 6120, window_seconds: 18000 },
      { label: '7d', used_percentage: 41, resets_at: now / 1000 + 288000, window_seconds: 604800 },
    ],
    token_usage: { input_tokens: 1400000, output_tokens: 18000, cached_input_tokens: 1280000, reasoning_output_tokens: 5000 },
  };
  return {
    input, plan: { label: 'Pro', api: false }, usageAt: new Date(now).toISOString(),
    activity: { tool: { name: 'exec', detail: 'npm test' }, todos: { done: 3, total: 7 }, agents: 2 },
    git: {
      mode: 'umbrella', root: cwd, repos: [
        { dir: path.join(cwd, 'api'), branch: 'master', changed: 6, deleted: 1, staged: 2, untracked: 3, add: 120, del: 34, ahead: 2, behind: 0, conflicts: 0, stash: 0 },
        { dir: path.join(cwd, 'web'), branch: 'feat/login', changed: 2, deleted: 0, staged: 0, untracked: 1, add: 48, del: 12, ahead: 0, behind: 1, conflicts: 0, stash: 1 },
        { dir: path.join(cwd, 'infra'), branch: 'master', changed: 1, deleted: 0, staged: 0, untracked: 0, add: 3, del: 1, ahead: 0, behind: 0, conflicts: 0, stash: 0 },
      ],
    },
  };
}

module.exports = { sample, sampleSources, codexSample };
