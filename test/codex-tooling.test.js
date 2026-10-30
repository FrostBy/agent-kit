'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readManifest, selectFeatures, locations, options, checkRequirements, under, removeBestEffort } = require('../scripts/codex/common');
const { assertWindows, install, restore, syncFooter, activeTarget, switchCurrent, copyVerified } = require('../scripts/codex/install');
const { cleanupWork, checkCargoHomePath } = require('../scripts/codex/build');
const manifest = readManifest();
const common = require('../scripts/codex/common');

test('manifest selection follows manifest order and includes dependencies', () => {
  assert.deepEqual(selectFeatures(manifest, 'interaction-modes,full-diff,full-diff').map(f => f.id), ['statusline', 'full-diff', 'interaction-modes']);
  assert.equal(selectFeatures(manifest).length, 6);
  assert.deepEqual(selectFeatures(manifest, 'none'), []);
  assert.throws(() => selectFeatures(manifest, 'typo'), /Unknown feature/);
  const cyclic = { features: [{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['a'] }] };
  assert.throws(() => selectFeatures(cyclic), /Cyclic/);
  assert.throws(() => selectFeatures({ features: [{ id: 'a', dependencies: ['missing'] }] }), /Unknown/);
  assert.throws(() => selectFeatures({ features: [...manifest.features].reverse() }), /order/);
});

test('manifest rejects unsafe patch filenames and duplicate IDs', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manifest-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'manifest.json');
  for (const mutate of [m => { m.features[0].file = '../evil.patch'; }, m => { m.features.push(m.features[0]); }, m => { m.commit = 'dev'; }]) {
    const copy = structuredClone(manifest); mutate(copy);
    fs.writeFileSync(file, JSON.stringify(copy));
    assert.throws(() => readManifest(file), /Invalid/);
  }
});

test('paths respect explicit options, CODEX_HOME and selected content', () => {
  const env = { CODEX_HOME: path.resolve('fake-home'), CODEX_NATIVE_DIR: path.resolve('fake-native') };
  const a = locations({ features: 'statusline' }, env);
  assert.equal(a.standalone, path.join(env.CODEX_HOME, 'packages/standalone'));
  assert.equal(a.binary, path.join(env.CODEX_NATIVE_DIR, 'target/release/codex.exe'));
  assert.equal(locations({ dev: true }, env).profile, 'debug');
  assert.notEqual(a.work, locations({ features: 'full-diff' }, env).work);
  assert.equal(a.work, locations({ features: 'statusline,statusline' }, env).work);
  assert.equal(locations({ standalone: 'override' }, env).standalone, path.resolve('override'));
  assert.throws(() => under(path.resolve('outside'), path.resolve('inside')), /outside/);
  assert.deepEqual(options(['--dev', '--features', 'statusline']), { dev: true, features: 'statusline' });
  assert.throws(() => options(['--features']), /Missing/);
  assert.throws(() => options(['--typo']), /Unknown/);
});

test('requirements support rustup, cargo fallback, MSVC discovery and clear failures', () => {
  const calls = [], warnings = [];
  const exec = (command, args) => { calls.push([command, args]); return 'available'; };
  checkRequirements({ platform: 'win32', exec });
  assert(calls.some(([c]) => c === 'cargo'));
  checkRequirements({ platform: 'win32', exec: (c, a) => { if (c === 'rustup' || c === 'where.exe') throw Error('missing'); return exec(c, a); }, exists: () => true, warn: w => warnings.push(w) });
  assert.match(warnings[0], /cargo from PATH/);
  assert(calls.some(([c]) => c.endsWith('vswhere.exe')));
  assert.throws(() => checkRequirements({ platform: 'win32', exec: c => { if (c === 'where.exe') throw Error('missing'); return 'ok'; }, exists: () => false }), /winget install/);
  assert.throws(() => checkRequirements({ platform: 'win32', exec: c => { if (c === 'cargo') throw Error('cargo missing'); return 'ok'; } }), /cargo missing/);
  assert.throws(() => checkRequirements({ platform: 'linux' }), /TODO/);
  assert.throws(() => assertWindows('darwin'), /TODO/);
});

test('Windows Cargo home guard checks explicit/default paths and long-path registry setting', () => {
  const suffix = '\\git\\checkouts\\rusty_v8-xxxxxxxxxxxxxxxx\\xxxxxxx\\';
  const limit = 259 - 170 - suffix.length;
  const atLimit = 'Z:\\' + 'x'.repeat(limit - 3);
  const queries = [];
  const disabled = (command, args) => { queries.push([command, args]); return 'LongPathsEnabled    REG_DWORD    0x0'; };
  const opts = { platform: 'win32', exec: disabled };
  checkCargoHomePath({ ...opts, env: { CARGO_HOME: 'Z:\\cg' } });
  checkCargoHomePath({ ...opts, env: { CARGO_HOME: atLimit } });
  checkCargoHomePath({ ...opts, platform: 'linux', env: { CARGO_HOME: atLimit + 'x' } });
  assert.equal(queries.length, 0);
  const expected = error => error.message.includes('CARGO_HOME is too long')
    && error.message.includes('New-Item -ItemType Junction')
    && error.message.includes('administrator PowerShell: Set-ItemProperty');
  assert.throws(() => checkCargoHomePath({ ...opts, env: { CARGO_HOME: atLimit + 'x' } }), expected);
  assert.deepEqual(queries[0], ['reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled']]);
  assert.throws(() => checkCargoHomePath({ ...opts, env: {}, home: atLimit }), expected);
  checkCargoHomePath({ ...opts, env: { CARGO_HOME: atLimit + 'x' }, exec: () => 'LongPathsEnabled    REG_DWORD    0x1' });
  assert.throws(() => checkCargoHomePath({ ...opts, env: { CARGO_HOME: atLimit + 'x' }, exec: () => { throw Error('missing value'); } }), expected);
});

test('install, reinstall, sync and restore use only a fake standalone junction tree', { skip: process.platform !== 'win32' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-'));
  // Every path, including footer and executable, stays in this disposable fixture.
  t.after(() => { under(temp, os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const home = path.join(temp, 'home'), base = path.join(home, 'packages/standalone');
  const stock = path.join(base, `releases/${manifest.version}-x86_64-pc-windows-msvc`), footer = path.join(temp, 'footer'), binary = path.join(temp, 'codex.exe');
  fs.mkdirSync(path.join(stock, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stock, 'codex-resources/voice/bin'), { recursive: true });
  fs.writeFileSync(path.join(stock, 'bin/codex.exe'), 'stock');
  fs.writeFileSync(path.join(stock, 'codex-resources/voice/bin/host.exe'), 'voice');
  fs.symlinkSync(stock, path.join(base, 'current'), 'junction');
  fs.mkdirSync(path.join(footer, 'src'), { recursive: true });
  for (const name of ['statusline.js', 'package.json', 'LICENSE', 'src/footer.js']) fs.writeFileSync(path.join(footer, name), 'footer');
  fs.writeFileSync(binary, 'custom-v1');
  fs.writeFileSync(path.join(home, 'config.toml'), 'untouched');
  const opts = { 'codex-home': home, binary, 'footer-root': footer };
  const copyPackage = fs.cpSync;
  let packageCopies = 0;
  t.mock.method(fs, 'cpSync', (...args) => { packageCopies++; return copyPackage(...args); });
  let voiceCommit = manifest.commit;
  t.mock.method(common, 'run', (command, args) => {
    assert.equal(path.basename(command), 'codex-voice-host.exe');
    assert.deepEqual(args, ['--build-commit']);
    return voiceCommit;
  });
  voiceCommit = 'wrong-commit';
  assert.throws(() => install(opts), /voice host build commit/);
  assert.equal(activeTarget(base), stock);
  voiceCommit = manifest.commit;
  const first = install(opts);
  assert.equal(path.basename(first.customTarget), `${manifest.version}-agent-kit`);
  assert.equal(activeTarget(base), first.customTarget);
  assert.equal(fs.readFileSync(path.join(first.customTarget, 'bin/codex.exe'), 'utf8'), 'custom-v1');
  assert.equal(fs.readFileSync(path.join(first.customTarget, 'codex-resources/voice/bin/host.exe'), 'utf8'), 'voice');
  fs.writeFileSync(binary, 'custom-v2');
  const copyFile = fs.copyFileSync;
  let lockedCopy = true;
  t.mock.method(fs, 'copyFileSync', (from, to) => {
    if (lockedCopy && to === path.join(first.customTarget, 'bin/codex.exe')) {
      lockedCopy = false;
      throw Object.assign(Error('running executable'), { code: 'EPERM' });
    }
    return copyFile(from, to);
  });
  const second = install(opts);
  assert.equal(lockedCopy, false);
  assert.equal(first.customTarget, second.customTarget);
  assert.equal(packageCopies, 1);
  assert.equal(second.stockTarget, stock);
  assert.equal(fs.readFileSync(path.join(first.customTarget, 'bin/codex.exe'), 'utf8'), 'custom-v2');
  const resources = path.join(second.customTarget, 'codex-resources');
  fs.mkdirSync(path.join(resources, 'agent-statusline.before-stale'));
  fs.mkdirSync(path.join(resources, 'agent-statusline.next-stale'));
  fs.writeFileSync(path.join(second.customTarget, 'bin/codex.exe.retired-stale'), 'old exe');
  fs.writeFileSync(path.join(footer, 'statusline.js'), 'new footer');
  syncFooter(opts);
  assert.equal(fs.readFileSync(path.join(second.customTarget, 'codex-resources/agent-statusline/statusline.js'), 'utf8'), 'new footer');
  assert.equal(fs.readFileSync(path.join(second.customTarget, 'bin/codex.exe'), 'utf8'), 'custom-v2');
  assert.deepEqual(fs.readdirSync(resources).sort(), ['agent-statusline', 'voice']);
  assert.deepEqual(fs.readdirSync(path.join(second.customTarget, 'bin')), ['codex.exe']);
  for (let i = 0; i < 3; i++) install(opts);
  assert.equal(packageCopies, 1);
  assert.equal(fs.readdirSync(path.join(base, 'statusline-backups')).length, 3);
  assert(!fs.readdirSync(base).some(name => /^current\.(next|before)-/.test(name)));
  voiceCommit = 'wrong-commit';
  restore(opts);
  assert.equal(activeTarget(base), stock);
  voiceCommit = manifest.commit;
  restore(opts); restore(opts);
  assert.equal(activeTarget(base), stock);
  assert.throws(() => syncFooter(opts), /not active/);
  install(opts);
  fs.writeFileSync(path.join(stock, 'bin/codex.exe'), 'tampered');
  assert.throws(() => restore(opts), /hash changed/);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'untouched');
});

test('manual custom install migrates using a stock backup junction or pinned fallback', { skip: process.platform !== 'win32' }, t => {
  t.mock.method(common, 'run', () => manifest.commit);
  for (const useJunction of [true, false]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migration-'));
    t.after(() => { under(temp, os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
    const base = path.join(temp, 'standalone'), footer = path.join(temp, 'footer'), binary = path.join(temp, 'custom.exe');
    const legacy = path.join(base, 'releases/9.9.9-statusline-legacy');
    const stock = path.join(base, `releases/${manifest.version}-x86_64-pc-windows-msvc`);
    fs.mkdirSync(path.join(stock, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stock, 'bin/codex.exe'), 'official');
    fs.mkdirSync(path.join(legacy, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'bin/codex.exe'), 'manual custom');
    if (useJunction) fs.mkdirSync(path.join(legacy, 'codex-resources/agent-statusline'), { recursive: true });
    fs.symlinkSync(legacy, path.join(base, 'current'), 'junction');
    if (useJunction) fs.symlinkSync(stock, path.join(base, 'current.before-statusline-20261025-075852'), 'junction');
    fs.mkdirSync(path.join(footer, 'src'), { recursive: true });
    for (const name of ['statusline.js', 'package.json', 'LICENSE']) fs.writeFileSync(path.join(footer, name), 'footer');
    fs.writeFileSync(binary, 'new custom');
    const opts = { standalone: base, binary, 'footer-root': footer };
    const messages = [];
    const log = t.mock.method(console, 'log', message => messages.push(message));
    const state = install(opts);
    log.mock.restore();
    assert.equal(state.stockTarget, stock);
    assert.equal(path.basename(state.customTarget), `${manifest.version}-agent-kit`);
    assert.equal(fs.readFileSync(path.join(legacy, 'bin/codex.exe'), 'utf8'), 'manual custom');
    assert(messages.some(message => message.includes(legacy) && message.includes('delete it manually')));
    restore(opts);
    assert.equal(activeTarget(base), stock);
    // A stock-looking release with our footer must never be accepted as stock.
    fs.mkdirSync(path.join(stock, 'codex-resources/agent-statusline'), { recursive: true });
    fs.unlinkSync(path.join(base, 'agent-statusline-state.json'));
    assert.throws(() => install(opts), /Official stock Codex release not found/);
  }
});

test('install rejects a different stock version but restore uses the recorded stock and hash', { skip: process.platform !== 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-version-'));
  t.after(() => { under(base, os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
  const stock = path.join(base, 'releases/9.9.9-x86_64-pc-windows-msvc');
  const custom = path.join(base, 'releases/9.9.9-agent-kit');
  fs.mkdirSync(path.join(stock, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(custom, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(custom, 'codex-resources'));
  fs.writeFileSync(path.join(stock, 'bin/codex.exe'), 'old stock');
  fs.symlinkSync(stock, path.join(base, 'current'), 'junction');
  const expected = error => error.message.includes(manifest.version)
    && error.message.includes(`-Release ${manifest.version}`);
  assert.throws(() => install({ standalone: base }), expected);
  assert.equal(activeTarget(base), stock);
  fs.unlinkSync(path.join(base, 'current'));
  fs.symlinkSync(custom, path.join(base, 'current'), 'junction');
  fs.symlinkSync(stock, path.join(base, 'current.before-old'), 'junction');
  assert.throws(() => install({ standalone: base }), expected);
  fs.writeFileSync(path.join(base, 'agent-statusline-state.json'), JSON.stringify({ stockTarget: stock, stockSha256: common.fileHash(path.join(stock, 'bin/codex.exe')), customTarget: custom }));
  assert.throws(() => install({ standalone: base }), expected);
  t.mock.method(common, 'run', () => { throw Error('restore must not query a voice host against the new manifest'); });
  fs.writeFileSync(path.join(stock, 'bin/codex.exe'), 'tampered');
  assert.throws(() => restore({ standalone: base }), /Stock executable hash changed/);
  assert.equal(activeTarget(base), custom);
  fs.writeFileSync(path.join(stock, 'bin/codex.exe'), 'old stock');
  restore({ standalone: base });
  assert.equal(activeTarget(base), stock);
  restore({ standalone: base });
});

test('version upgrade replaces old state and restores the new stock release', { skip: process.platform !== 'win32' }, t => {
  const oldVersion = '9.9.9';
  for (const current of ['new-stock', 'old-stock', 'old-custom']) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upgrade-'));
    t.after(() => { under(base, os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
    const oldStock = path.join(base, `releases/${oldVersion}-x86_64-pc-windows-msvc`);
    const oldCustom = path.join(base, `releases/${oldVersion}-agent-kit`);
    const stock = path.join(base, `releases/${manifest.version}-x86_64-pc-windows-msvc`);
    for (const target of [oldStock, oldCustom, stock]) {
      fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(target, 'bin/codex.exe'), target === stock ? 'new stock' : 'old executable');
    }
    fs.mkdirSync(path.join(stock, 'codex-resources/voice'), { recursive: true });
    fs.writeFileSync(path.join(stock, 'codex-resources/voice/resource'), 'new voice');
    const active = { 'new-stock': stock, 'old-stock': oldStock, 'old-custom': oldCustom }[current];
    fs.symlinkSync(active, path.join(base, 'current'), 'junction');
    const previous = { stockTarget: oldStock, stockSha256: common.fileHash(path.join(oldStock, 'bin/codex.exe')), customTarget: oldCustom };
    const stateFile = path.join(base, 'agent-statusline-state.json');
    fs.writeFileSync(stateFile, JSON.stringify(previous));
    const footer = path.join(base, 'footer'), binary = path.join(base, 'new.exe');
    fs.mkdirSync(path.join(footer, 'src'), { recursive: true });
    for (const name of ['statusline.js', 'package.json', 'LICENSE']) fs.writeFileSync(path.join(footer, name), 'footer');
    fs.writeFileSync(binary, 'new custom');
    const exec = t.mock.method(common, 'run', (command, args) => {
      assert.equal(command, path.join(stock, 'codex-resources/voice/bin/codex-voice-host.exe'));
      assert.deepEqual(args, ['--build-commit']);
      return manifest.commit;
    });
    const messages = [], log = t.mock.method(console, 'log', message => messages.push(message));
    const opts = { standalone: base, binary, 'footer-root': footer };
    const state = install(opts);
    assert.equal(state.stockTarget, stock);
    assert.equal(state.customTarget, path.join(base, `releases/${manifest.version}-agent-kit`));
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), state);
    assert.equal(activeTarget(base), state.customTarget);
    assert.equal(fs.readFileSync(path.join(state.customTarget, 'codex-resources/voice/resource'), 'utf8'), 'new voice');
    assert.equal(fs.readFileSync(path.join(state.customTarget, 'bin/codex.exe'), 'utf8'), 'new custom');
    assert.equal(fs.readFileSync(path.join(oldCustom, 'bin/codex.exe'), 'utf8'), 'old executable');
    assert(messages.some(message => message.includes(oldCustom) && message.includes('delete it manually')));
    restore(opts);
    assert.equal(activeTarget(base), stock);
    exec.mock.restore(); log.mock.restore();
  }
});

test('prepare cleanup removes only other owned work trees for the same version', t => {
  const native = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-work-'));
  t.after(() => { under(native, os.tmpdir()); fs.rmSync(native, { recursive: true, force: true }); });
  const root = path.join(native, 'work'), current = `${manifest.version}-current`;
  const names = [current, `${manifest.version}-old`, `${manifest.version}-foreign`, `${manifest.version}-invalid`, '9.9.9-old'];
  for (const name of names) fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const name of [current, `${manifest.version}-old`, '9.9.9-old']) {
    fs.writeFileSync(path.join(root, name, '.agent-statusline-source.json'), JSON.stringify({ commit: manifest.commit, featureHash: '123456abcdef' }));
  }
  fs.writeFileSync(path.join(root, `${manifest.version}-invalid/.agent-statusline-source.json`), 'not json');
  cleanupWork({ native, work: path.join(root, current) }, manifest);
  assert.deepEqual(fs.readdirSync(root).sort(), names.filter(n => n !== `${manifest.version}-old`).sort());
});

test('junction activation rolls back a failed rename and rejects non-junction current', { skip: process.platform !== 'win32' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refuse-'));
  t.after(() => { under(temp, os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(temp, 'current'));
  assert.throws(() => activeTarget(temp), /junction/);
  fs.rmdirSync(path.join(temp, 'current'));
  const stock = path.join(temp, 'releases/stock'), custom = path.join(temp, 'releases/custom');
  fs.mkdirSync(stock, { recursive: true }); fs.mkdirSync(custom);
  fs.symlinkSync(stock, path.join(temp, 'current'), 'junction');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from).startsWith('current.next-')) throw Error('injected rename failure');
    return rename(from, to);
  });
  assert.throws(() => switchCurrent(temp, custom), /injected/);
  assert.equal(activeTarget(temp), stock);
});

test('locked executable copy renames the old file before retrying', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-locked-'));
  t.after(() => { under(temp, os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const source = path.join(temp, 'source.exe'), target = path.join(temp, 'target.exe');
  fs.writeFileSync(source, 'new'); fs.writeFileSync(target, 'running');
  const copy = fs.copyFileSync;
  let first = true;
  t.mock.method(fs, 'copyFileSync', (from, to) => {
    if (first) { first = false; throw Object.assign(Error('locked'), { code: 'EPERM' }); }
    return copy(from, to);
  });
  copyVerified(source, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  const retired = fs.readdirSync(temp).find(name => name.startsWith('target.exe.retired-'));
  assert.equal(fs.readFileSync(path.join(temp, retired), 'utf8'), 'running');
});

test('best effort cleanup leaves locked paths and can retry later', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cleanup-'));
  t.after(() => { under(temp, os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const target = path.join(temp, 'codex.exe.retired-test');
  fs.writeFileSync(target, 'running');
  const mock = t.mock.method(fs, 'rmSync', () => { throw Object.assign(Error('locked'), { code: 'EPERM' }); });
  assert.doesNotThrow(() => removeBestEffort(target, temp));
  assert(fs.existsSync(target));
  mock.mock.restore();
  removeBestEffort(target, temp);
  assert(!fs.existsSync(target));
});
