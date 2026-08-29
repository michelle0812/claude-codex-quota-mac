// Codex 版的專屬設定：renderer-core.js 與 settings-core.js 都吃這一份。
// 共用邏輯全部在 src/shared-gen/（來源是 packages/shared/）。
window.APP_CONFIG = {
  brandName: "Codex 額度",
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
      brand: "Codex 額度",
      statusLoading: "正在讀取 Codex 額度...",
      statusError: "無法讀取 Codex 額度",
      authRequired: "Codex CLI 需要登入後才能讀取額度"
    },
    en: {
      brand: "Codex Quota",
      statusLoading: "Reading Codex quota...",
      statusError: "Unable to read Codex quota",
      authRequired: "Codex CLI must be signed in before quota can be read"
    }
  },

  // Codex 版沒有帳號登入功能，設定視窗不會出現帳號區塊。
  auth: null
};
