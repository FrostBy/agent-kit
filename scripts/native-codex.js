'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cwd = process.argv[2] ? path.resolve(process.argv[2]) : root;
const binary = path.join(root, '.native', 'target', 'debug', 'codex.exe');
const home = path.join(root, '.native', 'test-home');
if (!fs.existsSync(binary)) throw new Error(`Build the isolated Codex first: ${binary}`);
fs.mkdirSync(home, { recursive: true });
const command = [process.execPath, path.join(root, 'statusline.js'), '--codex-native'];
const overrides = {
  model_provider: 'footer-test',
  'model_providers.footer-test': { name: 'Isolated footer test', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses', needs_openai_auth: false },
  'tui.status_line_command': { command, refresh_interval_ms: 1000, timeout_ms: 1500, max_lines: 32 },
};
const toml = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.entries(value).map(([key, val]) => `${key}=${toml(val)}`).join(',')}}`
  : JSON.stringify(value);
const args = ['--no-daemon', '--sandbox', 'read-only', ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])];
const env = { ...process.env, CODEX_HOME: home, AGENT_STATUSLINE_CONFIG: path.join(home, 'statusline.json'), TERM: 'xterm-256color' };
delete env.CODEX_THREAD_ID;
delete env.NO_COLOR;
const result = spawnSync(binary, args, { cwd, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
