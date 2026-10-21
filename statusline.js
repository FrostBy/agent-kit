#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { render } = require('./src/render');
const { WIDGETS, GROUPS } = require('./src/widgets');
const { detectLang, tr, makeT } = require('./src/i18n');
const { CLAUDE_DIR, readJson, writeJson, forwardSlashes } = require('./src/util');
const pkg = require('./package.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const HELP = `${pkg.name} ${pkg.version}

  (stdin)            render the status line from Claude Code JSON
  --preview          render with sample data in the current directory
  --configure        interactive editor (TUI)
  --list [--md]      list all widgets
  --init [--force]   write the default config to ${config.CONFIG_PATH}
  --install [--npx]  set statusLine + subagentStatusLine in ~/.claude/settings.json
  --uninstall        restore the previous statusLine
  --subagent         subagentStatusLine mode (stdin: tasks)
`;

const readStdin = () => { try { const raw = fs.readFileSync(0, 'utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; } };
// Pending git/fetch promises would keep Node alive; Claude Code waits for exit, so we leave explicitly.
const done = (text) => { process.stdout.write(text); process.exit(0); };

async function refreshWorker(kind) {
  if (kind === 'usage') await require('./src/sources/usage').refresh();
  else if (kind === 'today') {
    const { PRICES } = require('./src/pricing');
    await require('./src/sources/today').refresh(Date.now(), { ...PRICES, ...config.load().pricing });
  }
  else if (kind === 'git') {
    const { cwd, opts } = JSON.parse(args[args.indexOf(`--refresh=git`) + 1] || '{}');
    if (cwd) await require('./src/sources/git').refresh(cwd, { ...opts, budgetMs: 60_000 });
  }
}

function listWidgets(md, lang) {
  const out = [];
  for (const [g, title] of Object.entries(GROUPS)) {
    out.push(md ? `\n### ${tr(title, lang)}\n\n${makeT(lang)('listHeader')}\n|---|---|---|` : `\n${tr(title, lang)}`);
    for (const w of WIDGETS.filter((x) => x.group === g)) {
      const opts = Object.entries(w.opts || {}).map(([k, o]) => `${k}=${JSON.stringify(o.default)}`).join(', ');
      const desc = tr(w.desc, lang);
      out.push(md ? `| \`${w.id}\` | ${desc} | ${opts ? `\`${opts}\`` : ''} |` : `  ${w.id.padEnd(18)} ${desc}${opts ? `  [${opts}]` : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

// settings.json holds every other Claude Code setting: if it exists but does not parse, refuse rather than replace it.
function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const s = readJson(settingsPath);
  if (!s) throw new Error(`cannot parse ${settingsPath}, not touching it`);
  return s;
}

function install() {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const s = readSettings(settingsPath);
  const backup = path.join(CLAUDE_DIR, 'statusline.backup.json');
  if (!fs.existsSync(backup)) writeJson(backup, { statusLine: s.statusLine ?? null, subagentStatusLine: s.subagentStatusLine ?? null });
  // Claude Code runs the command through Git Bash on Windows, which eats backslashes in paths.
  const base = flag('--npx') ? `npx -y ${pkg.name}` : `node "${forwardSlashes(path.join(__dirname, 'statusline.js'))}"`;
  s.statusLine = { type: 'command', command: base, padding: 0, refreshInterval: 30 };
  s.subagentStatusLine = { type: 'command', command: `${base} --subagent` };
  writeJson(settingsPath, s);
  return `installed: ${base}\nbackup:    ${backup}\n`;
}

function uninstall() {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const backup = path.join(CLAUDE_DIR, 'statusline.backup.json');
  const b = readJson(backup);
  if (!b) return 'no backup found\n';
  const s = readSettings(settingsPath);
  for (const k of ['statusLine', 'subagentStatusLine']) { if (b[k]) s[k] = b[k]; else delete s[k]; }
  writeJson(settingsPath, s);
  fs.unlinkSync(backup);
  return 'restored previous statusLine\n';
}

async function main() {
  const refresh = value('--refresh');
  if (refresh) return refreshWorker(refresh).catch(() => {}).then(() => process.exit(0));
  if (flag('--help') || flag('-h')) return done(HELP);
  if (flag('--version') || flag('-v')) return done(`${pkg.version}\n`);
  if (flag('--list')) return done(listWidgets(flag('--md'), value('--lang') || detectLang(config.load())));
  if (flag('--install')) return done(install());
  if (flag('--uninstall')) return done(uninstall());
  if (flag('--init')) {
    if (fs.existsSync(config.CONFIG_PATH) && !flag('--force')) return done(`exists: ${config.CONFIG_PATH} (use --force)\n`);
    config.save(config.DEFAULTS);
    return done(`written: ${config.CONFIG_PATH}\n`);
  }
  if (flag('--configure') || args[0] === 'config') return require('./src/tui').run();

  const cfg = config.load();
  if (flag('--subagent')) return done(require('./src/subagent').renderSubagents(readStdin(), cfg).join('\n'));
  if (flag('--preview')) {
    const { sample, sampleSources } = require('./src/sample');
    const now = Date.now();
    return done((await render(sample(now, process.cwd()), cfg, now, sampleSources(now))).join('\n') + '\n');
  }
  const input = readStdin();
  require('./src/cache').writeRaw('last-input', input);
  const lines = await render(input, cfg);
  // A trailing empty line would be dropped; blank braille keeps the gap above Claude Code's mode line.
  if (cfg.gapAfter && lines.length) lines.push('\u2800');
  return done(lines.join('\n'));
}

main().catch((e) => done(`statusline: ${e.message}`));
