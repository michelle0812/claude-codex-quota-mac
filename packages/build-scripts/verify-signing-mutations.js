// Runs isolated source mutations under /private/tmp; never edits working sources.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const hook = 'packages/build-scripts/after-pack-macos.js';
const release = 'scripts/build-release.js';
const script = 'scripts/create-signing-identity.sh';
const test = 'packages/build-scripts/verify-signing.js';
const mutations = [
  [hook, 'env.QUOTA_SIGN_IDENTITY || DEFAULT_IDENTITY', 'DEFAULT_IDENTITY', '忽略環境身分'],
  [hook, 'name === requested', 'name.includes(requested)', '允許名稱模糊匹配'],
  [hook, 'sha1 === requested.toUpperCase()', 'false', '拒絕 SHA-1 選取'],
  [hook, 'if (matches.length > 1)', 'if (false)', '放過重複身分'],
  [hook, 'return matches[0].sha1', 'return "-"', '固定簽章變成 ad-hoc'],
  [hook, 'if (required) throw new Error(message)', 'if (false) throw new Error(message)', '發布容許缺身分'],
  [hook, 'if (required) throw new Error(`無法查詢', 'if (false) throw new Error(`無法查詢', '發布忽略 security 失敗'],
  [hook, 'warn(`', '(()=>{})(`', '移除 fallback 警告'],
  [hook, 'context.electronPlatformName !== "darwin"', 'false', '非 macOS 也簽署'],
  [hook, 'env.QUOTA_REQUIRE_SIGNING === "1"', 'false', '建置中忽略發布嚴格模式'],
  [hook, '"--force", "--deep", "--sign", identity', '"--force", "--deep", "--sign", "-"', 'codesign 用錯身分'],
  [hook, '"--verify", "--deep", "--strict"', '"--verify", "--deep"', '移除 strict 驗證'],
  [hook, 'if (identity !== "-") args.push', 'if (false) args.push', '未檢查實際簽署憑證'],
  [hook, 'run("/usr/bin/codesign", [...args, appPath], { stdio: "inherit" });', '', '略過簽章完整性驗證'],
  [hook, 'if (identity !== "-" && (', 'if (false && (', '放過無憑證 DR'],
  [hook, String.raw`|| /\bcdhash\b/i.test(dr)`, '|| false', '放過含 cdhash 的替代 DR'],
  [release, 'resolveIdentity({ env, run, required: true })', 'resolveIdentity({ env, run, required: false })', '發布 preflight 不嚴格'],
  [release, 'QUOTA_REQUIRE_SIGNING: "1"', 'QUOTA_REQUIRE_SIGNING: "0"', '子建置可退回 ad-hoc'],
  [release, 'QUOTA_SIGN_IDENTITY: identity', 'QUOTA_SIGN_IDENTITY: "-"', '子建置遺失固定身分'],
  [release, 'if (!skipBuild)', 'if (true)', 'skip-build 仍建置'],
  [release, 'verifyReleaseArtifacts(v, identity);', '', '組裝前未驗證舊產物'],
  [release, 'verify(path.join(repoRoot, app.dir, "dist", arch.outDir, `${app.product}.app`), identity);', '', '未驗證 loose App'],
  [release, 'name.includes(`-${v}-`)', 'true', '收錄舊版 DMG'],
  [release, 'verify(path.join(mount, `${app.product}.app`), identity);', '', '未驗證 DMG 內容'],
  [release, '"-readonly", ', '', 'DMG 非唯讀掛載'],
  [release, 'if (mounted) run(', 'if (false) run(', '驗證失敗未卸載 DMG'],
  [release, 'if (dmgs.length !== APPS.length * 2)', 'if (false)', '缺少 DMG 未失敗'],
];
// Static contract mutation checks only: the creation script is never run.
const scriptGuards = ['set +x', 'set +a', '[[ $(uname -s) == Darwin ]]', '[[ -f "$keychain" ]]', '[[ ! -e "$backup" ]]', 'umask 077', '[[ -t 0 && -t 1 ]]', 'find-certificate -c "$name"', 'CN = Quota Widgets Code Signing', 'CA:false', 'digitalSignature', 'codeSigning', '-days 3650', 'chmod 700', 'chmod 600', 'read -r -s', '[[ -n "$backup_password" && "$backup_password" == "$confirmation" ]]', '-passout stdin', '-T /usr/bin/codesign', 'add-trusted-cert -r trustRoot -p codeSign -k', 'verify-cert -c "$work/cert.pem" -p codeSign', 'find-identity -v -p codesigning', '[[ "$sha1" == "$expected" ]]', "trap 'unset backup_password confirmation; rm -rf"];
for (const guard of scriptGuards) mutations.push([script, guard, 'MUTATED', `腳本靜態保護：${guard}`]);
const work = fs.mkdtempSync('/private/tmp/quota-mutations-');
try {
  for (const file of [hook, release, script, test]) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(work, file));
  }
  const baseline = spawnSync(process.execPath, [path.join(work, test)], { encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr);
  for (const [file, from, to, label] of mutations) {
    const original = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(original.includes(from), `找不到突變位置：${label}`);
    fs.writeFileSync(path.join(work, file), original.replace(from, to));
    const result = spawnSync(process.execPath, [path.join(work, test)], { encoding: 'utf8', timeout: 10000 });
    fs.writeFileSync(path.join(work, file), original);
    assert.ok(result.status !== 0 && result.status !== null, `突變存活：${label}\n${result.stdout}\n${result.stderr}`);
    console.log(`KILLED: ${label}`);
  }
  console.log(`全部 ${mutations.length} 個突變被測試攔下（含 ${scriptGuards.length} 個腳本靜態檢查；未執行建立腳本）。`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
