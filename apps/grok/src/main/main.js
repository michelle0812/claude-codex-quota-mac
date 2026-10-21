"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡負責組出 Grok (xAI) 版專屬 config。

const path = require("node:path");
const { app, dialog, BrowserWindow } = require("electron");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { createGrokAccountService } = require("./grok-account-service");
const grokWebService = require("./grok-web-service");
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

const accountService = createGrokAccountService();

async function readQuota() {
  if (await grokWebService.hasSession()) {
    try {
      return await grokWebService.getWebQuota();
    } catch (error) {
      console.warn(`grok.com 網頁讀取失敗，退回本機 CLI: ${error.message}`);
    }
  }
  return accountService.getQuota();
}

startQuotaWidget({
  updater: {
    productName: "Grok 額度",
    assetPrefix: "GrokQuota",
    bundleId: "ai.x.grok.quota.widget",
    dataDir: defaultUserDataPath,
    isDefault: profile.id === DEFAULT_PROFILE_ID
  },
  appIconPath: path.join(__dirname, "../../assets/app-icon.png"),
  preloadPath: path.join(__dirname, "../shared-gen/preload.js"),
  rendererHtmlPath: path.join(__dirname, "../shared-gen/renderer.html"),
  settingsHtmlPath: path.join(__dirname, "../shared-gen/settings.html"),
  readQuota,
  panelNameHtmlPath: path.join(__dirname, "../shared-gen/panel-name.html"),
  settingsWindowTitle: profile.name ? `小工具設定 · ${profile.name}` : undefined,
  settingsWindowSize: { width: 360, height: 620 },
  rendererQuery: profile.name || profile.accent || !isDefaultProfile
    ? { name: profile.name, accent: profile.accent, extra: !isDefaultProfile }
    : undefined,
  ...reopenHooks(app, profile, defaultUserDataPath),
  panels: panelHooks(app, { ...profile, isDefault: profile.id === DEFAULT_PROFILE_ID }, defaultUserDataPath, {
    dialog,
    getWindow: () => BrowserWindow.getAllWindows()[0] || null
  }),
  auth: {
    configure: (directory) => {
      accountService.configure(directory);
      grokWebService.configure(directory);
    },
    hasSession: () => grokWebService.hasSession(),
    login: () => grokWebService.login(),
    logout: () => grokWebService.logout(),
    resetQuotaOnChange: true
  }
});

if (isDefaultProfile) {
  app.whenReady().then(() => {
    if (app.hasSingleInstanceLock()) launchExtraProfiles(app, defaultUserDataPath);
  });
}
