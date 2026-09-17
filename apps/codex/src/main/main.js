"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡只負責組出 Codex 版專屬的 config。
// 設定視窗（齒輪）的帳號區塊由 codex-auth-service.js 提供：App 內登入 ChatGPT，寫進該 profile 的 auth.json。
//
// 多帳號：一個 profile 一個行程（見 profile.js）。default 行程啟動後會把
// profiles.json 裡的其他帳號各帶起一份；已經在跑的會被 single-instance lock 擋掉。

const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { getQuota, resolveAuthFilePath } = require("./quota-service");
const { createCodexAuth } = require("./codex-auth-service");
const { DEFAULT_PROFILE_ID, resolveProfile, listExtraProfileIds } = require("./profile");

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

startQuotaWidget({
  appIconPath: path.join(__dirname, "../../assets/app-icon.png"),
  preloadPath: path.join(__dirname, "../shared-gen/preload.js"),
  rendererHtmlPath: path.join(__dirname, "../shared-gen/renderer.html"),
  settingsHtmlPath: path.join(__dirname, "../shared-gen/settings.html"),
  readQuota: () => getQuota({ authFilePath: profile.authFilePath }),
  settingsWindowTitle: profile.name ? `小工具設定 · ${profile.name}` : undefined,
  settingsWindowSize: { width: 360, height: 640 },
  rendererQuery,
  auth: codexAuth
});

if (profile.id === DEFAULT_PROFILE_ID) {
  app.whenReady().then(launchExtraProfiles);
}

function launchExtraProfiles() {
  const ids = listExtraProfileIds(defaultUserDataPath);
  for (const id of ids) {
    try {
      launchProfile(id);
    } catch (error) {
      console.warn(`帶起 profile ${id} 失敗：${error.message}`);
    }
  }
}

function launchProfile(id) {
  const args = [`--profile=${id}`];
  if (app.isPackaged) {
    // .../Codex 額度.app/Contents/MacOS/Codex 額度 → .../Codex 額度.app
    const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
    spawn("/usr/bin/open", ["-n", "-a", bundlePath, "--args", ...args], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  // npm start：直接用同一顆 electron 再開一份。
  spawn(process.execPath, [app.getAppPath(), ...args], { detached: true, stdio: "ignore" }).unref();
}
