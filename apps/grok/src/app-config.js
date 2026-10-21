// Grok (xAI) 版的專屬設定：renderer-core.js 與 settings-core.js 都吃這一份。
// 共用邏輯全部在 src/shared-gen/（來源是 packages/shared/）。
window.APP_CONFIG = {
  brandName: "Grok 額度",
  quotaGroupCycling: false,
  percentDigits: 0,
  compactThemeStorageKey: "grokUsageCompactTheme",
  emptyErrorCopyKey: "authRequired",

  // mini bar / HUD / 玻璃球的主色。xAI 科技流光銀白與極速電光橙。
  accent: {
    weekly: "#F3F4F6",
    weeklyStrong: "#FFFFFF",
    short: "#F97316",
    shortStrong: "#FB923C"
  },

  copy: {
    zh: {
      brand: "Grok 額度",
      statusLoading: "正在讀取 Grok 用量...",
      statusError: "無法讀取 Grok 用量",
      authRequired: "尚未登入 Grok，請按齒輪登入 grok.com 或在終端執行 grok login"
    },
    en: {
      brand: "Grok Quota",
      statusLoading: "Reading Grok usage...",
      statusError: "Unable to read Grok usage",
      authRequired: "Open settings to sign in to grok.com or run grok login in terminal"
    }
  },

  // 設定視窗的「grok.com 帳號用量」區塊。
  auth: {
    label: "grok.com 帳號用量",
    checkingText: "檢查登入狀態中…",
    loggedInText: "已登入：優先顯示 grok.com 帳號用量與 7 天算力池",
    loggedOutText: "未登入：顯示本機 Grok 用量；點擊登入以同步 7 天官方算力池",
    loginLabel: "登入 grok.com",
    logoutLabel: "登出 grok.com",
    loginPendingText: "正在開啟 grok.com 登入視窗…",
    loginDoneText: "已登入 grok.com",
    logoutDoneText: "已登出 grok.com，恢復顯示本機 Grok 用量"
  }
};

// 多帳號：main.js 會把這個 profile 的名稱／主色塞在網址 ?profile=<JSON>。
(function applyProfileOverrides(config) {
  if (typeof location === "undefined") return;
  let profile;
  try {
    profile = JSON.parse(new URLSearchParams(location.search).get("profile") || "null");
  } catch {
    return;
  }
  if (!profile || typeof profile !== "object") return;

  const hex = /^#[0-9a-fA-F]{6}$/;
  if (profile.name && typeof profile.name === "string") {
    config.brandName = profile.name;
    if (config.copy?.zh) config.copy.zh.brand = profile.name;
    if (config.copy?.en) config.copy.en.brand = profile.name;
  }
  if (
    profile.accent &&
    typeof profile.accent === "object" &&
    hex.test(profile.accent.weekly) &&
    hex.test(profile.accent.weeklyStrong) &&
    hex.test(profile.accent.short) &&
    hex.test(profile.accent.shortStrong)
  ) {
    config.accent = profile.accent;
  }
})(window.APP_CONFIG);
