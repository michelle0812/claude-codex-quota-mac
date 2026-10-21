const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const hash = 'A'.repeat(40);
const other = 'B'.repeat(40);
const name = 'Quota Widgets Code Signing';
const valid = `  1) ${hash} "${name}"\n     1 valid identities found\n`;
const dr = `designated => identifier "test.quota" and anchor H"${hash}"\n`;
function load(file, overrides = {}, argv = []) {
  const module = { exports: {} };
  const context = { module, exports: module.exports, __dirname: path.dirname(file), process: { env: {}, argv }, console: { log() {}, warn() {} }, require(id) {
    return Object.hasOwn(overrides, id) ? overrides[id] : require("node:module").createRequire(file)(id);
  }};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return module.exports;
}
async function tests() {
  const hook = load(path.join(root, 'packages/build-scripts/after-pack-macos.js'));
  const calls = [], warnings = [];
  let output = valid, requirement = dr;
  const run = (cmd, args) => { calls.push([cmd, [...args]]); return cmd.endsWith('security') ? output : args[0] === '-d' ? requirement : ''; };
  const deps = { run, env: {}, warn: (s) => warnings.push(s), log() {} };
  assert.equal(hook.resolveIdentity(deps), hash);
  assert.equal(hook.resolveIdentity({ ...deps, env: { QUOTA_SIGN_IDENTITY: hash.toLowerCase() } }), hash);
  output = `1) ${other} "Custom Signing"\n`;
  assert.equal(hook.resolveIdentity({ ...deps, env: { QUOTA_SIGN_IDENTITY: 'Custom Signing' } }), other);
  output = `${valid}2) ${other} "${name}"\n`;
  assert.throws(() => hook.resolveIdentity(deps), /不唯一/);
  for (const missing of ['', `1) ${hash} "${name} extra"\n`, `1) ${hash} "${name}" (CSSMERR_TP_NOT_TRUSTED)\n`]) {
    output = missing;
    assert.equal(hook.resolveIdentity(deps), '-');
    assert.throws(() => hook.resolveIdentity({ ...deps, required: true }), /找不到/);
  }
  assert.equal(hook.resolveIdentity({ ...deps, run() { throw Error('denied'); } }), '-');
  assert.throws(() => hook.resolveIdentity({ ...deps, required: true, run() { throw Error('denied'); } }), /無法查詢/);
  assert.ok(warnings.every((s) => /WARNING.*找不到/s.test(s) && /ad-hoc/.test(s)));
  const context = { electronPlatformName: 'darwin', appOutDir: '/tmp/out', packager: { appInfo: { productFilename: 'Quota' } } };
  output = valid;
  calls.length = 0;
  await hook(context, deps);
  assert.deepEqual(calls[1][1], ['--force', '--deep', '--sign', hash, '--timestamp=none', '/tmp/out/Quota.app']);
  assert.deepEqual(calls[2][1], ['--verify', '--deep', '--strict', '-R', `=certificate leaf = H"${hash}"`, '/tmp/out/Quota.app']);
  assert.deepEqual(calls[3][1], ['-d', '-r-', '/tmp/out/Quota.app']);
  calls.length = 0;
  await hook({ electronPlatformName: 'linux' }, deps);
  assert.equal(calls.length, 0);
  output = '';
  const previous = warnings.length;
  await hook(context, deps);
  assert.equal(calls[1][1][3], '-');
  assert.equal(warnings.length, previous + 1);
  calls.length = 0;
  await assert.rejects(hook(context, { ...deps, env: { QUOTA_REQUIRE_SIGNING: '1' } }), /找不到/);
  assert.equal(calls.length, 1); // must never sign in release mode when unavailable
  output = valid;
  for (requirement of ['', `designated => cdhash H"${hash}"`, `${dr} or cdhash H"${hash}"`]) {
    await assert.rejects(hook(context, deps), /DR/);
  }
  requirement = dr;
  await assert.rejects(hook(context, { ...deps, run(cmd, args) { if (args[0] === '--verify') throw Error('bad signature'); return run(cmd, args); } }), /bad signature/);
  await assert.rejects(hook(context, { ...deps, run(cmd, args) { if (args[0] === '--force') throw Error('sign failed'); return run(cmd, args); } }), /sign failed/);

  // Release main must fail before version reads, npm, or output mutation, even --skip-build.
  const release = load(path.join(root, 'scripts/build-release.js'), {
    '../packages/build-scripts/after-pack-macos': hook,
    'node:fs': new Proxy({}, { get() { return () => { throw Error('unexpected filesystem operation'); }; } })
  });
  assert.throws(() => release.main({ env: {}, run() { return ''; } }), /找不到/);
  assert.throws(() => release.main({ env: {}, run() { throw Error('denied'); } }), /無法查詢/);

  for (const argv of [[], ['--skip-build']]) {
    const builds = [];
    const preflight = load(path.join(root, 'scripts/build-release.js'), {
      '../packages/build-scripts/after-pack-macos': { resolveIdentity: hook.resolveIdentity, verifyBundle() { throw Error('artifact gate'); } },
      'node:child_process': { execFileSync(cmd, args, options) { builds.push([cmd, args, options]); } },
      'node:fs': { readFileSync() { return '{"version":"1.2.8"}'; } }
    }, argv);
    assert.throws(() => preflight.main({ env: { CUSTOM: 'kept' }, run() { return valid; } }), /artifact gate/);
    assert.equal(builds.length, argv.length ? 0 : 1);
    if (builds.length) {
      assert.equal(builds[0][2].env.QUOTA_REQUIRE_SIGNING, '1');
      assert.equal(builds[0][2].env.QUOTA_SIGN_IDENTITY, hash);
      assert.equal(builds[0][2].env.CUSTOM, 'kept');
    }
  }

  const releaseCalls = [], verified = [];
  let names = ['Quota-1.2.8-arm.dmg', 'Quota-1.2.8-intel.dmg', 'Quota-1.2.7-arm.dmg', 'ignore.txt'];
  const releaseFs = { readdirSync() { return names; }, mkdtempSync() { return '/tmp/quota-mount'; }, rmdirSync(p) { releaseCalls.push(['rmdir', p]); } };
  const artifacts = load(path.join(root, 'scripts/build-release.js'), { 'node:fs': releaseFs });
  const releaseDeps = { run(cmd, args) { releaseCalls.push([cmd, [...args]]); }, verify(bundle, identity) { verified.push(bundle); assert.equal(identity, hash); } };
  artifacts.verifyReleaseArtifacts('1.2.8', hash, releaseDeps);
  assert.equal(verified.length, 16); // 8 loose apps + 8 DMG apps
  assert.equal(releaseCalls.filter(([cmd]) => cmd.endsWith('hdiutil')).length, 16);
  assert.ok(releaseCalls.find(([, args]) => Array.isArray(args) && args.includes('-readonly')));
  releaseCalls.length = 0;
  assert.throws(() => artifacts.verifyReleaseArtifacts('1.2.8', hash, { ...releaseDeps, verify(bundle) { if (bundle.startsWith('/tmp/')) throw Error('adhoc dmg'); } }), /adhoc dmg/);
  assert.ok(releaseCalls.some(([, args]) => Array.isArray(args) && args[0] === 'detach'));
  names = [];
  assert.throws(() => artifacts.verifyReleaseArtifacts('1.2.8', hash, releaseDeps), /預期/);

  // Creation script is inspected only, never executed (including mocked execution).
  const script = fs.readFileSync(path.join(root, 'scripts/create-signing-identity.sh'), 'utf8');
  for (const fragment of ['set +x', 'set +a', '[[ $(uname -s) == Darwin ]]', '[[ -f "$keychain" ]]', '[[ ! -e "$backup" ]]', 'umask 077', '[[ -t 0 && -t 1 ]]', 'find-certificate -c "$name"', 'exit 1', 'CN = Quota Widgets Code Signing', 'CA:false', 'digitalSignature', 'codeSigning', '-days 3650', 'chmod 700', 'chmod 600', 'read -r -s', '[[ -n "$backup_password" && "$backup_password" == "$confirmation" ]]', '-passout stdin', '-T /usr/bin/codesign', 'add-trusted-cert -r trustRoot -p codeSign -k', 'verify-cert -c "$work/cert.pem" -p codeSign', 'find-identity -v -p codesigning', '[[ "$sha1" == "$expected" ]]', "trap 'unset backup_password confirmation; rm -rf", 'unset backup_password confirmation']) assert.ok(script.includes(fragment), `script missing: ${fragment}`);
  assert.equal(script.split('read -r -s').length - 1, 2);
  assert.equal(script.split('find-certificate -c "$name"').length - 1, 2);
  assert.ok(!/security .*\s(?:-P|-A|-d)\b|set-key-partition-list|export .*password/.test(script));
  console.log('signing: 解析／hook／發布封鎖／DMG 驗證／腳本靜態檢查全部通過');
}
tests().catch((error) => { console.error(error); process.exitCode = 1; });
