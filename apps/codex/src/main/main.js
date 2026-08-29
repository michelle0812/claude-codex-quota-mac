"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡只負責組出 Codex 版專屬的 config。
// Codex 沒有帳號登入功能，所以 auth 傳 null。

const path = require("node:path");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { getQuota } = require("./quota-service");

startQuotaWidget({
  appIconPath: path.join(__dirname, "../../assets/app-icon.png"),
  preloadPath: path.join(__dirname, "../shared-gen/preload.js"),
  rendererHtmlPath: path.join(__dirname, "../shared-gen/renderer.html"),
  settingsHtmlPath: path.join(__dirname, "../shared-gen/settings.html"),
  readQuota: getQuota,
  settingsWindowSize: { width: 360, height: 500 },
  auth: null
});
