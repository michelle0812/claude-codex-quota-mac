"use strict";

// Codex 版的多帳號設定。共用邏輯（argv、profiles.json、userData、帶起其他面板）在
// shared-gen/profile-core.js；這裡只加 Codex 自己的部分：
//   - 額外帳號必須有 codexHome（該帳號 auth.json 所在目錄，等同 CODEX_HOME）
//   - 額外帳號的預設調色盤
// 登入用齒輪裡的「登入 ChatGPT」，或 `CODEX_HOME=~/.codex-2 codex login`。

const path = require("node:path");
const core = require("../shared-gen/profile-core");

// 額外帳號依 profiles.json 裡的順序套用。default 不在這裡：它沿用 app-config.js 的綠色。
// 刻意避開 Claude 版的水藍（#2694C8 系），細條模式下才分得出來。
const EXTRA_PROFILE_PALETTE = [
  { weekly: "#1E9E9A", weeklyStrong: "#3CC4BE", short: "#6FE0D6", shortStrong: "#A6F0E8" }, // 青綠
  { weekly: "#8A9E1E", weeklyStrong: "#AEC43C", short: "#CCE06F", shortStrong: "#E2F0A6" }, // 黃綠
  { weekly: "#6A5ACD", weeklyStrong: "#8E80E6", short: "#B3A8F2", shortStrong: "#D4CDF8" }, // 紫
  { weekly: "#C87A26", weeklyStrong: "#E09A52", short: "#F0BE7D", shortStrong: "#F8DAB0" } // 橘
];

function validateEntry(entry) {
  return core.expandHome(entry.codexHome) ? null : "缺少 codexHome";
}

function resolveProfile(argv, defaultUserDataPath) {
  const profile = core.resolveProfile(argv, defaultUserDataPath, { palette: EXTRA_PROFILE_PALETTE, validateEntry });
  return {
    id: profile.id,
    name: profile.name,
    userDataPath: profile.userDataPath,
    // null = quota-service 走原本的 CODEX_AUTH_FILE / ~/.codex/auth.json
    authFilePath: profile.isDefault ? null : path.join(core.expandHome(profile.entry.codexHome), "auth.json"),
    accent: profile.accent
  };
}

function listExtraProfileIds(defaultUserDataPath) {
  return core.listExtraProfileIds(defaultUserDataPath, { validateEntry });
}

function launchExtraProfiles(app, defaultUserDataPath) {
  core.launchExtraProfiles(app, defaultUserDataPath, { validateEntry });
}

module.exports = {
  DEFAULT_PROFILE_ID: core.DEFAULT_PROFILE_ID,
  EXTRA_PROFILE_PALETTE,
  parseProfileArg: core.parseProfileArg,
  expandHome: core.expandHome,
  profilesFilePath: core.profilesFilePath,
  resolveProfile,
  listExtraProfileIds,
  launchExtraProfiles
};
