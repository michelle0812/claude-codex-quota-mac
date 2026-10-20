// Google (Antigravity / Gemini) 版的專屬設定：renderer-core.js 與 settings-core.js 都吃這一份。
// 共用邏輯全部在 src/shared-gen/（來源是 packages/shared/）。
window.APP_CONFIG = {
  brandName: "Google 主帳號",
  quotaGroupCycling: true,
  percentDigits: 2,
  compactThemeStorageKey: "googleUsageCompactTheme",
  emptyErrorCopyKey: "authRequired",

  // mini bar / HUD / 玻璃球的主色。Google 經典深藍與 Gemini 靛紫，一眼分得出來。
  accent: {
    weekly: "#1A73E8",
    weeklyStrong: "#4285F4",
    short: "#7C4DFF",
    shortStrong: "#B388FF"
  },

  copy: {
    zh: {
      brand: "Google 主帳號",
      statusLoading: "正在讀取 Google 用量...",
      statusError: "無法讀取 Google 用量",
      authRequired: "尚未連接 AGY 帳號，請按齒輪連接本機已登入的 AGY"
    },
    en: {
      brand: "Google Main Account",
      statusLoading: "Reading Google usage...",
      statusError: "Unable to read Google usage",
      authRequired: "Open settings to connect your signed-in local AGY account"
    }
  },

  // 設定視窗的「Google 帳號用量」區塊。
  auth: {
    quotaGroupChoice: false,
    label: "AGY 帳號用量",
    checkingText: "檢查登入狀態中…",
    loggedInText: "已連接 AGY 帳號；登入過期時請先回 AGY 更新登入",
    loggedOutText: "尚未連接；請先登入 AGY，再按連接本機 AGY",
    loginLabel: "連接 AGY 帳號",
    logoutLabel: "中斷連接",
    loginPendingText: "選擇 AGY 登入來源…",
    loginDoneText: "已連接此面板的 AGY 帳號",
    logoutDoneText: "已中斷此面板的連接，AGY 登入保留"
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
  if (profile.name) {
    config.brandName = profile.name;
    if (config.copy?.zh) config.copy.zh.brand = `Google · ${profile.name}`;
    if (config.copy?.en) config.copy.en.brand = `Google · ${profile.name}`;
    if (config.auth) config.auth.label = `Google 帳號（${profile.name}）`;
  }
  if (profile.extra) {
    if (config.copy?.zh) {
      config.copy.zh.authRequired = "尚未連接此面板的 AGY 帳號，請按齒輪 ⚙ 連接";
    }
    if (config.copy?.en) {
      config.copy.en.authRequired = "Open settings ⚙ to connect this panel's AGY account";
    }
  }
})(window.APP_CONFIG);
