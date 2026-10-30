'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { syncThreads } = require('../src/agents/sync-protection');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kit-protection-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'current') };
  const registry = (profile, id, version = 3, checkpointId = id) => {
    const dir = path.join(profile, 'agent-kit', 'sync', 'project'); fs.mkdirSync(dir, { recursive: true }); const pair = randomUUID();
    fs.writeFileSync(path.join(dir, 'pairs.json'), JSON.stringify({ version, pairs: version === 2 ? [{ id: pair, codex: { id } }] : [{ id: pair, codex: id }] }));
    if (version === 3) fs.writeFileSync(path.join(dir, pair + '.json'), JSON.stringify({ id: pair, codex: { id: checkpointId, mirror: true, managed: 'app-server' } }));
    return dir;
  };
  return { root, env, registry };
}

test('protects all known Claude profiles, legacy pairs, staged IDs and retained managed checkpoints', t => {
  const f = fixture(t), extra = path.join(f.root, 'extra');
  f.registry(path.join(f.root, '.claude'), 'default', 2);
  f.registry(f.env.CLAUDE_CONFIG_DIR, 'old-index-id', 3, 'new-server-id');
  const dir = f.registry(extra, 'extra');
  fs.writeFileSync(path.join(dir, randomUUID() + '.json'), JSON.stringify({ codex: { id: 'orphan-managed', mirror: true, managed: 'app-server' } }));
  assert.deepEqual([...syncThreads({ env: f.env, claudeConfigDirs: [extra, extra] })].sort(), ['default', 'extra', 'new-server-id', 'old-index-id', 'orphan-managed']);
});

test('corrupt/incomplete registries fail closed instead of allowing archive', t => {
  const f = fixture(t), dir = f.registry(f.env.CLAUDE_CONFIG_DIR, 'mirror');
  fs.writeFileSync(path.join(dir, 'pairs.json'), '{'); assert.throws(() => syncThreads({ env: f.env }), /Cannot verify/);
  fs.writeFileSync(path.join(dir, 'pairs.json'), JSON.stringify({ version: 3, pairs: [{ id: 'missing', codex: 'mirror' }] }));
  assert.throws(() => syncThreads({ env: f.env }), /Cannot verify/);
});
