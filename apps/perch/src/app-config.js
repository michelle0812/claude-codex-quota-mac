window.APP_CONFIG = {
  "brandName": "Perch 額度",
  "quotaGroupCycling": true,
  "quotaGroupStorageKey": "perchQuotaSelectedGroup",
  "groupSwitchHint": {
    "zh": "點擊切換額度類別",
    "en": "Click to switch allowance"
  },
  "percentDigits": 1,
  "compactThemeStorageKey": "perchUsageCompactTheme",
  "emptyErrorCopyKey": "authRequired",
  "accent": {
    "weekly": "#2DD4BF",
    "weeklyStrong": "#5EEAD4",
    "short": "#FBBF24",
    "shortStrong": "#FDE68A"
  },
  "copy": {
    "zh": {
      "brand": "Perch 額度",
      "paceTitle": "額度概況",
      "statusLoading": "正在讀取 Perch 用量…",
      "statusError": "無法讀取 Perch 用量",
      "authRequired": "請先在終端機執行 perch login，再按齒輪連接",
      "reset": "下次釋出",
      "resetting": "等待官方更新",
      "noReset": "未提供釋出時間"
    },
    "en": {
      "brand": "Perch Quota",
      "paceTitle": "Allowance overview",
      "statusLoading": "Reading Perch usage…",
      "statusError": "Unable to read Perch usage",
      "authRequired": "Run perch login in Terminal, then connect in settings",
      "reset": "Next release",
      "resetting": "Awaiting usage update",
      "noReset": "Release time unavailable"
    }
  },
  "auth": {
    "label": "Perch CLI 帳號",
    "checkingText": "檢查本機 CLI 登入…",
    "loggedInText": "已連接本機 CLI；點圓球切換 Roost、Manual 與本期 PT",
    "loggedOutText": "請先在終端機執行 perch login，再連接面板",
    "loginLabel": "連接本機 Perch CLI",
    "logoutLabel": "中斷面板連接",
    "loginPendingText": "讀取本機 CLI 登入…",
    "loginDoneText": "已連接本機 Perch CLI",
    "logoutDoneText": "已中斷面板連接；CLI 登入不受影響"
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
