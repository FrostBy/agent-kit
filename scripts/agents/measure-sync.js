#!/usr/bin/env node
'use strict';
// Manual diagnostic only. Copies transcript files from a legacy registry; never installs hooks or authenticates.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { slug } = require('../../src/sync/activation');
const { configuration, hook } = require('../../src/sync');

async function main() {
  const [registryFile, requestedId] = process.argv.slice(2);
  if (!registryFile) throw Error('Usage: node scripts/agents/measure-sync.js <legacy-pairs.json> [pair-id]');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const legacy = requestedId ? registry.pairs.find(p => p.id === requestedId) : registry.pairs[0];
  if (!legacy || !Array.isArray(legacy.events)) throw Error('Expected a legacy v2 pair with events');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-kit-sync-measure-'));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
    delete env.SESSION_SYNC_BROKER; delete env.SESSION_SYNC_EXCLUDE;
    const config = configuration(legacy.claude.cwd, env);
    await fs.mkdir(config.stateDir, { recursive: true });
    await fs.mkdir(path.join(config.claudeProjectsDir, slug(config.cwd)), { recursive: true });
    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.writeFile(path.join(config.codexHome, 'config.toml'), `[projects.${JSON.stringify(config.cwd)}]\ntrust_level = "trusted"\n`);
    const pair = { id: legacy.id, known: legacy.events.map(e => e.key), archiveSize: 0 };
    const refs = [], lines = [];
    for (const event of legacy.events) {
      const text = JSON.stringify(event) + '\n', length = Buffer.byteLength(text);
      refs.push({ key: event.key, offset: pair.archiveSize, length });
      lines.push(text); pair.archiveSize += length;
    }
    const sizes = {};
    for (const kind of ['claude', 'codex']) {
      const old = legacy[kind];
      const file = path.join(kind === 'claude' ? config.claudeProjectsDir : config.codexSessionsDir, 'copies', path.basename(old.file));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(old.file, file); sizes[kind] = (await fs.stat(file)).size;
      const delivered = new Set(old.delivered || []);
      pair[kind] = { id: old.id, cwd: config.cwd, file, mirror: old.mirror, seeded: true, eligible: true,
        pending: refs.filter((ref, index) => legacy.events[index].origin !== kind && !delivered.has(ref.key)) };
    }
    await fs.writeFile(path.join(config.stateDir, `${pair.id}.events`), lines.join(''));
    await fs.writeFile(path.join(config.stateDir, `${pair.id}.json`), JSON.stringify(pair));
    await fs.writeFile(path.join(config.stateDir, 'pairs.json'), JSON.stringify({ version: 3, pairs: [{ id: pair.id, claude: pair.claude.id, codex: pair.codex.id }] }));
    const input = { cwd: config.cwd, session_id: pair.claude.id, transcript_path: pair.claude.file, hook_event_name: 'UserPromptSubmit' };
    // Eligibility is prevalidated for this offline copy; no live CLI is attached to the diagnostic.
    const cold = performance.now(); await hook('claude', input, config, { env, interactive: async () => true }); const coldMs = performance.now() - cold;
    const cli = path.resolve(__dirname, 'sync.js');
    const warm = [];
    for (let n = 0; n < 5; n++) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [cli, 'hook', 'claude'], { env, input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
      if (result.status !== 0) throw Error(result.stderr || String(result.error));
      warm.push(performance.now() - start);
    }
    const stat = await fs.stat(path.join(config.stateDir, `${pair.id}.json`));
    console.log(JSON.stringify({ transcriptMiB: Object.fromEntries(Object.entries(sizes).map(([k, bytes]) => [k, +(bytes / 1024 / 1024).toFixed(2)])),
      events: legacy.events.length, initialRebuildMs: +coldMs.toFixed(1), warmCliMs: warm.map(ms => +ms.toFixed(1)),
      maxWarmMs: +Math.max(...warm).toFixed(1), checkpointKiB: +(stat.size / 1024).toFixed(1),
      eligibility: 'cached for offline copies; CLI startup included; first CIM/ps probe excluded' }, null, 2));
  } finally {
    // root is returned directly by mkdtemp; it never contains an input-derived path.
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
