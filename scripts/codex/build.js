'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readZip, extractZip } = require('./archive');
const { MANIFEST, fileHash, readManifest, locations, run, checkRequirements, under, removeBestEffort } = require('./common');

function checkCargoHomePath({ platform = process.platform, env = process.env, home = os.homedir(), exec = run } = {}) {
  if (platform !== 'win32') return;
  const cargoHome = path.win32.resolve(env.CARGO_HOME || path.win32.join(home, '.cargo'));
  const checkout = path.win32.join(cargoHome, 'git/checkouts/rusty_v8-xxxxxxxxxxxxxxxx/xxxxxxx') + '\\';
  if (checkout.length + 170 <= 259) return;
  let enabled = false;
  try {
    enabled = /LongPathsEnabled\s+REG_DWORD\s+0x0*1\b/i.test(exec('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled']));
  } catch { /* A missing value does not enable long paths. */ }
  if (!enabled) throw new Error(`CARGO_HOME is too long for the rusty_v8 checkout with Windows long paths disabled: ${cargoHome}. Use a short CARGO_HOME; for example in PowerShell: New-Item -ItemType Junction -Path Z:\\cg -Target '${cargoHome.replaceAll("'", "''")}'; $env:CARGO_HOME = 'Z:\\cg'. Or enable long paths in administrator PowerShell: Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -Type DWord -Value 1. No settings or junctions were changed.`);
}

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
  checkCargoHomePath();
  checkRequirements();
  const { manifest, dirs } = await prepare(opts);
  applyPatches(dirs);
  const env = { ...process.env, CARGO_TARGET_DIR: dirs.target, STABLE_GIT_COMMIT: manifest.commit, CODEX_BUILD_COMMIT: manifest.commit };
  run('cargo', ['build', '-p', 'codex-cli', '--bin', 'codex', ...(opts.dev ? [] : ['--release'])], { cwd: path.join(dirs.work, 'codex-rs'), env, stdio: 'inherit' });
  fs.mkdirSync(path.join(dirs.native, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(dirs.native, 'metadata/build.json'), JSON.stringify({ version: manifest.version, commit: manifest.commit, features: dirs.features.map(f => f.id), featureHash: dirs.featureHash, binary: dirs.binary, sha256: fileHash(dirs.binary) }, null, 2));
  console.log(`Built ${dirs.binary}`);
}
module.exports = { prepare, applyPatches, build, cleanupWork, checkCargoHomePath };
