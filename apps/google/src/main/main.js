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
  selectSource: async () => {
    const choice = await dialog.showMessageBox({
      type: "question", title: "連接 AGY 帳號", message: "連接本機已登入的 AGY？",
      detail: "點擊圓球切換 Gemini Models、Claude and GPT Models、Gemini 4 Argon 的用量。",
      buttons: ["連接本機 AGY", "取消"], defaultId: 0, cancelId: 1, noLink: true
    });
    return choice.response === 0 ? { type: "keychain" } : null;
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
  settingsHtmlPath: path.join(__dirname, "../renderer/settings.html"),
  readQuota: () => accountService.getQuota(),
  panelNameHtmlPath: path.join(__dirname, "../shared-gen/panel-name.html"),
  settingsWindowTitle: profile.name ? `小工具設定 · ${profile.name}` : undefined,
  settingsWindowSize: { width: 390, height: 380 },
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
