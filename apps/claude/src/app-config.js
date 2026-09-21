// Claude 版的專屬設定：renderer-core.js 與 settings-core.js 都吃這一份。
// 共用邏輯全部在 src/shared-gen/（來源是 packages/shared/）。
window.APP_CONFIG = {
  brandName: "Claude 主帳號",
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
      brand: "Claude 主帳號",
      statusLoading: "正在讀取 Claude 用量...",
      statusError: "無法讀取 Claude 用量",
      authRequired: "尚未偵測到 Claude Code 用量資料，請確認 statusLine hook 已安裝並跑過一次"
    },
    en: {
      brand: "Claude Main Account",
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

// 多帳號：main.js 會把這個 profile 的名稱／主色塞在網址 ?profile=<JSON>。
// 這段同步執行，renderer-core.js 一開場套主色時就已經是這個帳號的顏色。
(function applyProfileOverrides(config) {
  if (typeof location === "undefined") return; // verify-app-config.js 在 vm 裡跑，沒有 location
  let profile;
  try {
    profile = JSON.parse(new URLSearchParams(location.search).get("profile") || "null");
  } catch {
    return;
  }
  if (!profile || typeof profile !== "object") return;

  const hex = /^#[0-9a-fA-F]{6}$/;
  const accent = profile.accent;
  if (accent && ["weekly", "weeklyStrong", "short", "shortStrong"].every((key) => hex.test(String(accent[key])))) {
    config.accent = { weekly: accent.weekly, weeklyStrong: accent.weeklyStrong, short: accent.short, shortStrong: accent.shortStrong };
  }

  const name = typeof profile.name === "string" ? profile.name.trim() : "";
  if (name) {
    config.brandName = `Claude · ${name}`;
    config.copy.zh.brand = `Claude · ${name}`;
    config.copy.en.brand = `Claude · ${name}`;
    config.auth.label = `claude.ai 帳號（${name}）`;
  }

  // 額外帳號只看 claude.ai，沒有本機 statusLine 可以退回。
  if (profile.extra) {
    config.copy.zh.authRequired = "尚未登入 claude.ai，請按齒輪 ⚙ 登入";
    config.copy.en.authRequired = "Not signed in to claude.ai - open settings ⚙ to sign in";
    config.auth.loggedInText = "已登入：面板顯示這個 claude.ai 帳號的用量";
    config.auth.loggedOutText = "未登入：按「登入 claude.ai」選擇要看的帳號";
  }
})(window.APP_CONFIG);
