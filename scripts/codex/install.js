'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const common = require('./common');
const { locations, fileHash, under, readManifest, removeBestEffort } = common;

function assertWindows(platform = process.platform) {
  if (platform !== 'win32') throw new Error('TODO: macOS/Linux native installation; Windows junctions are currently required.');
}
function activeTarget(base) {
  const current = path.join(base, 'current');
  if (!fs.lstatSync(current).isSymbolicLink()) throw new Error('Expected standalone/current junction');
  return under(fs.realpathSync(current), path.join(base, 'releases'));
}
function stateFile(base) { return path.join(base, 'agent-statusline-state.json'); }
function isStock(target, version = readManifest().version) {
  return /^\d+\.\d+\.\d+-(?:x86_64|aarch64|i686)-[a-z0-9_]+-[a-z0-9_-]+$/.test(path.basename(target))
    && path.basename(target).startsWith(`${version}-`)
    && fs.existsSync(path.join(target, 'bin/codex.exe'))
    && !fs.existsSync(path.join(target, 'codex-resources/agent-statusline'));
}
function findStock(base, active, version) {
  if (isStock(active)) return active;
  for (const name of fs.readdirSync(base).filter(name => name.startsWith('current.before-')).sort().reverse()) {
    const link = path.join(base, name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      const target = under(fs.realpathSync(link), path.join(base, 'releases'));
      if (isStock(target)) return target;
    } catch { /* Ignore broken or unrelated backup junctions. */ }
  }
  const fallback = path.join(base, `releases/${version}-x86_64-pc-windows-msvc`);
  if (isStock(fallback)) return fallback;
  throw stockReleaseError(version);
}
function stockReleaseError(version = readManifest().version) {
  return new Error(`Official stock Codex release not found for target version ${version}. The standalone package and voice host must come from this release. Install the official package in PowerShell: & ([scriptblock]::Create((irm https://chatgpt.com/codex/install.ps1))) -Release ${version}`);
}
function assertStockBuild(target) {
  const manifest = readManifest();
  try {
    const commit = common.run(path.join(target, 'codex-resources/voice/bin/codex-voice-host.exe'), ['--build-commit'], { timeout: 10000 });
    if (commit !== manifest.commit) throw new Error('voice host build commit differs from manifest');
  } catch (error) {
    throw new Error(`Stock voice host does not match the pinned build: ${error.message}. ${stockReleaseError().message}`);
  }
}
function readState(base, mode) {
  const state = JSON.parse(fs.readFileSync(stateFile(base), 'utf8'));
  under(state.stockTarget, path.join(base, 'releases'));
  under(state.customTarget, path.join(base, 'releases'));
  const version = path.basename(state.stockTarget).match(/^(\d+\.\d+\.\d+)-/)?.[1];
  if (mode === 'upgrade' && version && version !== readManifest().version) return state;
  const expectedVersion = mode === 'restore' ? version : undefined;
  if (!isStock(state.stockTarget, expectedVersion)) throw stockReleaseError(expectedVersion);
  if (mode !== 'restore') assertStockBuild(state.stockTarget);
  if (fileHash(path.join(state.stockTarget, 'bin/codex.exe')) !== state.stockSha256) throw new Error('Stock executable hash changed');
  return state;
}
function switchCurrent(base, target) {
  under(target, path.join(base, 'releases'));
  const id = crypto.randomUUID(), current = path.join(base, 'current');
  const next = path.join(base, `current.next-${id}`), backup = path.join(base, `current.before-${id}`);
  fs.symlinkSync(target, next, 'junction');
  try {
    fs.renameSync(current, backup);
    try { fs.renameSync(next, current); } catch (error) { fs.renameSync(backup, current); throw error; }
    if (activeTarget(base) !== fs.realpathSync(target)) {
      fs.unlinkSync(current); fs.renameSync(backup, current);
      throw new Error('Active junction verification failed');
    }
    return backup;
  } finally { if (fs.existsSync(next)) fs.unlinkSync(next); }
}
function copyVerified(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.copyFileSync(source, target); } catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || !fs.existsSync(target)) throw error;
    // Windows permits renaming an executing binary even when overwriting it fails.
    const retired = `${target}.retired-${crypto.randomUUID()}`;
    fs.renameSync(target, retired);
    try { fs.copyFileSync(source, target); } catch (copyError) { fs.renameSync(retired, target); throw copyError; }
  }
  if (fileHash(source) !== fileHash(target)) throw new Error(`Copy hash mismatch: ${target}`);
}
function copyFooter(source, target) {
  for (const name of ['statusline.js', 'package.json', 'LICENSE', 'src']) {
    const from = path.join(source, name), to = path.join(target, name);
    if (fs.lstatSync(from).isSymbolicLink()) throw new Error('Footer symlinks are not supported');
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else copyVerified(from, to);
  }
}
function copyTree(source, target) {
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, item.name), to = path.join(target, item.name);
    if (item.isSymbolicLink()) throw new Error('Footer symlinks are not supported');
    if (item.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copyTree(from, to); }
    else copyVerified(from, to);
  }
}

function replaceFooter(source, target) {
  const root = path.dirname(target);
  const next = `${target}.next-${crypto.randomUUID()}`, backup = `${target}.before-${crypto.randomUUID()}`;
  try {
    copyFooter(source, next);
    if (!fs.existsSync(target)) { fs.renameSync(next, target); return; }
    fs.renameSync(target, backup);
    try { fs.renameSync(next, target); } catch (error) { fs.renameSync(backup, target); throw error; }
    removeBestEffort(backup, root);
  } finally { removeBestEffort(next, root); }
}
function cleanupInstall(base, custom, latestBackup) {
  for (const [root, matches] of [
    [path.join(custom, 'bin'), name => name.startsWith('codex.exe.retired-')],
    [path.join(custom, 'codex-resources'), name => /^agent-statusline\.(next|before)-/.test(name)],
    [base, name => /^current\.(next|before)-/.test(name)],
  ]) {
    for (const name of fs.readdirSync(root)) if (matches(name)) removeBestEffort(path.join(root, name), root);
  }
  const backups = path.join(base, 'statusline-backups');
  if (!fs.existsSync(backups)) return;
  const entries = fs.readdirSync(backups, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink())
    .map(e => path.join(backups, e.name));
  entries.sort((a, b) => a === latestBackup ? -1 : b === latestBackup ? 1 : fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const target of entries.slice(3)) removeBestEffort(target, backups);
}

function install(opts = {}) {
  assertWindows();
  const dirs = locations(opts), base = dirs.standalone, active = activeTarget(base), manifest = readManifest();
  const previous = fs.existsSync(stateFile(base)) ? readState(base, 'upgrade') : null;
  const upgrade = previous && !path.basename(previous.stockTarget).startsWith(`${manifest.version}-`);
  const stock = previous && !upgrade ? previous.stockTarget : findStock(base, active, manifest.version);
  if (previous && active !== previous.customTarget && active !== previous.stockTarget && !(upgrade && active === stock)) throw new Error('Active runtime changed; refusing installation');
  assertStockBuild(stock);
  const stockSha256 = fileHash(path.join(stock, 'bin/codex.exe'));
  if (!opts.binary && !process.env.CODEX_NATIVE_BINARY) {
    const build = JSON.parse(fs.readFileSync(path.join(dirs.native, 'metadata/build.json'), 'utf8'));
    if (build.version !== manifest.version || build.commit !== manifest.commit) throw new Error('Build metadata does not match the pinned source; rebuild Codex');
    const expected = locations({ ...opts, features: build.features.length ? build.features.join(',') : 'none' });
    if (build.featureHash !== expected.featureHash) throw new Error('Patches changed after the last build; rebuild Codex');
    if (build.sha256 !== fileHash(build.binary)) throw new Error('Built executable hash changed');
    dirs.binary = build.binary;
  }
  const binaryHash = fileHash(dirs.binary);
  const id = crypto.randomUUID();
  const custom = under(previous && !upgrade ? previous.customTarget : path.join(base, `releases/${manifest.version}-agent-kit`), path.join(base, 'releases'));
  if ((!previous || upgrade) && fs.existsSync(custom)) throw new Error(`Custom destination already exists without state: ${custom}`);
  const backup = under(path.join(base, `statusline-backups/${id}`), base);
  fs.mkdirSync(backup, { recursive: true });
  if (previous) fs.copyFileSync(stateFile(base), path.join(backup, 'previous-state.json'));
  if (!previous || upgrade) fs.cpSync(stock, custom, { recursive: true, dereference: true });
  copyVerified(dirs.binary, path.join(custom, 'bin/codex.exe'));
  if (fileHash(path.join(custom, 'bin/codex.exe')) !== binaryHash) throw new Error('Built executable changed during installation');
  replaceFooter(dirs.footer, path.join(custom, 'codex-resources/agent-statusline'));
  if (fileHash(path.join(stock, 'bin/codex.exe')) !== stockSha256) throw new Error('Stock executable changed during installation');
  const state = { stockTarget: stock, stockSha256, customTarget: custom, customSha256: binaryHash, backup };
  const pending = path.join(base, `state.next-${id}.json`);
  fs.writeFileSync(pending, JSON.stringify(state, null, 2));
  fs.copyFileSync(pending, path.join(backup, 'state.json'));
  if (active !== custom) switchCurrent(base, custom);
  try { fs.renameSync(pending, stateFile(base)); } catch (error) { switchCurrent(base, active); throw error; }
  cleanupInstall(base, custom, backup);
  console.log(`Installed: ${custom}\nRollback state: ${backup}`);
  if (upgrade) console.log(`Previous custom release retained: ${previous.customTarget}\nYou may delete it manually after checking the new installation and closing old processes.`);
  if (!previous && active !== stock) console.log(`Previous custom release retained: ${active}\nYou may delete it manually after checking the new installation and closing old processes.`);
  return state;
}
function restore(opts = {}) {
  assertWindows();
  const { standalone: base } = locations(opts), state = readState(base, 'restore'), active = activeTarget(base);
  if (active === state.stockTarget) return state;
  if (active !== state.customTarget) throw new Error('Active runtime changed; refusing restore');
  switchCurrent(base, state.stockTarget);
  cleanupInstall(base, state.customTarget);
  console.log(`Restored: ${state.stockTarget}`);
  return state;
}
function syncFooter(opts = {}) {
  assertWindows();
  const dirs = locations(opts), state = readState(dirs.standalone);
  if (activeTarget(dirs.standalone) !== state.customTarget) throw new Error('Custom runtime is not active');
  if (fileHash(path.join(state.customTarget, 'bin/codex.exe')) !== state.customSha256) throw new Error('Custom executable hash changed');
  const target = under(path.join(state.customTarget, 'codex-resources/agent-statusline'), state.customTarget);
  replaceFooter(dirs.footer, target);
  cleanupInstall(dirs.standalone, state.customTarget);
  console.log(`Footer synchronized: ${target}`);
}
module.exports = { assertWindows, activeTarget, switchCurrent, copyVerified, install, restore, syncFooter };
