"use strict";

// 兩個 app 共用的主行程核心。
//
// 差異全部靠 startQuotaWidget(config) 注入，app 端的 src/main/main.js 只負責
// 組出 config：圖示路徑、資料來源 readQuota、以及選用的帳號登入 provider。
// 沒有帳號功能的 app（Codex）把 config.auth 傳成 null 即可，
// 相關的 IPC 與設定視窗欄位就不會註冊。

const { app, BrowserWindow, ipcMain, screen, shell, Notification } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { applyDockVisibility } = require("./dock-visibility");
const { QuotaStore } = require("./quota-store");
const { DEFAULT_WIDGET_SETTINGS, normalizeWidgetSettings } = require("./widget-settings");
const { COMPACT_LAYOUT } = require("./compact-layout");
const { isNewerVersion, msUntilNextWeeklySlot, fetchLatestRelease, RELEASES_PAGE } = require("./update-check");

// 更新檢查：只提醒，不下載、不自動安裝。檢查時機＝App 每次啟動 + 每週一 10:00（台灣時間）。
const UPDATE_REPO = "michelle0812/claude-codex-quota-mac";
let updateState = {
  checking: false,
  updateAvailable: false,
  currentVersion: null,
  latestVersion: null,
  releaseUrl: RELEASES_PAGE(UPDATE_REPO),
  lastCheckedAt: null,
  error: null
};
let updateTimer = null;
let notifiedForVersion = null;

const HIDDEN_WINDOW_RELEASE_MS = 60 * 1000;
const SETTINGS_FILE_NAME = "widget-settings.json";

const WINDOW_SIZES = {
  full: { width: 390, height: 336 }
};

const COMPACT_HUD_COLLAPSED_BASE_SIZE = { width: COMPACT_LAYOUT.width, height: COMPACT_LAYOUT.hud.collapsedHeight };
const COMPACT_HUD_EXPANDED_BASE_SIZE = { width: COMPACT_LAYOUT.width, height: COMPACT_LAYOUT.hud.expandedHeight };
const COMPACT_STRIP_COLLAPSED_BASE_SIZE = { width: COMPACT_LAYOUT.width, height: COMPACT_LAYOUT.topStrip.collapsedHeight };
const COMPACT_STRIP_EXPANDED_BASE_SIZE = { width: COMPACT_LAYOUT.width, height: COMPACT_LAYOUT.topStrip.expandedHeight };
const COMPACT_SCALE_LIMITS = COMPACT_LAYOUT.scale;
const COMPACT_TOP_OFFSET = 6;
const COMPACT_TOP_SNAP_DISTANCE = 28;
const COMPACT_CENTER_SNAP_DISTANCE = 48;
const COMPACT_STRIP_TOP_OFFSET = 0;
const COMPACT_STRIP_TOP_SNAP_DISTANCE = 4;
const COMPACT_STRIP_CENTER_SNAP_DISTANCE = 56;

let config;
let mainWindow;
let settingsWindow;
let quotaStore;
let releaseWindowTimer;
let ipcHandlersRegistered = false;
let isQuitting = false;
let isAlwaysOnTop = true;
let isCompactMode = false;
let compactScale = COMPACT_SCALE_LIMITS.min;
let isCompactExpanded = false;
let isCompactTopStrip = false;
let isCompactMousePassthrough = false;
let signalSettings = { ...DEFAULT_WIDGET_SETTINGS };

function normalizeConfig(raw) {
  const required = ["appIconPath", "preloadPath", "rendererHtmlPath", "settingsHtmlPath", "readQuota"];
  for (const key of required) {
    if (!raw?.[key]) throw new Error(`startQuotaWidget: config.${key} 是必填的`);
  }
  if (typeof raw.readQuota !== "function") {
    throw new Error("startQuotaWidget: config.readQuota 必須是函式");
  }
  return {
    appIconPath: raw.appIconPath,
    preloadPath: raw.preloadPath,
    rendererHtmlPath: raw.rendererHtmlPath,
    settingsHtmlPath: raw.settingsHtmlPath,
    readQuota: raw.readQuota,
    settingsWindowTitle: raw.settingsWindowTitle || "小工具設定",
    settingsWindowSize: {
      width: raw.settingsWindowSize?.width || 360,
      height: raw.settingsWindowSize?.height || (raw.auth ? 550 : 500)
    },
    auth: raw.auth || null
  };
}

// app 端唯一的進入點。
function startQuotaWidget(rawConfig) {
  config = normalizeConfig(rawConfig);

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  app.on("second-instance", showWindow);
  app.whenReady().then(startApp);

  app.on("before-quit", () => {
    isQuitting = true;
    cancelWindowRelease();
    clearTimeout(updateTimer);
    quotaStore?.destroy();
  });

  app.on("window-all-closed", (event) => {
    if (!isQuitting) event.preventDefault();
  });
}

function clampCompactScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(COMPACT_SCALE_LIMITS.max, Math.max(COMPACT_SCALE_LIMITS.min, scale));
}

function compactDisplayMode() {
  return isCompactTopStrip ? "topStrip" : "hud";
}

function compactBaseSize(expanded = isCompactExpanded, topStrip = isCompactTopStrip) {
  if (topStrip) {
    return expanded ? COMPACT_STRIP_EXPANDED_BASE_SIZE : COMPACT_STRIP_COLLAPSED_BASE_SIZE;
  }
  return expanded ? COMPACT_HUD_EXPANDED_BASE_SIZE : COMPACT_HUD_COLLAPSED_BASE_SIZE;
}

function scaledCompactSize(scale = compactScale, expanded = isCompactExpanded, topStrip = isCompactTopStrip) {
  const safeScale = clampCompactScale(scale);
  const baseSize = compactBaseSize(expanded, topStrip);
  return {
    width: Math.round(baseSize.width * safeScale),
    height: Math.round(baseSize.height * safeScale)
  };
}

function compactMinimumSize(topStrip = isCompactTopStrip) {
  return scaledCompactSize(COMPACT_SCALE_LIMITS.min, false, topStrip);
}

async function startApp() {
  signalSettings = await loadSignalSettings();
  updateDockVisibility(signalSettings.showInDock);
  await config.auth?.configure?.(app.getPath("userData"));
  quotaStore = new QuotaStore({
    userDataPath: app.getPath("userData"),
    readQuota: config.readQuota,
    visibleRefreshIntervalMs: signalSettings.quotaRefreshMs
  });
  await quotaStore.loadCache();
  quotaStore.on("state", (state) => sendToWindow("quota:changed", state));

  registerIpcHandlers();
  createWindow();
  quotaStore.refreshNow("startup").catch(() => {});

  applyAutoUpdatePreference(signalSettings.autoUpdateCheck);

  app.on("activate", showWindow);
}

// ---- 更新檢查 ----

function broadcastUpdateState() {
  sendToWindow("update:stateChanged", updateState);
}

async function runUpdateCheck({ notify } = {}) {
  if (updateState.checking) return updateState;
  updateState = { ...updateState, checking: true, error: null };
  broadcastUpdateState();
  try {
    const latest = await fetchLatestRelease(UPDATE_REPO);
    const current = app.getVersion();
    const available = isNewerVersion(latest.version, current);
    updateState = {
      ...updateState,
      checking: false,
      updateAvailable: available,
      currentVersion: current,
      latestVersion: latest.version,
      releaseUrl: latest.url || RELEASES_PAGE(UPDATE_REPO),
      lastCheckedAt: Date.now(),
      error: null
    };
    if (available && notify && notifiedForVersion !== latest.version) {
      notifiedForVersion = latest.version;
      showUpdateNotification(latest.version);
    }
  } catch (error) {
    // 離線 / API 失敗：安靜記錄，不打擾使用者。
    updateState = {
      ...updateState,
      checking: false,
      lastCheckedAt: Date.now(),
      error: error.message
    };
  }
  broadcastUpdateState();
  return updateState;
}

function showUpdateNotification(version) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `${config.productName || app.getName()} 有新版本`,
    body: `發現 v${version}，點此前往 GitHub 下載（不會自動更新）。`
  });
  notification.on("click", () => {
    shell.openExternal(updateState.releaseUrl || RELEASES_PAGE(UPDATE_REPO)).catch(() => {});
  });
  notification.show();
}

function scheduleWeeklyUpdateCheck() {
  clearTimeout(updateTimer);
  // 每週一 10:00 台灣時間（UTC+8，無日光節約）
  const delay = msUntilNextWeeklySlot(Date.now(), { weekday: 1, hour: 10, minute: 0, tzOffsetMinutes: 480 });
  updateTimer = setTimeout(() => {
    runUpdateCheck({ notify: true }).finally(scheduleWeeklyUpdateCheck);
  }, delay);
}

function applyAutoUpdatePreference(enabled) {
  if (enabled) {
    scheduleWeeklyUpdateCheck();
    runUpdateCheck({ notify: true }).catch(() => {});
  } else {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
}

function createWindow() {
  const existingWindow = getLiveWindow();
  if (existingWindow) return existingWindow;

  const initialSize = isCompactMode ? scaledCompactSize() : WINDOW_SIZES.full;
  const minCompactSize = compactMinimumSize();
  const window = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: minCompactSize.width,
    minHeight: minCompactSize.height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: isCompactMode,
    show: false,
    backgroundColor: "#00000000",
    icon: config.appIconPath,
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  mainWindow = window;
  window.setHasShadow(!isCompactMode);

  window.webContents.on("did-finish-load", () => {
    window.webContents.send("quota:changed", quotaStore.getState());
    window.webContents.send("window:alwaysOnTopChanged", isAlwaysOnTop);
    window.webContents.send("window:compactChanged", isCompactMode);
    window.webContents.send("window:compactScaleChanged", compactScale);
    window.webContents.send("window:compactDisplayModeChanged", compactDisplayMode());
    window.webContents.send("signal:settingsChanged", signalSettings);
  });

  window.once("ready-to-show", async () => {
    if (window.isDestroyed()) return;
    window.show();
    // 先把尺寸交給模式邏輯處理（compact 需要），位置能還原就還原、不能就走預設歸位。
    if (isCompactMode) {
      setCompactTopStrip(false);
      isCompactExpanded = false;
      resizeCompactWindow(window);
    }
    const restored = await restoreWindowBounds(window).catch(() => false);
    if (!restored) placeWindow(window);
  });

  const onBoundsChanged = () => scheduleSaveWindowBounds(window);
  window.on("moved", onBoundsChanged);
  window.on("resize", onBoundsChanged);
  window.on("close", () => flushSaveWindowBounds(window));

  window.on("show", () => {
    cancelWindowRelease();
    quotaStore.setWindowVisible(true);
    quotaStore.refreshNow("window-show").catch(() => {});
  });

  window.on("hide", () => {
    quotaStore.setWindowVisible(false);
    scheduleWindowRelease();
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.loadFile(config.rendererHtmlPath);
  return window;
}

function placeWindow(window = getLiveWindow()) {
  if (!window) return;
  if (isCompactMode) {
    setCompactTopStrip(false);
    isCompactExpanded = false;
    resizeCompactWindow(window);
    placeCompactWindowTopCenter(window);
  } else {
    placeWindowTopRight(window);
  }
}

function placeCompactWindowTopCenter(window = getLiveWindow()) {
  if (!window) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = window.getBounds();
  const { workArea } = display;
  window.setBounds({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + COMPACT_TOP_OFFSET,
    width,
    height
  });
}

function resizeCompactWindow(window = getLiveWindow(), expanded = isCompactExpanded) {
  if (!window) return null;
  const bounds = window.getBounds();
  const size = scaledCompactSize(compactScale, expanded);
  const minSize = compactMinimumSize();
  window.setMinimumSize(1, 1);
  window.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: size.width,
    height: size.height
  });
  window.setContentSize(size.width, size.height, false);
  window.setMinimumSize(minSize.width, minSize.height);
  return size;
}

function placeWindowTopRight(window = getLiveWindow()) {
  if (!window) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = window.getBounds();
  const { workArea } = display;
  window.setBounds({
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    width,
    height
  });
}

function openSignalSettingsWindow() {
  const parent = getLiveWindow();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    placeSettingsWindow(settingsWindow, parent);
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: config.settingsWindowSize.width,
    height: config.settingsWindowSize.height,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    show: false,
    title: config.settingsWindowTitle,
    backgroundColor: "#111418",
    icon: config.appIconPath,
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.webContents.on("did-finish-load", () => {
    sendToSettingsWindow("signal:settingsChanged", signalSettings);
    if (!config.auth) return;
    Promise.resolve(config.auth.hasSession())
      .then((loggedIn) => sendToSettingsWindow("auth:statusChanged", loggedIn))
      .catch(() => {});
  });
  settingsWindow.once("ready-to-show", () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    placeSettingsWindow(settingsWindow, parent);
    settingsWindow.show();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(config.settingsHtmlPath);
  return settingsWindow;
}

function placeSettingsWindow(window, parent = getLiveWindow()) {
  if (!window || window.isDestroyed() || !parent || parent.isDestroyed()) return;

  const parentBounds = parent.getBounds();
  const windowBounds = window.getBounds();
  const { workArea } = screen.getDisplayMatching(parentBounds);
  const centeredX = parentBounds.x + Math.round((parentBounds.width - windowBounds.width) / 2);
  const centeredY = parentBounds.y + Math.round((parentBounds.height - windowBounds.height) / 2);
  const maxX = workArea.x + Math.max(0, workArea.width - windowBounds.width);
  const maxY = workArea.y + Math.max(0, workArea.height - windowBounds.height);

  window.setPosition(
    Math.min(maxX, Math.max(workArea.x, centeredX)),
    Math.min(maxY, Math.max(workArea.y, centeredY)),
    false
  );
}

function registerIpcHandlers() {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.handle("quota:state", () => quotaStore.getState());
  ipcMain.handle("quota:refresh", () => quotaStore.refreshNow("manual"));
  ipcMain.handle("window:minimize", hideWindow);
  ipcMain.handle("window:close", quitApp);
  ipcMain.handle("window:openSettings", () => {
    openSignalSettingsWindow();
  });
  ipcMain.handle("window:closeSettings", () => {
    const window = settingsWindow;
    setImmediate(() => {
      if (window && !window.isDestroyed()) window.close();
    });
    return true;
  });
  ipcMain.handle("window:alwaysOnTop:get", () => isAlwaysOnTop);
  ipcMain.handle("window:alwaysOnTop:set", (_event, value) => setAlwaysOnTop(value));
  ipcMain.handle("window:compact:get", () => isCompactMode);
  ipcMain.handle("window:compact:set", (_event, value) => setCompactMode(value));
  ipcMain.handle("window:compactScale:get", () => compactScale);
  ipcMain.handle("window:compactScale:set", (_event, value) => setCompactScale(value));
  ipcMain.handle("window:compactMove", (_event, deltaX, deltaY) => moveCompactWindow(deltaX, deltaY));
  ipcMain.handle("window:compactSnap", () => snapCompactWindow());
  ipcMain.handle("window:compactExpanded:set", (_event, value) => setCompactExpanded(value));
  ipcMain.handle("window:compactDisplayMode:get", () => compactDisplayMode());
  ipcMain.handle("window:compactMousePassthrough:set", (_event, value) => setCompactMousePassthrough(value));
  ipcMain.handle("window:cursorState:get", () => getCursorState());
  ipcMain.handle("signal:settings:get", () => signalSettings);
  ipcMain.handle("signal:settings:set", (_event, settings) => setSignalSettings(settings));
  ipcMain.handle("signal:settings:reset", () => setSignalSettings(DEFAULT_WIDGET_SETTINGS));

  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("update:check", () => runUpdateCheck({ notify: true }));
  ipcMain.handle("update:state", () => updateState);
  ipcMain.handle("update:openRelease", () =>
    shell.openExternal(updateState.releaseUrl || RELEASES_PAGE(UPDATE_REPO))
  );

  if (!config.auth) return;
  ipcMain.handle("auth:status", () => config.auth.hasSession());
  ipcMain.handle("auth:login", () => loginAuthProvider());
  ipcMain.handle("auth:logout", () => logoutAuthProvider());
}

async function loginAuthProvider() {
  const result = await config.auth.login();
  broadcastAuthStatus(true);
  await refreshQuotaQuietly("auth-login");
  return result;
}

async function logoutAuthProvider() {
  await config.auth.logout();
  broadcastAuthStatus(false);
  await refreshQuotaQuietly("auth-logout");
  return true;
}

async function refreshQuotaQuietly(reason) {
  if (!quotaStore) return;
  try {
    await quotaStore.refreshNow(reason);
  } catch {
    /* 重新整理失敗不影響登入／登出結果 */
  }
}

function broadcastAuthStatus(loggedIn) {
  sendToWindow("auth:statusChanged", loggedIn);
  sendToSettingsWindow("auth:statusChanged", loggedIn);
}

async function readSettingsFile() {
  try {
    const payload = JSON.parse(await fs.readFile(settingsPath(), "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Failed to read widget settings: ${error.message}`);
    }
    return {};
  }
}

async function writeSettingsFile(patch) {
  const filePath = settingsPath();
  const current = await readSettingsFile();
  const payload = { version: 1, ...current, ...patch };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadSignalSettings() {
  const payload = await readSettingsFile();
  return normalizeWidgetSettings(payload?.signal);
}

function settingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

async function setSignalSettings(settings) {
  const previous = signalSettings;
  signalSettings = normalizeWidgetSettings(settings);
  quotaStore?.setVisibleRefreshIntervalMs(signalSettings.quotaRefreshMs);
  updateDockVisibility(signalSettings.showInDock);
  if (signalSettings.autoUpdateCheck !== previous?.autoUpdateCheck) {
    applyAutoUpdatePreference(signalSettings.autoUpdateCheck);
  }
  await saveSignalSettings();
  sendToWindow("signal:settingsChanged", signalSettings);
  sendToSettingsWindow("signal:settingsChanged", signalSettings);
  return signalSettings;
}

function updateDockVisibility(showInDock) {
  applyDockVisibility(app.dock, showInDock, (error) => {
    console.warn(`Failed to update Dock visibility: ${error.message}`);
  });
}

async function saveSignalSettings() {
  await writeSettingsFile({ signal: signalSettings });
}

// ── 視窗位置記憶 ──────────────────────────────────────────────
// full / compact 兩種模式各存一組 bounds 進 widget-settings.json 的 windowBounds。
// 重開時先試著還原；螢幕拔掉或位置跑出可視範圍就退回預設歸位。

let saveWindowBoundsTimer = null;

function currentWindowModeKey() {
  return isCompactMode ? "compact" : "full";
}

async function loadWindowBounds() {
  const payload = await readSettingsFile();
  const bounds = payload?.windowBounds;
  return bounds && typeof bounds === "object" ? bounds : {};
}

function persistWindowBounds(window = getLiveWindow()) {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getBounds();
  const modeKey = currentWindowModeKey();
  loadWindowBounds()
    .then((saved) => writeSettingsFile({ windowBounds: { ...saved, [modeKey]: bounds } }))
    .catch((error) => console.warn(`Failed to persist window bounds: ${error.message}`));
}

function scheduleSaveWindowBounds(window = getLiveWindow()) {
  clearTimeout(saveWindowBoundsTimer);
  saveWindowBoundsTimer = setTimeout(() => persistWindowBounds(window), 400);
}

function flushSaveWindowBounds(window = getLiveWindow()) {
  clearTimeout(saveWindowBoundsTimer);
  saveWindowBoundsTimer = null;
  persistWindowBounds(window);
}

// 這個矩形有沒有「夠多」落在某個現有螢幕的工作區內（避免還原到已拔掉的螢幕或畫面外）。
function boundsAreVisible(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return false;
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  const area = bounds.width * bounds.height;
  for (const display of screen.getAllDisplays()) {
    const wa = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x));
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y));
    if (overlapX * overlapY >= area * 0.4) return true;
  }
  return false;
}

async function restoreWindowBounds(window = getLiveWindow()) {
  if (!window || window.isDestroyed()) return false;
  const saved = await loadWindowBounds();
  const target = saved?.[currentWindowModeKey()];
  if (!boundsAreVisible(target)) return false;
  // 尺寸交給模式自己的 resize 邏輯決定，這裡只還原位置。
  const { width, height } = window.getBounds();
  window.setBounds({ x: Math.round(target.x), y: Math.round(target.y), width, height });
  return true;
}

function setAlwaysOnTop(value) {
  isAlwaysOnTop = Boolean(value);
  const window = getLiveWindow();
  if (window) window.setAlwaysOnTop(isAlwaysOnTop);
  sendToWindow("window:alwaysOnTopChanged", isAlwaysOnTop);
  return isAlwaysOnTop;
}

function setCompactMode(value) {
  isCompactMode = Boolean(value);
  const window = getLiveWindow();
  if (window) {
    window.setHasShadow(!isCompactMode);
    window.setSkipTaskbar(isCompactMode);
    if (isCompactMode) {
      setCompactTopStrip(false);
      isCompactExpanded = false;
      resizeCompactWindow(window, false);
      placeCompactWindowTopCenter(window);
    } else {
      setCompactTopStrip(false);
      isCompactExpanded = false;
      setCompactMousePassthrough(false);
      window.setMinimumSize(WINDOW_SIZES.full.width, WINDOW_SIZES.full.height);
      window.setSize(WINDOW_SIZES.full.width, WINDOW_SIZES.full.height, false);
      placeWindowTopRight(window);
    }
  }
  sendToWindow("window:compactChanged", isCompactMode);
  sendToWindow("window:compactScaleChanged", compactScale);
  return isCompactMode;
}

function setCompactScale(value) {
  compactScale = clampCompactScale(value);
  const window = getLiveWindow();
  if (window && isCompactMode) {
    resizeCompactWindow(window);
    if (isCompactTopStrip) {
      snapCompactWindow();
    } else {
      placeCompactWindowTopCenter(window);
    }
  }
  sendToWindow("window:compactScaleChanged", compactScale);
  return compactScale;
}

function setCompactExpanded(value) {
  isCompactExpanded = Boolean(value);
  const window = getLiveWindow();
  if (window && isCompactMode) {
    resizeCompactWindow(window, isCompactExpanded);
  }
  if (isCompactExpanded) setCompactMousePassthrough(false);
  return isCompactExpanded;
}

function setCompactTopStrip(value) {
  const nextValue = Boolean(value);
  if (isCompactTopStrip === nextValue) return isCompactTopStrip;
  isCompactTopStrip = nextValue;
  if (!isCompactTopStrip) setCompactMousePassthrough(false);
  sendToWindow("window:compactDisplayModeChanged", compactDisplayMode());
  return isCompactTopStrip;
}

function setCompactMousePassthrough(value) {
  const window = getLiveWindow();
  const nextValue = Boolean(value) && isCompactMode && isCompactTopStrip && !isCompactExpanded;
  if (isCompactMousePassthrough === nextValue) return isCompactMousePassthrough;
  isCompactMousePassthrough = nextValue;
  if (window) {
    window.setIgnoreMouseEvents(isCompactMousePassthrough, { forward: true });
  }
  return isCompactMousePassthrough;
}

function getCursorState() {
  const window = getLiveWindow();
  const cursor = screen.getCursorScreenPoint();
  return {
    cursor,
    windowBounds: window ? window.getBounds() : null
  };
}

function moveCompactWindow(deltaX, deltaY) {
  const window = getLiveWindow();
  if (!window) throw new Error("Main window has not been created.");
  if (!isCompactMode) throw new Error("Compact window movement is only available in compact mode.");
  const parsedDeltaX = Number(deltaX);
  const parsedDeltaY = Number(deltaY);
  if (!Number.isFinite(parsedDeltaX) || !Number.isFinite(parsedDeltaY)) {
    throw new Error("Compact window movement requires finite numeric deltas.");
  }
  const bounds = window.getBounds();
  const x = Math.round(bounds.x + parsedDeltaX);
  const y = Math.round(bounds.y + parsedDeltaY);
  window.setPosition(x, y, false);
  return { x, y, snapped: false, displayMode: compactDisplayMode() };
}

function snapCompactWindow() {
  const window = getLiveWindow();
  if (!window) throw new Error("Main window has not been created.");
  if (!isCompactMode) throw new Error("Compact window snapping is only available in compact mode.");
  const bounds = window.getBounds();
  const next = snapCompactPosition(bounds.x, bounds.y, bounds.width, bounds.height);
  const nextTopStrip = next.displayMode === "topStrip";
  const modeChanged = isCompactTopStrip !== nextTopStrip;
  const wasExpanded = isCompactExpanded;
  setCompactTopStrip(nextTopStrip);
  isCompactExpanded = false;
  if (modeChanged || wasExpanded) resizeCompactWindow(window, false);
  if (next.snapped || modeChanged) window.setPosition(next.x, next.y, false);
  if (!nextTopStrip) setCompactMousePassthrough(false);
  return { ...next, displayMode: compactDisplayMode() };
}

function snapCompactPosition(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({
    x: x + Math.round(width / 2),
    y: y + Math.round(height / 2)
  });
  const { workArea } = display;
  const targetX = workArea.x + Math.round((workArea.width - width) / 2);
  const stripTargetY = workArea.y + COMPACT_STRIP_TOP_OFFSET;
  const nearStripTopY = y <= stripTargetY + COMPACT_STRIP_TOP_SNAP_DISTANCE;
  if (nearStripTopY) {
    const nearStripCenterX = Math.abs(x - targetX) <= COMPACT_STRIP_CENTER_SNAP_DISTANCE;
    return {
      x: nearStripCenterX ? targetX : clampWindowX(x, width, workArea),
      y: stripTargetY,
      snapped: true,
      displayMode: "topStrip"
    };
  }

  const targetY = workArea.y + COMPACT_TOP_OFFSET;
  const nearTopCenterX = Math.abs(x - targetX) <= COMPACT_CENTER_SNAP_DISTANCE;
  const nearTopCenterY = Math.abs(y - targetY) <= COMPACT_TOP_SNAP_DISTANCE;

  if (nearTopCenterX && nearTopCenterY) {
    return { x: targetX, y: targetY, snapped: true, displayMode: "hud" };
  }

  return { x, y, snapped: false, displayMode: "hud" };
}

function clampWindowX(x, width, workArea) {
  return Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, Math.round(x)));
}

function showWindow() {
  const window = getLiveWindow();
  if (!window) {
    createWindow();
    return;
  }

  cancelWindowRelease();
  if (!window.isVisible()) window.show();
  window.focus();
  quotaStore?.setWindowVisible(true);
  quotaStore?.refreshNow("window-show").catch(() => {});
}

function hideWindow() {
  const window = getLiveWindow();
  if (window) window.hide();
}

function scheduleWindowRelease() {
  if (isQuitting) return;
  cancelWindowRelease();
  releaseWindowTimer = setTimeout(() => {
    const window = getLiveWindow();
    if (window && !window.isVisible()) {
      window.destroy();
    }
  }, HIDDEN_WINDOW_RELEASE_MS);
}

function cancelWindowRelease() {
  if (releaseWindowTimer) {
    clearTimeout(releaseWindowTimer);
    releaseWindowTimer = null;
  }
}

function quitApp() {
  isQuitting = true;
  cancelWindowRelease();
  quotaStore?.destroy();
  app.quit();
}

function getLiveWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}

function sendToWindow(channel, ...args) {
  const window = getLiveWindow();
  if (!window || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}

function sendToSettingsWindow(channel, ...args) {
  if (!settingsWindow || settingsWindow.isDestroyed() || settingsWindow.webContents.isDestroyed()) return;
  settingsWindow.webContents.send(channel, ...args);
}

module.exports = { startQuotaWidget };
