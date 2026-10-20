"use strict";

// Google 版的多帳號設定。共用邏輯（argv、profiles.json、userData、帶起其他面板）在
// shared-gen/profile-core.js；這裡只放 Google 額外帳號的預設調色盤。

const core = require("../shared-gen/profile-core");

// 額外帳號依 profiles.json 裡的順序套用。default 沿用 app-config.js 的 Google 深藍與 Gemini 靛紫。
// 刻意避開 Claude 版的水藍/暖橘/粉紅/靛藍/金黃，與 Codex 版的綠色系/青綠/黃綠/紫/橘。
const EXTRA_PROFILE_PALETTE = [
  { weekly: "#EA4335", weeklyStrong: "#F28B82", short: "#F6AEA9", shortStrong: "#FCE8E6" }, // Google 紅
  { weekly: "#F29900", weeklyStrong: "#FBBC04", short: "#FEE79A", shortStrong: "#FEF7E0" }, // Google 琥珀金
  { weekly: "#00838F", weeklyStrong: "#00ACC1", short: "#4DD0E1", shortStrong: "#B2EBF2" }, // 湖水綠 / 藍綠
  { weekly: "#8E24AA", weeklyStrong: "#BA68C8", short: "#CE93D8", shortStrong: "#F3E5F5" }  // 寶石紫 / 洋紅
];

function resolveProfile(argv, defaultUserDataPath) {
  return core.resolveProfile(argv, defaultUserDataPath, { palette: EXTRA_PROFILE_PALETTE });
}

// 面板上的 ＋／－。
function panelHooks(app, profile, defaultUserDataPath, { dialog, getWindow } = {}) {
  return core.panelHooks(app, profile, defaultUserDataPath, {
    buildEntry: () => ({}),
    confirmRemove: dialog ? (p) => core.confirmRemovePanel(dialog, getWindow?.(), p) : undefined,
    cleanupEntry: () => {}
  });
}

module.exports = {
  DEFAULT_PROFILE_ID: core.DEFAULT_PROFILE_ID,
  EXTRA_PROFILE_PALETTE,
  resolveProfile,
  listExtraProfileIds: core.listExtraProfileIds,
  launchExtraProfiles: core.launchExtraProfiles,
  reopenHooks: core.reopenHooks,
  panelHooks
};
