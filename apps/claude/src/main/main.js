"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡只負責組出 Claude 版專屬的 config。
//
// 多帳號：一個 profile 一個行程（見 profile.js）。default 行程啟動後會把
// profiles.json 裡的其他帳號各帶起一份；每個面板在齒輪裡各自登入 claude.ai。

const path = require("node:path");
const { app } = require("electron");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { getQuota: getLocalQuota } = require("./quota-service");
const claudeAiService = require("./claude-ai-service");
const { DEFAULT_PROFILE_ID, resolveProfile, launchExtraProfiles } = require("./profile");

const defaultUserDataPath = app.getPath("userData");

let profile;
try {
  profile = resolveProfile(process.argv, defaultUserDataPath);
} catch (error) {
  console.error(error.message);
  app.exit(1);
  return;
}
const isDefaultProfile = profile.id === DEFAULT_PROFILE_ID;

// 一定要在 startQuotaWidget（requestSingleInstanceLock）之前改，lock 與 claude.ai 登入才會分 profile。
if (!isDefaultProfile) {
  app.setPath("userData", profile.userDataPath);
}

// 資料來源優先序：登入過 claude.ai 就先打帳號級別的網站 API（不受哪台機器在跑
// Claude Code 影響）；沒登入或抓失敗，退回讀本機 statusLine hook 落地的檔案。
// 額外帳號不退回本機：本機檔與方案資訊屬於這台 Claude Code 登入的帳號，混進來會顯示錯帳號的數字。
async function readQuota(reason) {
  if (!isDefaultProfile) {
    if (!(await claudeAiService.hasSession())) {
      throw new Error("尚未登入 claude.ai，請按齒輪 ⚙ 登入這個帳號。");
    }
    return claudeAiService.getQuota({ useLocalPlan: false });
  }

  if (await claudeAiService.hasSession()) {
    try {
      return await claudeAiService.getQuota();
    } catch (error) {
      console.warn(`claude.ai 用量讀取失敗，改用本機檔：${error.message}`);
    }
  }
  const local = await getLocalQuota(reason);
  return { ...local, source: local.source || "local" };
}

startQuotaWidget({
  appIconPath: path.join(__dirname, "../../assets/app-icon.png"),
  preloadPath: path.join(__dirname, "../shared-gen/preload.js"),
  rendererHtmlPath: path.join(__dirname, "../shared-gen/renderer.html"),
  settingsHtmlPath: path.join(__dirname, "../shared-gen/settings.html"),
  readQuota,
  settingsWindowTitle: profile.name ? `小工具設定 · ${profile.name}` : undefined,
  settingsWindowSize: { width: 360, height: 620 },
  rendererQuery: profile.name || profile.accent || !isDefaultProfile
    ? { name: profile.name, accent: profile.accent, extra: !isDefaultProfile }
    : undefined,
  auth: {
    configure: (userDataPath) => claudeAiService.configure(userDataPath),
    hasSession: () => claudeAiService.hasSession(),
    login: () => claudeAiService.login(),
    logout: () => claudeAiService.logout()
  }
});

if (isDefaultProfile) {
  app.whenReady().then(() => launchExtraProfiles(app, defaultUserDataPath));
}
