"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡只負責組出 Codex 版專屬的 config。
// 設定視窗（齒輪）的帳號區塊由 codex-auth-service.js 提供：系統瀏覽器登入 ChatGPT，寫進該 profile 的 auth.json。
//
// 多帳號：一個 profile 一個行程（見 profile.js）。default 行程啟動後會把
// profiles.json 裡的其他帳號各帶起一份；已經在跑的會被 single-instance lock 擋掉。

const path = require("node:path");
const { app, dialog, BrowserWindow, shell } = require("electron");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { getQuota, resolveAuthFilePath } = require("./quota-service");
const { createCodexAuth } = require("./codex-auth-service");
const { createBrowserUsage } = require("./browser-usage-service");
const { DEFAULT_PROFILE_ID, resolveProfile, launchExtraProfiles, reopenHooks, panelHooks } = require("./profile");

const defaultUserDataPath = app.getPath("userData");

let profile;
try {
  profile = resolveProfile(process.argv, defaultUserDataPath);
} catch (error) {
  console.error(error.message);
  app.exit(1);
  return;
}

// 一定要在 startQuotaWidget（requestSingleInstanceLock）之前改，lock 才會分 profile。
if (profile.id !== DEFAULT_PROFILE_ID) {
  app.setPath("userData", profile.userDataPath);
}

const rendererQuery = profile.name || profile.accent ? { name: profile.name, accent: profile.accent } : undefined;
const codexAuth = createCodexAuth({
  authFilePath: resolveAuthFilePath(profile.authFilePath),
  profileName: profile.name
});
const browserUsage = createBrowserUsage({ userDataPath: profile.userDataPath, profileId: profile.id });
app.on("before-quit", () => browserUsage.destroy());
const auth = {
  hasSession: async () => await browserUsage.isBrowser() ? browserUsage.hasSession() : codexAuth.hasSession(),
  login: async () => await browserUsage.isBrowser() ? browserUsage.login() : codexAuth.login(),
  logout: async () => await browserUsage.isBrowser() ? browserUsage.logout() : codexAuth.logout(),
  getOptions: () => browserUsage.getOptions(),
  setOptions: (value) => browserUsage.setOptions(value),
  openBridge: async () => {
    const folder = app.isPackaged ? path.join(process.resourcesPath, "browser-extension") : path.resolve(__dirname, "../../../..", "browser-extension");
    const error = await shell.openPath(folder);
    if (error) throw new Error("無法開啟橋接擴充套件資料夾");
    return true;
  }
};

startQuotaWidget({
  updater: {
    productName: "Codex 額度", assetPrefix: "CodexQuota", bundleId: "cn.codex.quota.widget",
    dataDir: defaultUserDataPath, isDefault: profile.id === DEFAULT_PROFILE_ID
  },
  appIconPath: path.join(__dirname, "../../assets/app-icon.png"),
  preloadPath: path.join(__dirname, "../shared-gen/preload.js"),
  rendererHtmlPath: path.join(__dirname, "../shared-gen/renderer.html"),
  settingsHtmlPath: path.join(__dirname, "../shared-gen/settings.html"),
  readQuota: async () => await browserUsage.isBrowser() ? browserUsage.readQuota() : getQuota({ authFilePath: profile.authFilePath, allowRefresh: profile.ownsAuthFile }),
  settingsWindowTitle: profile.name ? `小工具設定 · ${profile.name}` : undefined,
  settingsWindowSize: { width: 390, height: 780 },
  rendererQuery,
  auth,
  // 沒有 Dock 圖示：使用者再打開 App 時，不管 macOS 通知到哪一份，所有帳號的面板都叫回來。
  ...reopenHooks(app, profile, defaultUserDataPath),
  // 標題列的 ＋／－：新增／移除面板。
  panels: panelHooks(app, { ...profile, isDefault: profile.id === DEFAULT_PROFILE_ID }, defaultUserDataPath, {
    dialog,
    getWindow: () => BrowserWindow.getAllWindows()[0] || null
  })
});

if (profile.id === DEFAULT_PROFILE_ID) {
  // 拿不到 single-instance lock 的那份（App 已經在跑）會自己結束，不要再往外帶起面板；
  // 叫回其他面板交給已經在跑的那份的 onSecondInstance。
  app.whenReady().then(() => {
    if (app.hasSingleInstanceLock()) launchExtraProfiles(app, defaultUserDataPath);
  });
}
