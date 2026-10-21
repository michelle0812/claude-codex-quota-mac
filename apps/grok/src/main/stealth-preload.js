"use strict";

// 反機器人偵測（Stealth Preload）
// 確保 Cloudflare Turnstile 等驗證機制不會判定為自動化工具

try {
  // 1. 抹除 navigator.webdriver
  Object.defineProperty(Object.getPrototypeOf(navigator), "webdriver", {
    get: () => undefined,
    configurable: true
  });
  delete navigator.webdriver;
} catch {}

try {
  // 2. 模擬正常 Chrome 插件
  if (!navigator.plugins || navigator.plugins.length === 0) {
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
      configurable: true
    });
  }
} catch {}

try {
  // 3. 模擬 window.chrome 物件
  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false },
      runtime: {}
    };
  }
} catch {}
