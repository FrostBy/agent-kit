'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readZip, extractZip } = require('./archive');
const { MANIFEST, fileHash, readManifest, locations, run, checkRequirements, under, removeBestEffort } = require('./common');

function cleanupWork(dirs, manifest) {
  const root = path.join(dirs.native, 'work');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = under(path.join(root, entry.name), root);
    if (target === dirs.work || !entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(`${manifest.version}-`)) continue;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(target, '.agent-statusline-source.json'), 'utf8'));
      if (marker.commit === manifest.commit && /^[a-f0-9]{12}$/.test(marker.featureHash)) removeBestEffort(target, root);
    } catch { /* Unrecognized work directories belong to the user. */ }
  }
}

async function prepare(opts = {}) {
  const manifest = readManifest(), dirs = locations(opts, process.env, manifest);
  fs.mkdirSync(path.dirname(dirs.archive), { recursive: true });
  if (!fs.existsSync(dirs.archive)) {
    const url = `https://codeload.github.com/openai/codex/zip/refs/tags/rust-v${manifest.version}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const temporary = dirs.archive + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
      if (fileHash(temporary) !== manifest.archiveSha256) throw new Error('Downloaded archive SHA-256 mismatch');
      fs.renameSync(temporary, dirs.archive);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  if (fileHash(dirs.archive) !== manifest.archiveSha256) throw new Error('Archive SHA-256 mismatch');
  const zip = readZip(dirs.archive);
  if (zip.comment.trim() !== manifest.commit) throw new Error('Archive commit mismatch');
  const marker = path.join(dirs.work, '.agent-statusline-source.json');
  if (fs.existsSync(dirs.work)) {
    under(dirs.work, path.join(dirs.native, 'work'));
    if (fs.lstatSync(dirs.work).isSymbolicLink()) throw new Error('Work directory must not be a symlink');
    if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).featureHash !== dirs.featureHash) throw new Error(`Unrecognized work directory; refusing to replace: ${dirs.work}`);
    // A previous build can have modified Cargo.lock; always extract clean sources.
    fs.rmSync(dirs.work, { recursive: true, force: true });
  }
  extractZip(zip, dirs.work);
  fs.writeFileSync(marker, JSON.stringify({ commit: manifest.commit, featureHash: dirs.featureHash }));
  cleanupWork(dirs, manifest);
  return { manifest, dirs };
}

function applyPatches(dirs, check = false) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dirs.work) };
  for (const feature of dirs.features) {
    const patch = path.resolve(path.dirname(MANIFEST), feature.file);
    run('git', ['-c', 'core.longpaths=true', 'apply', '--check', patch], { cwd: dirs.work, env });
    // --check is followed by application so dependent patches see their prerequisites.
    run('git', ['-c', 'core.longpaths=true', 'apply', patch], { cwd: dirs.work, env });
  }
  if (check) console.log(`Applicable: ${dirs.features.map(f => f.id).join(',') || 'none'}`);
}

async function build(opts) {
  checkRequirements();
  const { manifest, dirs } = await prepare(opts);
  applyPatches(dirs);
  const env = { ...process.env, CARGO_TARGET_DIR: dirs.target, STABLE_GIT_COMMIT: manifest.commit, CODEX_BUILD_COMMIT: manifest.commit };
  run('cargo', ['build', '-p', 'codex-cli', '--bin', 'codex', ...(opts.dev ? [] : ['--release'])], { cwd: path.join(dirs.work, 'codex-rs'), env, stdio: 'inherit' });
  fs.mkdirSync(path.join(dirs.native, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(dirs.native, 'metadata/build.json'), JSON.stringify({ version: manifest.version, commit: manifest.commit, features: dirs.features.map(f => f.id), featureHash: dirs.featureHash, binary: dirs.binary, sha256: fileHash(dirs.binary) }, null, 2));
  console.log(`Built ${dirs.binary}`);
}
module.exports = { prepare, applyPatches, build, cleanupWork };
