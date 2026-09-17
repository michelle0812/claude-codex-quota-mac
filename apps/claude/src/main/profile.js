"use strict";

// Claude 版的多帳號設定。共用邏輯（argv、profiles.json、userData、帶起其他面板）在
// shared-gen/profile-core.js；這裡只放 Claude 額外帳號的預設調色盤。
//
// 每個 profile 有自己的 userData，claude.ai 的登入（sessionKey 憑證檔與 cookie）本來就存在
// userData 裡，所以多開後每個面板自然是各自的 claude.ai 帳號，從齒輪登入即可。
// 本機 statusLine 用量（~/.claude/usage-status.json）只屬於這台 Claude Code 登入的帳號，
// 所以只有 default 面板會退回讀它，額外帳號只看 claude.ai。

const core = require("../shared-gen/profile-core");

// 額外帳號依 profiles.json 裡的順序套用。default 沿用 app-config.js 的水藍。
// 避開 Codex 版的綠色系與 Codex 額外帳號的調色盤。
const EXTRA_PROFILE_PALETTE = [
  { weekly: "#D2693C", weeklyStrong: "#E88B5F", short: "#F2AE86", shortStrong: "#F8CFB5" }, // 珊瑚橘
  { weekly: "#C8508A", weeklyStrong: "#DE76A8", short: "#EDA0C4", shortStrong: "#F6C9DE" }, // 粉紅
  { weekly: "#4A63C8", weeklyStrong: "#6F86E0", short: "#9CAEF0", shortStrong: "#C8D3F8" }, // 靛藍
  { weekly: "#B89A1E", weeklyStrong: "#D2B63F", short: "#E6D173", shortStrong: "#F2E5AB" } // 金黃
];

function resolveProfile(argv, defaultUserDataPath) {
  return core.resolveProfile(argv, defaultUserDataPath, { palette: EXTRA_PROFILE_PALETTE });
}

module.exports = {
  DEFAULT_PROFILE_ID: core.DEFAULT_PROFILE_ID,
  EXTRA_PROFILE_PALETTE,
  resolveProfile,
  listExtraProfileIds: core.listExtraProfileIds,
  launchExtraProfiles: core.launchExtraProfiles
};
