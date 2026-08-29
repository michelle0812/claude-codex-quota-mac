// 兩個 app 共用的設定視窗核心（來源：packages/shared/settings-core.js）。
//
// index.html 必須先載入 ../app-config.js。只有 APP_CONFIG.auth 存在時
// （目前只有 Claude 版）才會動態插入「帳號登入」那一區，Codex 版完全不會出現。

const APP_CONFIG = window.APP_CONFIG;
if (!APP_CONFIG) {
  throw new Error("settings-core.js 需要先載入 ../app-config.js（未找到 window.APP_CONFIG）");
}

const DEFAULTS = {
  recentFastBreathMs: 4000,
  criticalBlinkMs: 3000,
  quotaRefreshMs: 3 * 60 * 1000,
  showInDock: true,
  autoUpdateCheck: true
};

const els = {
  statusText: document.getElementById("statusText"),
  recentFastRange: document.getElementById("recentFastRange"),
  recentFastInput: document.getElementById("recentFastInput"),
  criticalRange: document.getElementById("criticalRange"),
  criticalInput: document.getElementById("criticalInput"),
  quotaRefreshRange: document.getElementById("quotaRefreshRange"),
  quotaRefreshInput: document.getElementById("quotaRefreshInput"),
  showInDockInput: document.getElementById("showInDockInput"),
  autoUpdateCheckInput: document.getElementById("autoUpdateCheckInput"),
  resetBtn: document.getElementById("resetBtn"),
  saveBtn: document.getElementById("saveBtn"),
  authField: null,
  authStatus: null,
  authLoginBtn: null,
  authLogoutBtn: null
};

function secondsFromMs(value, fallbackMs) {
  const number = Number(value);
  const safeMs = Number.isFinite(number) ? number : fallbackMs;
  return trimSeconds(Math.min(20, Math.max(1, safeMs / 1000)));
}

function msFromSeconds(value, fallbackMs) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallbackMs;
  return Math.round(Math.min(20, Math.max(1, number)) * 1000);
}

function minutesFromMs(value, fallbackMs) {
  const number = Number(value);
  const safeMs = Number.isFinite(number) ? number : fallbackMs;
  return Math.round(Math.min(30, Math.max(1, safeMs / (60 * 1000)))).toString();
}

function msFromMinutes(value, fallbackMs) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallbackMs;
  return Math.round(Math.min(30, Math.max(1, number)) * 60 * 1000);
}

function trimSeconds(value) {
  return Number(value.toFixed(1)).toString();
}

function setPair(range, input, seconds) {
  range.value = seconds;
  input.value = seconds;
}

function renderSettings(settings = DEFAULTS) {
  setPair(els.recentFastRange, els.recentFastInput, secondsFromMs(settings.recentFastBreathMs, DEFAULTS.recentFastBreathMs));
  setPair(els.criticalRange, els.criticalInput, secondsFromMs(settings.criticalBlinkMs, DEFAULTS.criticalBlinkMs));
  setPair(els.quotaRefreshRange, els.quotaRefreshInput, minutesFromMs(settings.quotaRefreshMs, DEFAULTS.quotaRefreshMs));
  els.showInDockInput.checked = settings.showInDock ?? DEFAULTS.showInDock;
  els.autoUpdateCheckInput.checked = settings.autoUpdateCheck ?? DEFAULTS.autoUpdateCheck;
}

function readSettings() {
  return {
    recentFastBreathMs: msFromSeconds(els.recentFastInput.value, DEFAULTS.recentFastBreathMs),
    criticalBlinkMs: msFromSeconds(els.criticalInput.value, DEFAULTS.criticalBlinkMs),
    quotaRefreshMs: msFromMinutes(els.quotaRefreshInput.value, DEFAULTS.quotaRefreshMs),
    showInDock: els.showInDockInput.checked,
    autoUpdateCheck: els.autoUpdateCheckInput.checked
  };
}

function bindPair(range, input) {
  range.addEventListener("input", () => {
    input.value = range.value;
  });
  input.addEventListener("input", () => {
    range.value = input.value;
  });
}

async function saveSettings(closeAfterSave = false) {
  const settings = await window.quotaBridge.setSignalSettings(readSettings());
  renderSettings(settings);
  els.statusText.textContent = "已儲存";
  if (closeAfterSave) await window.quotaBridge.closeSettings();
}

async function resetSettings() {
  const settings = await window.quotaBridge.resetSignalSettings();
  renderSettings(settings);
  els.statusText.textContent = "已恢復預設";
}

function showError(error) {
  els.statusText.textContent = error?.message || String(error);
}

// ---- 帳號登入區（只有 APP_CONFIG.auth 存在的 app 才有）----

function buildAuthField(auth) {
  const section = document.createElement("section");
  section.className = "field account-field";
  section.id = "authField";
  section.innerHTML = `
        <div class="account-copy">
          <label></label>
          <p class="hint"></p>
        </div>
        <div class="account-actions">
          <button type="button"></button>
          <button type="button" class="secondary" hidden></button>
        </div>`;

  section.querySelector("label").textContent = auth.label;
  const status = section.querySelector(".hint");
  status.textContent = auth.checkingText;
  const [loginBtn, logoutBtn] = section.querySelectorAll("button");
  loginBtn.textContent = auth.loginLabel;
  logoutBtn.textContent = auth.logoutLabel;

  els.saveBtn.closest("main").querySelector("footer").before(section);
  els.authField = section;
  els.authStatus = status;
  els.authLoginBtn = loginBtn;
  els.authLogoutBtn = logoutBtn;
}

function renderAuthStatus(loggedIn) {
  const auth = APP_CONFIG.auth;
  els.authStatus.textContent = loggedIn ? auth.loggedInText : auth.loggedOutText;
  els.authLoginBtn.hidden = loggedIn;
  els.authLogoutBtn.hidden = !loggedIn;
}

async function login() {
  const auth = APP_CONFIG.auth;
  els.authLoginBtn.disabled = true;
  els.authStatus.textContent = auth.loginPendingText;
  try {
    await window.quotaBridge.login();
    renderAuthStatus(true);
    els.statusText.textContent = auth.loginDoneText;
  } catch (error) {
    renderAuthStatus(false);
    showError(error);
  } finally {
    els.authLoginBtn.disabled = false;
  }
}

async function logout() {
  const auth = APP_CONFIG.auth;
  els.authLogoutBtn.disabled = true;
  try {
    await window.quotaBridge.logout();
    renderAuthStatus(false);
    els.statusText.textContent = auth.logoutDoneText;
  } catch (error) {
    showError(error);
  } finally {
    els.authLogoutBtn.disabled = false;
  }
}

// ---- 接線 ----

bindPair(els.recentFastRange, els.recentFastInput);
bindPair(els.criticalRange, els.criticalInput);
bindPair(els.quotaRefreshRange, els.quotaRefreshInput);
els.saveBtn.addEventListener("click", () => saveSettings(true).catch(showError));
els.resetBtn.addEventListener("click", () => resetSettings().catch(showError));
els.showInDockInput.addEventListener("change", () => saveSettings().catch(showError));
els.autoUpdateCheckInput.addEventListener("change", () => saveSettings().catch(showError));
window.quotaBridge.onSignalSettingsChanged(renderSettings);
window.quotaBridge.getSignalSettings().then(renderSettings).catch(showError);

if (APP_CONFIG.auth) {
  buildAuthField(APP_CONFIG.auth);
  els.authLoginBtn.addEventListener("click", () => login());
  els.authLogoutBtn.addEventListener("click", () => logout());
  window.quotaBridge.onAuthStatusChanged(renderAuthStatus);
  window.quotaBridge.getAuthStatus().then(renderAuthStatus).catch(showError);
}
