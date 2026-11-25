#!/usr/bin/env node
'use strict';
const { hook } = require('../../src/sync');
const { configure } = require('../../src/sync/install');
async function main() {
  const [command, kind, identity] = process.argv.slice(2);
  if (command === 'install' || command === 'uninstall') { configure({ remove: command === 'uninstall', wsl: kind === '--wsl' }); return; }
  if (command !== 'hook' || !['claude', 'codex'].includes(kind)) throw Error('Usage: sync.js hook claude|codex | install [--wsl] | uninstall');
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  // Only the WSL launcher can inspect the Linux Claude parent process.
  const options = kind === 'claude' && process.platform === 'win32' && /^wsl:\d+:\d+$/.test(identity)
    ? { cliIdentity: identity, interactive: async () => true } : undefined;
  const output = await hook(kind, JSON.parse(stdin), undefined, options);
  if (output) process.stdout.write(JSON.stringify(output) + '\n');
}
main().catch(error => { console.error(`session-sync: ${error.message}`); process.exitCode = 1; });
