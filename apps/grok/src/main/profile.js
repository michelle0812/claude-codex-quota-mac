"use strict";

// Grok 版的多帳號設定。共用邏輯（argv、profiles.json、userData、帶起其他面板）在
// shared-gen/profile-core.js；這裡放 Grok 額外帳號的預設調色盤。

const core = require("../shared-gen/profile-core");

const EXTRA_PROFILE_PALETTE = [
  { weekly: "#06B6D4", weeklyStrong: "#22D3EE", short: "#67E8F9", shortStrong: "#CFFAFE" }, // Cyber 科技青藍
  { weekly: "#8B5CF6", weeklyStrong: "#A78BFA", short: "#C4B5FD", shortStrong: "#EDE9FE" }, // 星雲紫
  { weekly: "#14B8A6", weeklyStrong: "#2DD4BF", short: "#5EEAD4", shortStrong: "#CCFBF1" }, // 極光綠
  { weekly: "#F43F5E", weeklyStrong: "#FB7185", short: "#FDA4AF", shortStrong: "#FFE4E6" }  // 霓虹緋紅
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
