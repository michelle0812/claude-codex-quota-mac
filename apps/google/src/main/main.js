"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡負責組出 Google (Antigravity / Gemini) 版專屬 config。

const path = require("node:path");
const { app, dialog, BrowserWindow } = require("electron");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { createAccountService } = require("./agy-account-service");
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
const isDefaultProfile = profile.id === DEFAULT_PROFILE_ID;

if (!isDefaultProfile) {
  app.setPath("userData", profile.userDataPath);
}

const accountService = createAccountService({
  selectSource: async ({ defaultPath }) => {
    const choice = await dialog.showMessageBox({
      type: "question", title: "連接 AGY 帳號", message: "使用哪個 AGY 登入？",
      detail: "本機已登入 AGY 時，直接連接即可，不用尋找或匯出憑證檔。其他帳號可選擇自己的憑證檔。",
      buttons: ["連接本機 AGY", "選擇其他憑證檔", "取消"], defaultId: 0, cancelId: 2, noLink: true
    });
    if (choice.response === 2) return null;
    if (choice.response === 0) return { type: "keychain" };
    const result = await dialog.showOpenDialog({
      title: "連接此面板的 AGY 帳號", buttonLabel: "連接 AGY",
      defaultPath, properties: ["openFile", "showHiddenFiles"],
      message: "選擇已登入 AGY 的憑證檔。此面板只讀取檔案，不會更動 AGY 的登入。"
    });
    return result.canceled ? null : { type: "file", path: result.filePaths[0] };
  }
});

startQuotaWidget({
  updater: {
    productName: "Google 額度",
    assetPrefix: "GoogleQuota",
    bundleId: "com.google.usage.widget",
    dataDir: defaultUserDataPath,
    isDefault: profile.id === DEFAULT_PROFILE_ID
  },
  appIconPath: path.join(__dirname, "../../assets/app-icon.png"),
  preloadPath: path.join(__dirname, "../shared-gen/preload.js"),
  rendererHtmlPath: path.join(__dirname, "../shared-gen/renderer.html"),
  settingsHtmlPath: path.join(__dirname, "../shared-gen/settings.html"),
  readQuota: () => accountService.getQuota(),
  settingsWindowTitle: profile.name ? `小工具設定 · ${profile.name}` : undefined,
  settingsWindowSize: { width: 400, height: 720 },
  rendererQuery: profile.name || profile.accent || !isDefaultProfile
    ? { name: profile.name, accent: profile.accent, extra: !isDefaultProfile }
    : undefined,
  ...reopenHooks(app, profile, defaultUserDataPath),
  panels: panelHooks(app, { ...profile, isDefault: profile.id === DEFAULT_PROFILE_ID }, defaultUserDataPath, {
    dialog,
    getWindow: () => BrowserWindow.getAllWindows()[0] || null
  }),
  auth: {
    configure: (directory) => accountService.configure(directory),
    hasSession: () => accountService.hasSession(),
    login: () => accountService.login(),
    logout: () => accountService.logout(),
    getOptions: () => accountService.getOptions(),
    setOptions: (value) => accountService.setOptions(value),
    resetQuotaOnChange: true
  }
});

if (isDefaultProfile) {
  app.whenReady().then(() => {
    if (app.hasSingleInstanceLock()) launchExtraProfiles(app, defaultUserDataPath);
  });
}
