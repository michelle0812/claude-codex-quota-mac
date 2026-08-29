// 兩個 app 共用的 preload。兩邊的 main.js 都直接把 webPreferences.preload 指到這個檔。
//
// renderer 一律用 window.quotaBridge，不再分 claudeUsage / codexQuota，
// 這樣 renderer-core.js 與 settings-core.js 才能整份共用。
//
// !!! 這個檔案只能 require("electron") !!!
// Electron 的 preload 跑在 sandbox 裡，require() 只支援 electron 與少數內建模組。
// 載入自己寫的相對路徑檔案會直接失敗，而且是靜靜地失敗：preload 整份不執行 ->
// window.quotaBridge 變成 undefined -> renderer 一開就 throw -> 畫面看得到但拖拉、
// 縮放、每個按鈕全部沒反應。所以這裡必須自給自足，不要為了「共用」再拆一層。
// scripts/verify-preload.js 會擋住這種寫法。
//
// auth:* 這幾支兩個 app 都會曝露，但只有在 main 行程註冊了 auth 處理器的 app
// （Claude）才會真的被呼叫；Codex 的 APP_CONFIG.auth 是 null，settings-core
// 根本不會去碰它們。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotaBridge", {
  getQuotaState: () => ipcRenderer.invoke("quota:state"),
  refreshQuota: () => ipcRenderer.invoke("quota:refresh"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  openSettings: () => ipcRenderer.invoke("window:openSettings"),
  closeSettings: () => ipcRenderer.invoke("window:closeSettings"),
  getAlwaysOnTop: () => ipcRenderer.invoke("window:alwaysOnTop:get"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:alwaysOnTop:set", value),
  getCompactMode: () => ipcRenderer.invoke("window:compact:get"),
  setCompactMode: (value) => ipcRenderer.invoke("window:compact:set", value),
  getCompactScale: () => ipcRenderer.invoke("window:compactScale:get"),
  setCompactScale: (value) => ipcRenderer.invoke("window:compactScale:set", value),
  moveCompactWindow: (deltaX, deltaY) => ipcRenderer.invoke("window:compactMove", deltaX, deltaY),
  snapCompactWindow: () => ipcRenderer.invoke("window:compactSnap"),
  setCompactExpanded: (value) => ipcRenderer.invoke("window:compactExpanded:set", value),
  getCompactDisplayMode: () => ipcRenderer.invoke("window:compactDisplayMode:get"),
  setCompactMousePassthrough: (value) => ipcRenderer.invoke("window:compactMousePassthrough:set", value),
  getCursorState: () => ipcRenderer.invoke("window:cursorState:get"),
  getSignalSettings: () => ipcRenderer.invoke("signal:settings:get"),
  setSignalSettings: (settings) => ipcRenderer.invoke("signal:settings:set", settings),
  resetSignalSettings: () => ipcRenderer.invoke("signal:settings:reset"),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  login: () => ipcRenderer.invoke("auth:login"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  onQuotaChanged: (callback) => {
    ipcRenderer.on("quota:changed", (_event, value) => callback(value));
  },
  onAlwaysOnTopChanged: (callback) => {
    ipcRenderer.on("window:alwaysOnTopChanged", (_event, value) => callback(value));
  },
  onCompactChanged: (callback) => {
    ipcRenderer.on("window:compactChanged", (_event, value) => callback(value));
  },
  onCompactScaleChanged: (callback) => {
    ipcRenderer.on("window:compactScaleChanged", (_event, value) => callback(value));
  },
  onCompactDisplayModeChanged: (callback) => {
    ipcRenderer.on("window:compactDisplayModeChanged", (_event, value) => callback(value));
  },
  onSignalSettingsChanged: (callback) => {
    ipcRenderer.on("signal:settingsChanged", (_event, value) => callback(value));
  },
  onAuthStatusChanged: (callback) => {
    ipcRenderer.on("auth:statusChanged", (_event, value) => callback(value));
  }
});
