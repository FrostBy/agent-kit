#!/usr/bin/env node
'use strict';
const { hook } = require('../../src/sync');
const { configure } = require('../../src/sync/install');
async function main() {
  const [command, kind] = process.argv.slice(2);
  if (command === 'install' || command === 'uninstall') { configure({ remove: command === 'uninstall' }); return; }
  if (command !== 'hook' || !['claude', 'codex'].includes(kind)) throw Error('Usage: sync.js hook claude|codex | install | uninstall');
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const output = await hook(kind, JSON.parse(stdin));
  if (output) process.stdout.write(JSON.stringify(output) + '\n');
}
main().catch(error => { console.error(`session-sync: ${error.message}`); process.exitCode = 1; });
