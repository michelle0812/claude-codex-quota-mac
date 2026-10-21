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
      authRequired: "尚未連接 Grok 帳號，請在終端執行 grok login 或按齒輪連接本機 Grok"
    },
    en: {
      brand: "Grok Quota",
      statusLoading: "Reading Grok usage...",
      statusError: "Unable to read Grok usage",
      authRequired: "Run grok login in terminal or open settings to connect your local Grok"
    }
  },

  // 設定視窗的「Grok 帳號用量」區塊。
  auth: {
    quotaGroupChoice: false,
    label: "Grok 帳號用量",
    checkingText: "檢查登入狀態中…",
    loggedInText: "已連接本機 Grok；登入過期時請先執行 grok login",
    loggedOutText: "尚未連接；請先在終端機執行 grok login，再按連接本機 Grok",
    loginLabel: "連接 Grok 帳號",
    logoutLabel: "中斷連接",
    loginPendingText: "正在讀取本機 Grok 憑證…",
    loginDoneText: "已連接此面板的 Grok 帳號",
    logoutDoneText: "已中斷此面板的連接，本機 Grok 登入保留"
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
