'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = path.join(ROOT, 'patches/codex-0.164.0/manifest.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));

function readManifest(file = MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) || !Array.isArray(manifest.features)) throw new Error('Invalid manifest');
  const ids = new Set();
  for (const feature of manifest.features) {
    if (!/^[a-z][a-z0-9-]*$/.test(feature.id) || ids.has(feature.id) || !/^[a-z0-9-]+\.patch$/.test(feature.file) || !Array.isArray(feature.dependencies) || !feature.description?.en || !feature.description?.ru || !feature.attribution) throw new Error('Invalid manifest feature');
    ids.add(feature.id);
  }
  selectFeatures(manifest);
  return manifest;
}

function selectFeatures(manifest, selected) {
  const requested = selected === undefined ? manifest.features.map(f => f.id) : selected === 'none' ? [] : selected.split(',');
  const wanted = new Set(), visiting = new Set();
  function visit(id) {
    const feature = manifest.features.find(f => f.id === id);
    if (!feature) throw new Error(`Unknown feature: ${id}`);
    if (visiting.has(id)) throw new Error(`Cyclic dependency: ${id}`);
    if (wanted.has(id)) return;
    visiting.add(id);
    for (const dep of feature.dependencies) visit(dep);
    visiting.delete(id); wanted.add(id);
  }
  requested.forEach(visit);
  const result = manifest.features.filter(f => wanted.has(f.id));
  const seen = new Set();
  for (const f of result) {
    if (f.dependencies.some(dep => !seen.has(dep))) throw new Error(`Manifest order must put dependencies before ${f.id}`);
    seen.add(f.id);
  }
  return result;
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--dev') result.dev = true;
    else if (['--features', '--native-dir', '--codex-home', '--standalone', '--binary', '--footer-root'].includes(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${key}`);
      result[key.slice(2)] = args[++i];
    } else throw new Error(`Unknown option: ${key}`);
  }
  return result;
}

function locations(opts = {}, env = process.env, manifest = readManifest()) {
  const features = selectFeatures(manifest, opts.features);
  const native = path.resolve(opts['native-dir'] || env.CODEX_NATIVE_DIR || path.join(ROOT, '.native'));
  const home = path.resolve(opts['codex-home'] || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const standalone = path.resolve(opts.standalone || env.CODEX_STANDALONE_DIR || path.join(home, 'packages/standalone'));
  const featureHash = hash(JSON.stringify({ manifest, features: features.map(f => f.id), patches: features.map(f => fileHash(path.join(path.dirname(MANIFEST), f.file))) })).slice(0, 12);
  const profile = opts.dev ? 'debug' : 'release';
  return { native, home, standalone, features, featureHash, profile,
    archive: path.join(native, `downloads/codex-${manifest.version}.zip`),
    work: path.join(native, `work/${manifest.version}-${featureHash}`),
    target: path.join(native, 'target'),
    binary: path.resolve(opts.binary || env.CODEX_NATIVE_BINARY || path.join(native, `target/${profile}/codex.exe`)),
    footer: path.resolve(opts['footer-root'] || env.CODEX_FOOTER_ROOT || ROOT) };
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { windowsHide: true, ...opts });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.toString() || result.status}`);
  return result.stdout?.toString().trim();
}

function checkRequirements({ platform = process.platform, env = process.env, exec = run, exists = fs.existsSync, warn = console.warn } = {}) {
  if (platform !== 'win32') throw new Error('TODO: native Codex build/install support for macOS/Linux; Windows MSVC is currently required.');
  exec('git', ['--version']);
  try { exec('cargo', ['--version']); } catch (error) { throw new Error(`cargo is required: install rustup from https://rustup.rs/ or add cargo to PATH. ${error.message}`); }
  try { exec('rustup', ['--version']); } catch { warn('rustup unavailable: using cargo from PATH; ensure Rust 1.99.1 is available.'); }
  let msvc = false;
  try { exec('where.exe', ['cl.exe']); exec('where.exe', ['link.exe']); msvc = true; } catch { /* Try the normal VS installation. */ }
  if (!msvc) {
    const vswhere = path.join(env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    if (exists(vswhere)) msvc = Boolean(exec(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']));
  }
  if (!msvc) throw new Error('MSVC C++ Build Tools missing. Run: winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"');
}

function under(value, root) {
  const full = path.resolve(value), relative = path.relative(path.resolve(root), full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path outside expected root: ${full}`);
  return full;
}
function removeBestEffort(value, root) {
  const target = under(value, root);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch { /* Locked leftovers can be removed on a later run. */ }
}
module.exports = { ROOT, MANIFEST, hash, fileHash, readManifest, selectFeatures, options, locations, run, checkRequirements, under, removeBestEffort };
