"use strict";

// 薄殼：視窗、IPC、設定儲存等共用邏輯都在 shared-gen/main-core.js（來源是
// packages/shared/main-core.js）。這裡只負責組出 Claude 版專屬的 config。

const path = require("node:path");
const { startQuotaWidget } = require("../shared-gen/main-core");
const { getQuota: getLocalQuota } = require("./quota-service");
const claudeAiService = require("./claude-ai-service");

// 資料來源優先序：登入過 claude.ai 就先打帳號級別的網站 API（不受哪台機器在跑
// Claude Code 影響）；沒登入或抓失敗，退回讀本機 statusLine hook 落地的檔案。
async function readQuota(reason) {
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
  settingsWindowSize: { width: 360, height: 620 },
  auth: {
    configure: (userDataPath) => claudeAiService.configure(userDataPath),
    hasSession: () => claudeAiService.hasSession(),
    login: () => claudeAiService.login(),
    logout: () => claudeAiService.logout()
  }
});
