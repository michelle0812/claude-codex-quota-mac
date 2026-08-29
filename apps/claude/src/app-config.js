// Claude 版的專屬設定：renderer-core.js 與 settings-core.js 都吃這一份。
// 共用邏輯全部在 src/shared-gen/（來源是 packages/shared/）。
window.APP_CONFIG = {
  brandName: "Claude 額度",
  compactThemeStorageKey: "claudeUsageCompactTheme",
  emptyErrorCopyKey: "authRequired",

  // mini bar / HUD / 玻璃球的主色。水藍色系，跟 Codex 版的綠色一眼分得出來。
  accent: {
    weekly: "#2694C8",
    weeklyStrong: "#52B9E0",
    short: "#7DD8F0",
    shortStrong: "#B0E9F8"
  },

  copy: {
    zh: {
      brand: "Claude 用量",
      statusLoading: "正在讀取 Claude 用量...",
      statusError: "無法讀取 Claude 用量",
      authRequired: "尚未偵測到 Claude Code 用量資料，請確認 statusLine hook 已安裝並跑過一次"
    },
    en: {
      brand: "Claude Usage",
      statusLoading: "Reading Claude usage...",
      statusError: "Unable to read Claude usage",
      authRequired: "Claude Code usage data not found - check the statusLine hook is installed"
    }
  },

  // 設定視窗的「claude.ai 帳號用量」區塊。Codex 版沒有這一段。
  auth: {
    label: "claude.ai 帳號用量",
    checkingText: "檢查登入狀態中…",
    loggedInText: "已登入：優先顯示 claude.ai 帳號用量",
    loggedOutText: "未登入：顯示本機 Claude Code 用量",
    loginLabel: "登入 claude.ai",
    logoutLabel: "登出",
    loginPendingText: "開啟 claude.ai 登入視窗…",
    loginDoneText: "已登入 claude.ai",
    logoutDoneText: "已登出 claude.ai"
  }
};
