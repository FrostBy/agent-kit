'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function syncThreads({ env = process.env, claudeConfigDirs = [] } = {}) {
  const homes = [env.HOME, env.USERPROFILE].filter(Boolean);
  if (!homes.length) homes.push(os.homedir());
  const profiles = [...new Set([...homes.map(home => path.join(home, '.claude')), env.CLAUDE_CONFIG_DIR, ...claudeConfigDirs].filter(Boolean).map(dir => path.resolve(dir)))];
  const ids = new Set();
  const valid = id => typeof id === 'string' && /^[\w-]+$/.test(id);
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw Error(`Cannot verify sync registry ${file}: ${error.message}`); } };
  for (const profile of profiles) {
    const root = path.join(profile, 'agent-kit', 'sync');
    let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const dir of dirs) {
      if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
      const folder = path.join(root, dir.name), file = path.join(folder, 'pairs.json');
      if (!fs.statSync(folder).isDirectory()) continue;
      // Retained/staged checkpoints can outlive their index entry; they still prove sync ownership.
      for (const name of fs.readdirSync(folder)) if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
        const pair = read(path.join(folder, name));
        if (pair.codex?.managed === 'app-server' && pair.codex.mirror === true) {
          if (!valid(pair.codex.id)) throw Error(`Invalid managed sync checkpoint ${name}`);
          ids.add(pair.codex.id);
        }
      }
      try { fs.accessSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const registry = read(file);
      if (![2, 3].includes(registry.version) || !Array.isArray(registry.pairs)) throw Error(`Invalid sync registry ${file}; archive refused`);
      for (const entry of registry.pairs) {
        const id = typeof entry.codex === 'string' ? entry.codex : entry.codex?.id;
        if (!valid(id)) throw Error(`Invalid sync thread ID in ${file}; archive refused`);
        ids.add(id); // Protect original Codex sides as well as mirrors, regardless of originator.
        if (registry.version === 3) {
          if (!valid(entry.id)) throw Error(`Invalid sync pair ID in ${file}`);
          const pair = read(path.join(folder, `${entry.id}.json`));
          if (pair.id !== entry.id || !valid(pair.codex?.id)) throw Error(`Invalid sync pair checkpoint in ${file}`);
          // A crash can leave the checkpoint's server-assigned ID ahead of the small registry.
          ids.add(pair.codex.id);
        }
      }
    }
  }
  return ids;
}
module.exports = { syncThreads };
