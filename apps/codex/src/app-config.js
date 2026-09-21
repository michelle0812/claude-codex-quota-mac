// Codex 版的專屬設定：renderer-core.js 與 settings-core.js 都吃這一份。
// 共用邏輯全部在 src/shared-gen/（來源是 packages/shared/）。
window.APP_CONFIG = {
  brandName: "Codex 主帳號",
  compactThemeStorageKey: "codexQuotaCompactTheme",
  emptyErrorCopyKey: "unknown",

  // mini bar / HUD / 玻璃球的主色。綠色系，跟 Claude 版的水藍一眼分得出來。
  accent: {
    weekly: "#25985F",
    weeklyStrong: "#45C286",
    short: "#65E08D",
    shortStrong: "#9BEEB6"
  },

  copy: {
    zh: {
      brand: "Codex 主帳號",
      statusLoading: "正在讀取 Codex 額度...",
      statusError: "無法讀取 Codex 額度",
      authRequired: "尚未登入 ChatGPT，請按齒輪 ⚙ 登入"
    },
    en: {
      brand: "Codex Main Account",
      statusLoading: "Reading Codex quota...",
      statusError: "Unable to read Codex quota",
      authRequired: "Not signed in to ChatGPT - open settings ⚙ to sign in"
    }
  },

  // 設定視窗（齒輪）的帳號區塊：App 內登入 ChatGPT，每個面板各登各的帳號。
  auth: {
    label: "ChatGPT 帳號",
    checkingText: "檢查登入狀態中…",
    loggedInText: "已登入：面板顯示這個帳號的 Codex 用量",
    loggedOutText: "未登入：按「登入 ChatGPT」選擇要看的帳號",
    loginLabel: "登入 ChatGPT",
    logoutLabel: "登出",
    loginPendingText: "請在跳出的視窗登入 ChatGPT…",
    loginDoneText: "已登入 ChatGPT",
    logoutDoneText: "已登出（舊登入檔已改名保留）"
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
    config.brandName = `Codex · ${name}`;
    config.copy.zh.brand = `Codex · ${name}`;
    config.copy.en.brand = `Codex · ${name}`;
    config.auth.label = `ChatGPT 帳號（${name}）`;
  }
})(window.APP_CONFIG);
