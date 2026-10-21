// Opt-in integration test: test keychain/certificate only; never touches login.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const work = fs.mkdtempSync('/private/tmp/quota-sign-test-');
const keychain = path.join(work, 'test.keychain-db');
const cert = path.join(work, 'cert.pem');
let trustAttempted = false, created = false, removed = false;
function run(cmd, args, timeout = 20000) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (result.status !== 0 || result.error) throw Error(`${path.basename(cmd)}: ${result.error?.message || result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}
try {
  fs.writeFileSync(path.join(work, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Quota Signing Temporary Test\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n');
  run('/usr/bin/openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-config', path.join(work, 'openssl.cnf'), '-keyout', path.join(work, 'key.pem'), '-out', cert]);
  // Empty password for a disposable test keychain only; contains no real secrets.
  run('/usr/bin/security', ['create-keychain', '-p', '', keychain]);
  created = true;
  run('/usr/bin/security', ['unlock-keychain', '-p', '', keychain]);
  run('/usr/bin/openssl', ['rsa', '-in', path.join(work, 'key.pem'), '-out', path.join(work, 'rsa.pem')]);
  run('/usr/bin/security', ['import', path.join(work, 'rsa.pem'), '-k', keychain, '-T', '/usr/bin/codesign']);
  run('/usr/bin/security', ['import', cert, '-k', keychain]);
  trustAttempted = true;
  run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, cert], 15000);
  const output = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  console.log('測試身分查詢：' + output);
  const hash = output.match(/\b[A-F0-9]{40}\b/)?.[0];
  assert.ok(hash, output);
  const app = path.join(work, 'Test.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources'));
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.quota.signing</string><key>CFBundleExecutable</key><string>Test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  fs.writeFileSync(path.join(work, 'test.c'), 'int main(void) { return 0; }\n');
  run('/usr/bin/clang', [path.join(work, 'test.c'), '-o', path.join(app, 'Contents/MacOS/Test')]);
  const requirements = [], hashes = [];
  for (const version of ['one', 'two']) {
    fs.writeFileSync(path.join(app, 'Contents/Resources/version'), version);
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', hash, '--keychain', keychain, '--timestamp=none', app]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    requirements.push(run('/usr/bin/codesign', ['-d', '-r-', app]));
    hashes.push(run('/usr/bin/codesign', ['-dv', app]).match(/CDHash=(\w+)/)?.[1]);
  }
  assert.equal(requirements[0], requirements[1]);
  assert.ok(hashes[0] && hashes[1] && hashes[0] !== hashes[1]);
  assert.ok(!/cdhash/i.test(requirements[0]));
  console.log('PASS: 兩次內容不同、CDHash 不同，完整 codesign -d -r- 輸出完全相同。\n' + requirements[0]);
  run('/usr/bin/security', ['remove-trusted-cert', cert]);
  removed = true;
  // Verify without trust, matching an end user's machine.
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  console.log('PASS: 移除 user-domain 信任後，更新器的 --verify --deep --strict 仍通過。');
  fs.writeFileSync(path.join(app, 'Contents/Resources/version'), 'tampered');
  assert.throws(() => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]));
  console.log('PASS: 篡改資源的負面對照被拒絕。');
} catch (error) {
  console.error('暫存鑰匙圈實測未完成：' + error.message);
  process.exitCode = 2;
} finally {
  let clean = true;
  if (trustAttempted && !removed) {
    try { run('/usr/bin/security', ['remove-trusted-cert', cert]); }
    catch (error) { console.error('移除測試信任未完成：' + error.message); clean = false; }
  }
  if (created) {
    try { run('/usr/bin/security', ['delete-keychain', keychain]); }
    catch (error) { console.error('刪除暫存鑰匙圈未完成：' + error.message); clean = false; }
  }
  if (clean) { fs.rmSync(work, { recursive: true, force: true }); console.log('測試信任／暫存鑰匙圈與檔案已清理。'); }
  else { console.error('保留清理所需測試檔：' + work); process.exitCode = 2; }
}
