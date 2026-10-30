#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { ROOT, readManifest, selectFeatures, checkRequirements, run } = require('./scripts/codex/common');
const VOICE_KEY = 'experimental_realtime_ws_backend_prompt';

function items(platform = process.platform, manifest = readManifest()) {
  return [
    { id: 'claude', label: 'Claude statusline', available: true, dependencies: [] },
    { id: 'broker', label: 'Agent broker', available: true, optional: true, dependencies: [] },
    { id: 'sync', label: 'Session sync (experimental)', available: true, optional: true, dependencies: [] },
    ...manifest.features.map(f => ({ id: f.id, label: `Codex: ${f.description.en}`, available: platform === 'win32', dependencies: f.dependencies })),
    { id: 'voice', label: 'Faster Codex voice (booxter)', available: platform === 'win32', dependencies: [] },
  ];
}

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (['--yes', '--list', '--help'].includes(flag) && inline === undefined) opts[flag.slice(2)] = true;
    else if (flag === '--only' || flag === '--skip') {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--') || value.split(',').some(id => !id)) throw new Error(`Expected comma-separated IDs after ${flag}`);
      if (opts[flag.slice(2)]) throw new Error(`Repeated option: ${flag}`);
      opts[flag.slice(2)] = value.split(',');
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return opts;
}

function resolveSelection(opts, platform = process.platform, manifest = readManifest()) {
  const choices = items(platform, manifest);
  for (const id of [...(opts.only || []), ...(opts.skip || [])]) {
    if (!choices.some(item => item.id === id)) throw new Error(`Unknown item: ${id}. Use --list.`);
  }
  const requested = (opts.only || choices.filter(item => item.available && !item.optional).map(item => item.id)).filter(id => !opts.skip?.includes(id));
  for (const id of requested) if (!choices.find(item => item.id === id).available) throw new Error(`${id}: TODO — Codex installation is currently Windows-only`);
  const features = selectFeatures(manifest, requested.filter(id => manifest.features.some(f => f.id === id)).join(',') || 'none');
  for (const feature of features) if (opts.skip?.includes(feature.id)) throw new Error(`${feature.id} is required by the selected features; remove it from --skip`);
  const selected = choices.filter(item => requested.includes(item.id) || features.some(f => f.id === item.id));
  return { selected, features, automatic: selected.filter(item => !requested.includes(item.id)).map(item => item.id) };
}

function choose(input = process.stdin, output = process.stdout) {
  const choices = items(), requested = new Set(['claude']);
  let cursor = 0, drawn = 0;
  return new Promise((resolve, reject) => {
    function draw() {
      if (drawn) { readline.moveCursor(output, 0, -drawn); readline.cursorTo(output, 0); readline.clearScreenDown(output); }
      const selection = resolveSelection({ only: [...requested] });
      const lines = ['agent-kit — arrows: move; Space: toggle; Enter: install; Ctrl+C: cancel', ...choices.map((item, index) => {
        const auto = selection.automatic.includes(item.id);
        const checked = selection.selected.some(s => s.id === item.id);
        return `${index === cursor ? '>' : ' '} [${checked ? 'x' : ' '}] ${item.id}${auto ? ' (required)' : ''}${item.dependencies.length ? ` (requires ${item.dependencies.join(',')})` : ''}: ${item.available ? item.label : 'TODO: Windows only'}`;
      })];
      output.write(lines.map(line => line.slice(0, Math.max(20, (output.columns || 100) - 1))).join('\n') + '\n');
      drawn = lines.length;
    }
    function finish(error) {
      input.off('keypress', keypress); input.setRawMode(false); input.pause(); output.write('\x1b[?25h');
      if (error) reject(error); else resolve({ only: [...requested] });
    }
    function keypress(text, key = {}) {
      try {
        if (key.ctrl && key.name === 'c' || key.name === 'escape') return finish(new Error('Installation cancelled'));
        if (key.name === 'return') return finish();
        if (key.name === 'up') cursor = (cursor + choices.length - 1) % choices.length;
        if (key.name === 'down') cursor = (cursor + 1) % choices.length;
        if (key.name === 'space' && choices[cursor].available) {
          const id = choices[cursor].id;
          if (requested.has(id)) requested.delete(id); else requested.add(id);
        }
        draw();
      } catch (error) { finish(error); }
    }
    readline.emitKeypressEvents(input); input.setRawMode(true); input.resume();
    input.on('keypress', keypress); output.write('\x1b[?25l'); draw();
  });
}

// Track TOML statement boundaries so keys inside strings/tables are never replaced.
function voiceSetting(text) {
  let quote = '', triple = false, depth = 0, start = 0, root = true, insertion = text.length, found;
  function statement(end) {
    const line = text.slice(start, end).trim();
    if (line.startsWith('[')) { if (root) insertion = start; root = false; }
    if (root && new RegExp(`^(?:${VOICE_KEY}|"${VOICE_KEY}"|'${VOICE_KEY}')\\s*=`).test(line)) {
      if (found) throw new Error(`Duplicate ${VOICE_KEY}; fix config.toml manually`);
      found = { start, end };
    }
    start = end;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\') { i++; continue; }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) { quote = ''; triple = false; i += 2; }
      else if (!triple && char === quote) quote = '';
      continue;
    }
    if (char === '#') { while (i < text.length && text[i] !== '\n') i++; if (!depth) statement(Math.min(i + 1, text.length)); continue; }
    if (char === '"' || char === "'") { quote = char; triple = text.slice(i, i + 3) === char.repeat(3); if (triple) i += 2; }
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') { if (--depth < 0) throw new Error('Unbalanced TOML; refusing to edit config.toml'); }
    else if (char === '\n' && !depth) statement(i + 1);
  }
  if (quote || depth) throw new Error('Unclosed TOML value; refusing to edit config.toml');
  if (start < text.length) statement(text.length);
  return { found, insertion };
}

async function configureVoice({ env = process.env, yes = false, confirm, log = console.log } = {}) {
  const home = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const file = path.join(home, 'config.toml');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { found, insertion } = voiceSetting(before);
  if (found && !yes && !confirm) throw new Error(`Existing ${VOICE_KEY}: use a TTY to confirm replacement, or --yes to skip it.`);
  if (found && (yes || !await confirm(`Replace existing ${VOICE_KEY}? [y/N] `))) {
    log(`Skipped voice: ${VOICE_KEY} already exists.`); return false;
  }
  const prompt = fs.readFileSync(path.join(ROOT, 'templates/codex-voice-prompt.md'), 'utf8').trim();
  const assignment = `${VOICE_KEY} = ${JSON.stringify(prompt)}\n`;
  const after = found ? before.slice(0, found.start) + assignment + before.slice(found.end)
    : before.slice(0, insertion) + (insertion && !before.slice(0, insertion).endsWith('\n') ? '\n' : '') + assignment + before.slice(insertion);
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== before) throw new Error('config.toml changed while awaiting confirmation; refusing to overwrite it');
  fs.mkdirSync(home, { recursive: true });
  if (fs.existsSync(file)) {
    const backup = `${file}.agent-kit-backup-${Date.now()}-${crypto.randomUUID()}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); log(`Config backup: ${backup}`);
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, after, { mode: 0o600 }); fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  log(`Faster voice configured: ${file}`); return true;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); }));
}

async function main(args = process.argv.slice(2), {
  env = process.env, platform = process.platform, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = console.log, exec = run, requirements = checkRequirements, chooseItems = choose, ask = confirm,
} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ is required: https://nodejs.org/');
  let opts = parseArgs(args);
  if (opts.help || opts.list) {
    log('node install.js [--yes] [--only claude,statusline,...,voice] [--skip id,...] [--list]');
    for (const item of items(platform)) log(`${item.id}: ${item.label}${item.dependencies.length ? ` (requires ${item.dependencies.join(',')})` : ''}${item.available ? '' : ' — TODO: Windows only'}`);
    return;
  }
  if (!opts.yes && !opts.only && !opts.skip) {
    if (!tty) throw new Error('No TTY: use --yes, --only id,..., --skip id,... or --list');
    opts = await chooseItems();
  }
  const selection = resolveSelection(opts, platform);
  if (selection.features.length) {
    try { requirements({ platform, env }); } catch (error) { throw new Error(`${error.message}\nInstall Rust manually: winget install Rustlang.Rustup\nThen rerun node install.js. No tools were installed automatically.`); }
  }
  log('Planned actions:');
  for (const item of selection.selected) log(`- ${item.id}: ${item.label}${selection.automatic.includes(item.id) ? ' (dependency added automatically)' : ''}`);
  if (platform !== 'win32') log('Codex native features and voice: TODO — Windows only.');
  if (!selection.selected.length) { log('Nothing selected.'); return; }
  const childOpts = { cwd: ROOT, env, stdio: 'inherit' };
  if (selection.selected.some(item => item.id === 'claude')) exec(process.execPath, [path.join(ROOT, 'statusline.js'), '--install'], childOpts);
  if (selection.features.length) {
    exec(process.execPath, [path.join(ROOT, 'scripts/codex/cli.js'), 'build', '--features', selection.features.map(f => f.id).join(',')], childOpts);
    exec(process.execPath, [path.join(ROOT, 'scripts/codex/cli.js'), 'install'], childOpts);
  }
  if (selection.selected.some(item => item.id === 'broker')) log(`Agent broker: node "${path.join(ROOT, 'scripts/agents/broker.js')}" --agent codex|kimi --name NAME --state DIR --prompt FILE`);
  if (selection.selected.some(item => item.id === 'sync')) require('./src/sync/install').configure({ env, log });
  if (selection.selected.some(item => item.id === 'voice')) await configureVoice({ env, yes: opts.yes, confirm: tty ? ask : undefined, log });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { items, parseArgs, resolveSelection, voiceSetting, configureVoice, main, choose };
