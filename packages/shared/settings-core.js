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
  els.autoUpdateCheckInput.checked = settings.autoUpdateCheck ?? DEFAULTS.autoUpdateCheck;
}

function readSettings() {
  return {
    recentFastBreathMs: msFromSeconds(els.recentFastInput.value, DEFAULTS.recentFastBreathMs),
    criticalBlinkMs: msFromSeconds(els.criticalInput.value, DEFAULTS.criticalBlinkMs),
    quotaRefreshMs: msFromMinutes(els.quotaRefreshInput.value, DEFAULTS.quotaRefreshMs),
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
  if (auth.browserChoice) buildBrowserChoice(section);
  if (auth.quotaGroupChoice) buildQuotaGroupChoice(section);
}

function buildQuotaGroupChoice(section) {
  const controls = document.createElement("div");
  controls.className = "browser-choice";
  const label = document.createElement("label");
  label.htmlFor = "quotaGroup";
  label.textContent = "額度群組";
  const select = document.createElement("select");
  select.id = "quotaGroup";
  select.disabled = true;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Gemini 與 Claude / GPT 各有獨立額度。帳號請先在 AGY 登入，再按連接；每個面板各自設定。";
  controls.append(label, select, hint);
  section.prepend(controls);
  let current;
  function render(options) {
    current = options;
    select.replaceChildren(...options.groups.map((group) => {
      const option = document.createElement("option");
      option.value = group.id; option.textContent = group.label; return option;
    }));
    select.value = options.group;
    hint.textContent = (options.email ? `AGY 帳號：${options.email}。` : "")
      + "Gemini 與 Claude / GPT 各有獨立額度。請先在 AGY 登入，再按連接；每個面板各自設定。";
  }
  window.quotaBridge.getAuthOptions().then(render).then(() => { select.disabled = false; }).catch(showError);
  window.quotaBridge.onAuthStatusChanged(() => window.quotaBridge.getAuthOptions().then(render).catch(showError));
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      render(await window.quotaBridge.setAuthOptions({ group: select.value }));
      els.statusText.textContent = "已儲存此面板的額度群組";
    } catch (error) { if (current) render(current); showError(error); }
    finally { select.disabled = false; }
  });
}

let browserOptions = null;
function buildBrowserChoice(section) {
  const controls = document.createElement("div");
  controls.className = "browser-choice";
  controls.innerHTML = '<label for="quotaSource">用量來源</label><select id="quotaSource"><option value="codex">Codex 登入</option><option value="browser">瀏覽器登入</option></select><label for="quotaBrowser">此面板使用的瀏覽器</label><select id="quotaBrowser"></select><p class="hint" id="quotaBrowserHint"></p>';
  section.prepend(controls);
  const source = controls.querySelector("#quotaSource");
  const browser = controls.querySelector("#quotaBrowser");
  const bridgeButton = document.createElement("button");
  bridgeButton.type = "button"; bridgeButton.className = "secondary";
  bridgeButton.textContent = "開啟橋接擴充套件與說明";
  bridgeButton.addEventListener("click", () => window.quotaBridge.openBrowserBridge().catch(showError));
  controls.append(bridgeButton);
  function render(value) {
    browserOptions = value;
    source.value = value.source;
    browser.replaceChildren(...value.browsers.map((b) => {
      const option = document.createElement("option"); option.value = b.id;
      option.textContent = b.name + (b.installed ? "" : "（未安裝）"); return option;
    }));
    browser.value = value.browser; browser.disabled = value.source !== "browser";
    bridgeButton.hidden = value.source !== "browser";
    controls.querySelector("#quotaBrowserHint").textContent = value.source === "browser"
      ? '選擇會立即儲存，只影響此面板。請先安裝用量橋接擴充套件；登入後保持瀏覽器開啟。' : '讀取此面板的 Codex 登入檔。';
  }
  async function change() {
    source.disabled = browser.disabled = true;
    try {
      render(await window.quotaBridge.setAuthOptions({ source: source.value, browser: browser.value }));
      renderAuthStatus(await window.quotaBridge.getAuthStatus());
      els.statusText.textContent = "已儲存此面板的登入方式";
    } catch (error) { if (browserOptions) render(browserOptions); showError(error); }
    finally { source.disabled = false; browser.disabled = source.value !== "browser"; }
  }
  source.disabled = browser.disabled = true;
  window.quotaBridge.getAuthOptions().then(render).then(() => { source.disabled = false; }).catch(showError);
  source.addEventListener("change", change); browser.addEventListener("change", change);
}

function renderAuthStatus(loggedIn) {
  const auth = APP_CONFIG.auth;
  els.authStatus.textContent = browserOptions?.source === "browser"
    ? (loggedIn ? `已連線：${browserOptions.email || "瀏覽器帳號"}` : "尚未連線：按登入 ChatGPT 連接此瀏覽器")
    : (loggedIn ? auth.loggedInText : auth.loggedOutText);
  els.authLoginBtn.hidden = loggedIn;
  els.authLogoutBtn.hidden = !loggedIn;
}

async function login() {
  const auth = APP_CONFIG.auth;
  els.authLoginBtn.disabled = true;
  const choices = document.querySelectorAll(".browser-choice select");
  choices.forEach((select) => { select.disabled = true; });
  els.authStatus.textContent = browserOptions?.source === "browser" ? "請在選定瀏覽器完成橋接並登入 ChatGPT（2 分鐘內）…" : auth.loginPendingText;
  try {
    const result = await window.quotaBridge.login();
    if (result?.cancelled) { renderAuthStatus(await window.quotaBridge.getAuthStatus()); return; }
    if (browserOptions && result?.email) browserOptions.email = result.email;
    renderAuthStatus(await window.quotaBridge.getAuthStatus());
    els.statusText.textContent = auth.loginDoneText;
  } catch (error) {
    renderAuthStatus(false);
    showError(error);
  } finally {
    els.authLoginBtn.disabled = false;
    choices.forEach((select) => { select.disabled = select.id === "quotaBrowser" && browserOptions?.source !== "browser"; });
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
