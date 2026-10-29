'use strict';
const { options } = require('./common');
const { prepare, build } = require('./build');
const { install, restore, syncFooter } = require('./install');

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ is required');
  const [command, ...args] = process.argv.slice(2), opts = options(args);
  if (command === 'prepare') console.log(`Clean sources: ${(await prepare(opts)).dirs.work}`);
  else if (command === 'build') await build(opts);
  else if (command === 'install') install(opts);
  else if (command === 'restore') restore(opts);
  else if (command === 'sync-footer') syncFooter(opts);
  else throw new Error('Expected prepare, build, install, restore or sync-footer');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
