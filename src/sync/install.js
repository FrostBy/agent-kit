'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { configuration, hookConfigs } = require('./index');
const BEGIN = '# BEGIN AGENT-KIT SESSION-SYNC';
const END = '# END AGENT-KIT SESSION-SYNC';

function tomlBlock(text, block) {
  const begins = [...text.matchAll(/^# BEGIN AGENT-KIT SESSION-SYNC\r?$/gm)];
  const ends = [...text.matchAll(/^# END AGENT-KIT SESSION-SYNC\r?$/gm)];
  // Refuse ambiguous ownership or markers hidden inside multiline TOML values.
  if (begins.length !== ends.length || begins.length > 1 || (begins.length && ends[0].index < begins[0].index)) throw Error('Ambiguous sync TOML markers');
  const { voiceSetting } = require('../../install');
  voiceSetting(text);
  if (begins.length) {
    const start = begins[0].index, end = ends[0].index + ends[0][0].length;
    let quote = '', triple = false;
    for (let i = 0; i < start; i++) {
      const char = text[i];
      if (quote) {
        if (quote === '"' && char === '\\') { i++; continue; }
        if (triple && text.slice(i, i + 3) === quote.repeat(3)) { quote = ''; triple = false; i += 2; }
        else if (!triple && char === quote) quote = '';
      } else if (char === '#') { while (i < start && text[i] !== '\n') i++; }
      else if (char === '"' || char === "'") { quote = char; triple = text.slice(i, i + 3) === char.repeat(3); if (triple) i += 2; }
    }
    if (quote) throw Error('Sync markers inside TOML string');
    return text.slice(0, start) + block + text.slice(end + (text[end] === '\n' ? 1 : 0));
  }
  return block ? text + (text && !text.endsWith('\n') ? '\n' : '') + block : text;
}

function configure({ env = process.env, remove = false, log = console.log } = {}) {
  const config = configuration(process.cwd(), env);
  const resolve = file => { try { return fs.realpathSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return file; } };
  const settingsFile = resolve(path.join(config.claudeHome, 'settings.json')), tomlFile = resolve(path.join(config.codexHome, 'config.toml'));
  const script = path.resolve(__dirname, '../../scripts/agents/sync.js');
  const generated = hookConfigs(script);
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const beforeSettings = read(settingsFile), beforeToml = read(tomlFile);
  const settings = JSON.parse(beforeSettings || '{}');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.hooks && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))) throw Error('Invalid Claude settings/hooks');
  const commands = new Set(Object.values(generated.claude.hooks).map(groups => groups[0].hooks[0].command));
  // Match only our command; unrelated hooks and edits made after installation survive removal.
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) throw Error('Invalid Claude hook group');
    settings.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(h => !commands.has(h.command)) })).filter(group => group.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!remove) {
    settings.hooks ||= {};
    for (const [event, entries] of Object.entries(generated.claude.hooks)) (settings.hooks[event] ||= []).push(...entries);
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  const afterSettings = remove && !beforeSettings ? '' : JSON.stringify(settings, null, 2) + '\n';
  const afterToml = tomlBlock(beforeToml, remove ? '' : `${BEGIN}\n${generated.codex}${END}\n`);
  // Validate both edits before writing either file, and roll back an interrupted second write.
  const changes = [[settingsFile, beforeSettings, afterSettings], [tomlFile, beforeToml, afterToml]].filter(([, a, b]) => a !== b);
  const written = [];
  function replace(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  try {
    for (const [file, before, after] of changes) {
      if (read(file) !== before) throw Error('Configuration changed concurrently');
      const existed = fs.existsSync(file);
      if (existed) fs.copyFileSync(file, `${file}.agent-kit-sync-backup-${Date.now()}-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
      replace(file, after); written.push({ file, before, existed });
    }
  } catch (error) {
    for (const { file, before, existed } of written.reverse()) { if (existed) replace(file, before); else fs.unlinkSync(file); }
    throw error;
  }
  log(`Session sync ${remove ? 'removed' : 'installed'} (${changes.length} files changed). Transcripts and archives retained.`);
  return changes.length;
}
module.exports = { configure, tomlBlock };
