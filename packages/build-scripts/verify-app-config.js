// 檢查兩個 app 的 src/app-config.js 是否符合 renderer-core / settings-core 的契約。
// 特別是主色：兩個 app 的 mini bar 一定要用不同顏色，否則使用者分不出誰是誰。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..", "..");
const appsDir = path.join(repoRoot, "apps");
const REQUIRED_ACCENT_KEYS = ["weekly", "weeklyStrong", "short", "shortStrong"];
const REQUIRED_COPY_KEYS = ["brand", "statusLoading", "statusError", "authRequired"];
// 錯誤訊息是空字串時要顯示哪一則文案；unknown 是 renderer-core 共用文案裡本來就有的 key。
const ALLOWED_EMPTY_ERROR_KEYS = [...REQUIRED_COPY_KEYS, "unknown"];
const REQUIRED_AUTH_KEYS = [
  "label",
  "checkingText",
  "loggedInText",
  "loggedOutText",
  "loginLabel",
  "logoutLabel",
  "loginPendingText",
  "loginDoneText",
  "logoutDoneText"
];

function loadAppConfig(appName) {
  const file = path.join(appsDir, appName, "src", "app-config.js");
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const config = context.window.APP_CONFIG;
  assert.ok(config, `${appName}: app-config.js 沒有設定 window.APP_CONFIG`);
  return config;
}

const apps = fs
  .readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert.ok(apps.length >= 2, "apps/ 底下應該至少有兩個 app");

const configs = new Map(apps.map((name) => [name, loadAppConfig(name)]));

for (const [name, config] of configs) {
  assert.equal(typeof config.brandName, "string", `${name}: brandName 必須是字串`);
  assert.ok(config.brandName.length > 0, `${name}: brandName 不可為空`);
  assert.ok(config.compactThemeStorageKey, `${name}: 缺少 compactThemeStorageKey`);
  assert.ok(
    ALLOWED_EMPTY_ERROR_KEYS.includes(config.emptyErrorCopyKey),
    `${name}: emptyErrorCopyKey 應該是 ${ALLOWED_EMPTY_ERROR_KEYS.join(" / ")} 之一`
  );

  for (const key of REQUIRED_ACCENT_KEYS) {
    const value = config.accent?.[key];
    assert.match(String(value), /^#[0-9a-fA-F]{6}$/, `${name}: accent.${key} 必須是 6 碼十六進位色碼`);
  }

  for (const lang of ["zh", "en"]) {
    for (const key of REQUIRED_COPY_KEYS) {
      assert.ok(config.copy?.[lang]?.[key], `${name}: copy.${lang}.${key} 缺少`);
    }
  }

  if (config.auth) {
    for (const key of REQUIRED_AUTH_KEYS) {
      assert.ok(config.auth[key], `${name}: auth.${key} 缺少`);
    }
  }
}

// 跨 app 的唯一性：主色與 localStorage key 都不能撞。
const seenAccents = new Map();
const seenStorageKeys = new Map();
for (const [name, config] of configs) {
  const accentFingerprint = REQUIRED_ACCENT_KEYS.map((key) => config.accent[key].toLowerCase()).join("/");
  assert.ok(
    !seenAccents.has(accentFingerprint),
    `${name} 和 ${seenAccents.get(accentFingerprint)} 的主色完全一樣，mini bar 會分不出來`
  );
  seenAccents.set(accentFingerprint, name);

  assert.ok(
    !seenStorageKeys.has(config.compactThemeStorageKey),
    `${name} 和 ${seenStorageKeys.get(config.compactThemeStorageKey)} 共用 compactThemeStorageKey`
  );
  seenStorageKeys.set(config.compactThemeStorageKey, name);

  // 7d 與 5h 兩條在同一個 app 裡也要看得出差別。
  assert.notEqual(
    config.accent.weekly.toLowerCase(),
    config.accent.short.toLowerCase(),
    `${name}: accent.weekly 和 accent.short 不可相同`
  );
}

console.log(
  `Verified app config contract for ${apps.join(", ")}: accent tokens, copy keys, auth block, and cross-app uniqueness.`
);
