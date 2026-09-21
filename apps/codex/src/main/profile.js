"use strict";

// Codex 版的多帳號設定。共用邏輯（argv、profiles.json、userData、帶起其他面板）在
// shared-gen/profile-core.js；這裡只加 Codex 自己的部分：
//   - 每個帳號的 codexHome（該帳號 auth.json 所在目錄，等同 CODEX_HOME）；沒寫就用
//     ~/.codex/<id> 推出來，main 是 ~/.codex/0 —— 每個面板都有自己的窩，
//     不跟 CLI 的 ~/.codex/auth.json 共用（那份會被 codex login/logout 改掉）
//   - 額外帳號的預設調色盤
// 登入用齒輪裡的「登入 ChatGPT」，或 `CODEX_HOME=~/.codex-2 codex login`。

const fs = require("node:fs");
const os = require("node:os");
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

// codexHome 不再是必填：沒寫就用 defaultCodexHomeFor(id) 推出來的窩。
// 以前少寫一行整個 profile 會被悄悄略過（面板直接不見），沒必要這麼嚴格。
// 寫了但空字串／只有空白才算錯。
function validateEntry(entry) {
  if (entry.codexHome === undefined || entry.codexHome === null) return null;
  return core.expandHome(entry.codexHome) ? null : "codexHome 是空的";
}

function resolveProfile(argv, defaultUserDataPath) {
  const profile = core.resolveProfile(argv, defaultUserDataPath, { palette: EXTRA_PROFILE_PALETTE, validateEntry });
  // profiles.json 有明寫 codexHome 就聽它的（使用者自己指的路徑，不覆蓋）；
  // 沒寫就用這個 profile 的預設窩，default 也一樣有自己的（~/.codex/0）。
  const codexHome = core.expandHome(profile.entry.codexHome) || defaultCodexHomeFor(profile.id);
  return {
    id: profile.id,
    name: profile.name,
    userDataPath: profile.userDataPath,
    authFilePath: path.join(codexHome, "auth.json"),
    accent: profile.accent
  };
}

// 面板上的 ＋／－。Codex 的每個帳號要有自己的 CODEX_HOME，新面板預設收在
// ~/.codex/<id>（不是在家目錄旁邊長 ~/.codex-2、~/.codex-3）。
// 目錄一開始是空的，使用者在齒輪裡登入 ChatGPT 之後才會寫出 auth.json。
// main 面板用 ~/.codex/0，跟 add-N 一樣是自己的窩。
// 刻意不讓它用 CLI 的 ~/.codex/auth.json：那份會被終端機的 codex login / logout 改掉，
// 面板顯示的帳號就會跟著跳，登出時還直接失效。面板要的是一個固定不動的帳號。
const MAIN_CODEX_DIR = "0";

function defaultCodexHomeFor(id) {
  return path.join(os.homedir(), ".codex", id === core.DEFAULT_PROFILE_ID ? MAIN_CODEX_DIR : id);
}

// 「－」刪掉這個帳號的 codexHome。
//
// 安全閘：只刪「正好是我們自己發出去的那個路徑」（~/.codex/<id>）。
// 使用者要是手動把 codexHome 改指到別處（例如 ~/.codex 本身、或某個共用目錄），
// 一律不刪，只把這筆從 profiles.json 移掉 —— 寧可留垃圾，也不能誤刪主帳號憑證。
function cleanupEntry(entry, id) {
  const home = core.expandHome(entry?.codexHome);
  if (!home) return;
  const expected = defaultCodexHomeFor(id);
  if (path.resolve(home) !== path.resolve(expected)) {
    console.warn(`面板 ${id} 的 codexHome 不是 ${expected}，不刪除：${home}`);
    return;
  }
  fs.rmSync(home, { recursive: true, force: true });
}

function panelHooks(app, profile, defaultUserDataPath, { dialog, getWindow } = {}) {
  return core.panelHooks(app, profile, defaultUserDataPath, {
    validateEntry,
    buildEntry: (id) => ({ codexHome: defaultCodexHomeFor(id) }),
    confirmRemove: dialog ? (p) => core.confirmRemovePanel(dialog, getWindow?.(), p) : undefined,
    cleanupEntry
  });
}

function listExtraProfileIds(defaultUserDataPath) {
  return core.listExtraProfileIds(defaultUserDataPath, { validateEntry });
}

function launchExtraProfiles(app, defaultUserDataPath) {
  core.launchExtraProfiles(app, defaultUserDataPath, { validateEntry });
}

function reopenHooks(app, profile, defaultUserDataPath) {
  return core.reopenHooks(app, { isDefault: profile.id === core.DEFAULT_PROFILE_ID }, defaultUserDataPath, { validateEntry });
}

module.exports = {
  DEFAULT_PROFILE_ID: core.DEFAULT_PROFILE_ID,
  EXTRA_PROFILE_PALETTE,
  parseProfileArg: core.parseProfileArg,
  expandHome: core.expandHome,
  profilesFilePath: core.profilesFilePath,
  resolveProfile,
  listExtraProfileIds,
  launchExtraProfiles,
  reopenHooks,
  panelHooks
};
