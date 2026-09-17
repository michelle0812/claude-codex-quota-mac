const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_WIDGET_SETTINGS, normalizeWidgetSettings } = require("../shared/widget-settings");

const defaults = normalizeWidgetSettings();
assert.deepEqual(defaults, DEFAULT_WIDGET_SETTINGS);

const migrated = normalizeWidgetSettings({
  recentFastBreathMs: 6000,
  criticalBlinkMs: 5000,
  quotaRefreshMs: 10 * 60 * 1000
});
assert.equal(migrated.autoUpdateCheck, true);
assert.equal(normalizeWidgetSettings({ autoUpdateCheck: false }).autoUpdateCheck, false);

// Dock 圖示開關已移除（一律不顯示）：舊設定檔裡的 showInDock 要被丟掉，不能再被讀回來。
assert.equal("showInDock" in DEFAULT_WIDGET_SETTINGS, false);
assert.equal("showInDock" in normalizeWidgetSettings({ showInDock: true, autoUpdateCheck: true }), false);

// 設定視窗不能再有 Dock 開關；兩個 app 打包後都要用 LSUIElement 從一開始就不出現在 Dock。
const repoRoot = path.resolve(__dirname, "..", "..");
const settingsHtml = fs.readFileSync(path.join(repoRoot, "packages", "shared", "settings.html"), "utf8");
assert.equal(/showInDock|Dock/.test(settingsHtml), false, "settings.html 不應再提到 Dock");
for (const appName of ["claude", "codex"]) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", appName, "package.json"), "utf8"));
  assert.equal(pkg.build?.mac?.extendInfo?.LSUIElement, true, `${appName}: build.mac.extendInfo.LSUIElement 必須是 true`);
}

console.log("Verified widget settings defaults/migration, Dock toggle removed, and LSUIElement set for every app.");
