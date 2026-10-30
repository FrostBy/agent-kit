'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const slug = cwd => cwd.replace(/^[A-Z]:/, drive => drive.toLowerCase()).replace(/[^a-zA-Z0-9]/g, '-');

function projectPaths(text) {
  const projects = [];
  let quote = '', triple = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\') { i++; continue; }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) { quote = ''; triple = false; i += 2; }
      else if (!triple && char === quote) quote = '';
    } else if (char === '#') { while (i < text.length && text[i] !== '\n') i++; }
    else if (char === '[' && (i === 0 || /^\s*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i)))) {
      const header = text.slice(i).match(/^\[\s*projects\s*\.\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\s*\][ \t]*(?:#[^\n]*)?(?:\r?\n|$)/);
      if (header) {
        const key = header[1];
        projects.push(key.startsWith("'") ? key.slice(1, -1) : JSON.parse(key));
        i += header[0].length - 1;
      }
    } else if (char === '"' || char === "'") { quote = char; triple = text.slice(i, i + 3) === char.repeat(3); if (triple) i += 2; }
  }
  return projects;
}

async function activated(config) {
  const file = path.join(config.codexHome, 'config.toml');
  let stat;
  try { stat = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const cacheFile = path.join(config.stateDir, 'activation.json');
  let cached;
  try { cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const identity = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  let codex = cached?.identity === identity ? cached.codex : undefined;
  if (codex === undefined) {
    const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    codex = projectPaths(await fs.readFile(file, 'utf8')).some(p => norm(p) === norm(config.cwd));
    // No credential or project content is cached, just the TOML identity and registration result.
    await fs.mkdir(config.stateDir, { recursive: true });
    const temp = `${cacheFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify({ identity, codex }), { mode: 0o600 }); await fs.rename(temp, cacheFile); }
    finally { await fs.rm(temp, { force: true }); }
  }
  if (!codex) return false;
  // Check directory existence even with an unchanged TOML: Claude may have just visited this cwd.
  try { return (await fs.stat(path.join(config.claudeProjectsDir, slug(config.cwd)))).isDirectory(); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
module.exports = { slug, projectPaths, activated };
