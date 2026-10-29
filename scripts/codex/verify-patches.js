'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { readZip, extractZip } = require('./archive');
const { ROOT, MANIFEST, readManifest, selectFeatures, locations, fileHash, run, under } = require('./common');
const { applyPatches } = require('./build');

// Explicitly opt in: this extracts sources and runs git apply, never a Rust build.
function verify() {
  const manifest = readManifest(), dirs = locations();
  assert.equal(fileHash(dirs.archive), manifest.archiveSha256);
  const zip = readZip(dirs.archive);
  assert.equal(zip.comment, manifest.commit);
  const folder = path.join(dirs.native, 'work');
  fs.mkdirSync(folder, { recursive: true });
  const work = fs.mkdtempSync(path.join(folder, 'verify-'));
  const originals = new Map(zip.entries.filter(e => !e.name.endsWith('/')).map(e => [e.name.split('/').slice(1).join('/'), e]));
  const patches = manifest.features.map(f => fs.readFileSync(path.join(path.dirname(MANIFEST), f.file), 'utf8'));
  const files = [...new Set(patches.flatMap(p => [...p.matchAll(/^diff --git a\/(.*?) b\//gm)].map(m => m[1])))];
  const reset = () => {
    for (const file of files) {
      const target = under(path.join(work, file), work);
      if (originals.has(file)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, originals.get(file).content()); }
      else fs.rmSync(target, { force: true });
    }
  };
  try {
    extractZip(zip, work);
    let count = 0;
    for (let mask = 0; mask < 1 << manifest.features.length; mask++) {
      const chosen = manifest.features.filter((_, i) => mask & (1 << i));
      if (chosen.some(f => f.dependencies.some(dep => !chosen.some(c => c.id === dep)))) continue;
      reset();
      applyPatches({ work, features: selectFeatures(manifest, chosen.length ? chosen.map(f => f.id).join(',') : 'none') });
      count++;
    }
    reset();
    applyPatches({ work, features: manifest.features });
    // Compare every archive file, plus newly added files, with the pre-split tree.
    const expectedHashes = Object.fromEntries([...new Set([...originals.keys(), ...files])].map(file => [file, fileHash(path.join(work, file))]));
    const baseline = path.join(ROOT, 'patches/codex-0.164.0/tree-sha256.json');
    if (process.argv.includes('--record-baseline')) {
      const combined = process.argv[process.argv.indexOf('--record-baseline') + 1];
      if (!combined) throw new Error('Expected old combined patch path');
      reset();
      const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(work) };
      run('git', ['-c', 'core.longpaths=true', 'apply', '--check', path.resolve(combined)], { cwd: work, env });
      run('git', ['-c', 'core.longpaths=true', 'apply', path.resolve(combined)], { cwd: work, env });
      for (const [file, hash] of Object.entries(expectedHashes)) assert.equal(fileHash(path.join(work, file)), hash, file);
      // Persist only affected files; all other archive entries were also checked above.
      fs.writeFileSync(baseline, JSON.stringify(Object.fromEntries(files.sort().map(file => [file, expectedHashes[file]])), null, 2) + '\n');
    } else {
      for (const [file, hash] of Object.entries(JSON.parse(fs.readFileSync(baseline, 'utf8')))) assert.equal(expectedHashes[file], hash, file);
    }
    console.log(`${count} valid feature combinations: git apply --check + apply passed; full tree equals combined-patch baseline (${Object.keys(expectedHashes).length} files).`);
  } finally { under(work, folder); fs.rmSync(work, { recursive: true, force: true }); }
}
if (require.main === module) { try { verify(); } catch (error) { console.error(error); process.exitCode = 1; } }
module.exports = { verify };
