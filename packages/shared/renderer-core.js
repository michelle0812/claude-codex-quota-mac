// 兩個 app 共用的 renderer 核心（來源：packages/shared/renderer-core.js）。
//
// 進來之前 index.html 必須先載入 ../app-config.js，裡面定義全域 APP_CONFIG：
//   brandName               主控台訊息用的 app 名稱
//   compactThemeStorageKey  localStorage 的 key（兩個 app 不能共用）
//   emptyErrorCopyKey       錯誤訊息是空字串時要顯示哪一則文案
//   copy: { zh: {...}, en: {...} }  覆蓋 brand / statusLoading / statusError / authRequired
//   accent: { weekly, weeklyStrong, short, shortStrong }  mini bar 與 HUD 的主色
//
// IPC 一律走 window.quotaBridge，兩個 app 的 preload 都曝露同一個名字。

const APP_CONFIG = window.APP_CONFIG;
if (!APP_CONFIG) {
  throw new Error("renderer-core.js 需要先載入 ../app-config.js（未找到 window.APP_CONFIG）");
}

// 把 app 主色灌進 CSS 變數，styles.css 的 mini bar / HUD / 玻璃球都吃這幾個 token。
// 這是兩個 app 能一眼區分的唯一來源，styles.css 本身兩邊完全一樣。
applyBrandAccent(APP_CONFIG.accent);

function applyBrandAccent(accent) {
  const root = document.documentElement;
  for (const [name, hex] of Object.entries(accent)) {
    const token = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--app-${token}`, hex);
    root.style.setProperty(`--app-${token}-rgb`, hexToRgbTriplet(hex));
  }
}

function hexToRgbTriplet(hex) {
  const value = String(hex).trim().replace(/^#/, "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int) || full.length !== 6) {
    throw new Error(`APP_CONFIG.accent 的色碼格式不正確：${hex}`);
  }
  return `${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}`;
}

const state = {
  lang: "zh",
  quota: null,
  error: null,
  compact: true,
  compactDisplayMode: "hud",
  compactExpanded: false,
  compactScale: 0.46,
  compactTheme: "glass",
  signalSettings: {
    recentFastBreathMs: 4000,
    criticalBlinkMs: 3000
  },
  resizing: null,
  moving: null,
  resizeFrame: null,
  moveFrame: null,
  hoverProbeTimer: null,
  hoverProbeInFlight: false,
  loading: false
};

const COMPACT_HOVER_PROBE_MS = 80;

const COMPACT_SCALE_LIMITS = { min: 0.46, max: 1.25 };
const COMPACT_DEFAULT_SCALE = 0.46;
const COMPACT_DEFAULT_SCALE_SNAP_DISTANCE = 0.035;
const COMPACT_THEME_STORAGE_KEY = APP_CONFIG.compactThemeStorageKey;
const COMPACT_THEMES = new Set(["glass", "island"]);
const COMPACT_DISPLAY_MODES = new Set(["hud", "topStrip"]);

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return element;
}

function requiredElements(selector) {
  const elements = document.querySelectorAll(selector);
  if (elements.length === 0) {
    throw new Error(`Missing required DOM elements: ${selector}`);
  }
  return elements;
}

const els = {
  body: document.body,
  trafficLight: requiredElement("trafficLight"),
  brandName: requiredElement("brandName"),
  stateText: requiredElement("stateText"),
  langBtn: requiredElement("langBtn"),
  compactBtn: requiredElement("compactBtn"),
  pinBtn: requiredElement("pinBtn"),
  refreshBtn: requiredElement("refreshBtn"),
  settingsBtn: requiredElement("settingsBtn"),
  minimizeBtn: requiredElement("minimizeBtn"),
  closeBtn: requiredElement("closeBtn"),
  liquidMeter: requiredElement("liquidMeter"),
  liquidFill: requiredElement("liquidFill"),
  remaining: requiredElement("remaining"),
  remainingLabel: requiredElement("remainingLabel"),
  compactShell: requiredElement("compactShell"),
  compactHud: requiredElement("compactHud"),
  compactControls: requiredElement("compactControls"),
  compactWeeklyFill: requiredElement("compactWeeklyFill"),
  compactShortFill: requiredElement("compactShortFill"),
  compactWeeklyIdeal: requiredElement("compactWeeklyIdeal"),
  compactShortIdeal: requiredElement("compactShortIdeal"),
  compactWeeklyVelocity: requiredElement("compactWeeklyVelocity"),
  compactShortVelocity: requiredElement("compactShortVelocity"),
  compactWeeklyIdealText: requiredElement("compactWeeklyIdealText"),
  compactShortIdealText: requiredElement("compactShortIdealText"),
  compactWeeklyVelocityText: requiredElement("compactWeeklyVelocityText"),
  compactShortVelocityText: requiredElement("compactShortVelocityText"),
  compactWeeklyText: requiredElement("compactWeeklyText"),
  compactShortText: requiredElement("compactShortText"),
  compactWeeklyDelta: requiredElement("compactWeeklyDelta"),
  compactShortDelta: requiredElement("compactShortDelta"),
  compactThemeBtn: requiredElement("compactThemeBtn"),
  compactSettingsBtn: requiredElement("compactSettingsBtn"),
  compactExpandBtn: requiredElement("compactExpandBtn"),
  compactCloseBtn: requiredElement("compactCloseBtn"),
  compactResizeHandle: requiredElement("compactResizeHandle"),
  compactAdviceText: requiredElement("compactAdviceText"),
  compactAdviceKicker: requiredElement("compactAdviceKicker"),
  compactAdviceValue: requiredElement("compactAdviceValue"),
  compactPaceSignal: requiredElement("compactPaceSignal"),
  compactResetLabels: requiredElements(".compact-reset-label"),
  compactResetInfo: requiredElement("compactResetInfo"),
  compactShortResetText: requiredElement("compactShortResetText"),
  compactWeeklyResetText: requiredElement("compactWeeklyResetText"),
  primaryLabel: requiredElement("primaryLabel"),
  primaryText: requiredElement("primaryText"),
  secondaryLabel: requiredElement("secondaryLabel"),
  secondaryText: requiredElement("secondaryText"),
  planLabel: requiredElement("planLabel"),
  planText: requiredElement("planText"),
  paceTitle: requiredElement("paceTitle"),
  paceBadge: requiredElement("paceBadge"),
  weeklyPaceLabel: requiredElement("weeklyPaceLabel"),
  weeklyPaceText: requiredElement("weeklyPaceText"),
  actualPaceLabel: requiredElement("actualPaceLabel"),
  actualPaceText: requiredElement("actualPaceText"),
  idealPaceLabel: requiredElement("idealPaceLabel"),
  idealPaceText: requiredElement("idealPaceText"),
  velocityPaceLabel: requiredElement("velocityPaceLabel"),
  velocityPaceText: requiredElement("velocityPaceText"),
  deltaPaceLabel: requiredElement("deltaPaceLabel"),
  deltaPaceText: requiredElement("deltaPaceText"),
  statusDot: requiredElement("statusDot"),
  statusText: requiredElement("statusText"),
  updateBtn: requiredElement("updateBtn"),
  archBadge: requiredElement("archBadge")
};

// 大面板右下角標「架構 + 版本」，例如 "arm 1.0.2"。緊湊 HUD 不顯示（footer.status 在緊湊模式本來就 display:none）。
const ARCH_LABELS = { arm64: "arm", x64: "Intel" };
const archLabel = ARCH_LABELS[window.quotaBridge.arch] || window.quotaBridge.arch || "";
let appVersion = "";

function renderArchBadge() {
  setText(els.archBadge, appVersion ? `${archLabel} ${appVersion}` : archLabel);
}

function renderUpdateState(state) {
  const s = state || {};
  const next = s.checking ? "checking" : s.updateAvailable ? "available" : "idle";
  els.updateBtn.dataset.state = next;
  els.updateBtn.title = s.checking
    ? "檢查更新中…"
    : s.updateAvailable
      ? `有新版 ${s.latestVersion}，點擊前往下載`
      : "檢查更新";
  els.updateBtn.setAttribute("aria-label", els.updateBtn.title);
}

const copy = {
  zh: {
    brand: "額度",
    loading: "讀取中",
    ready: "已更新",
    error: "讀取失敗",
    remaining: "已用",
    primary: "5小時",
    secondary: "本週",
    plan: "方案",
    unknown: "未知",
    refresh: "重新整理",
    hide: "隱藏",
    settings: "設定",
    hideToTray: "隱藏",
    close: "退出",
    pin: "置頂",
    unpin: "取消置頂",
    compact: "緊湊視窗",
    expand: "展開視窗",
    resize: "縮放",
    theme: "切換 HUD 主題",
    statusLoading: "正在讀取額度...",
    statusReady: "額度已更新",
    statusError: "無法讀取額度",
    authRequired: "尚未偵測到額度資料",
    paceTitle: "使用節奏建議",
    weeklyPace: "7天節奏",
    actualRemaining: "實際已用",
    idealRemaining: "理想已用",
    velocityRemaining: "近速上限",
    paceDelta: "偏差",
    status: {
      urgent: "加速蹬！",
      accelerate: "餘量充足",
      normal: "節奏正常",
      recentFast: "近期偏快",
      coolingDown: "繼續放緩",
      slow: "建議減速",
      critical: "接近耗盡",
      unknown: "無法判斷"
    },
    reasons: {
      ahead: "7 天視窗剩餘額度高於當前時間進度",
      onTrack: "7 天視窗消耗與當前時間進度基本一致",
      behind: "7 天視窗剩餘額度低於當前時間進度",
      critical: "7 天視窗剩餘額度不高於 5%",
      urgentAhead: "7 天視窗剩餘額度明顯高於理想剩餘額度",
      shortWindowTight: "5 小時視窗近期速度偏快",
      shortWindowCritical: "5 小時視窗剩餘額度緊張",
      recentPaceRecovered: "5 小時視窗近期速度已經回到合理範圍",
      bothWindowsBehind: "7 天視窗和 5 小時視窗都低於當前時間進度",
      dynamicPaceTight: "按近期速度繼續使用會提前耗盡",
      bothReferencesBehind: "實際剩餘同時低於理想線和近速需留線",
      insufficientData: "7 天視窗缺少重置時間或視窗時長",
      missingLongWindow: "沒有可用於主判斷的 7 天視窗資料"
    },
    reset: "重置倒數",
    resetting: "即將重置",
    noReset: "未提供重置時間"
  },
  en: {
    brand: "Quota",
    loading: "Loading",
    ready: "Updated",
    error: "Failed",
    remaining: "used",
    primary: "5-hour window",
    secondary: "7-day window",
    plan: "Plan",
    unknown: "Unknown",
    refresh: "Refresh",
    hide: "Hide",
    settings: "Settings",
    hideToTray: "Hide",
    close: "Quit",
    pin: "Pin",
    unpin: "Unpin",
    compact: "Compact",
    expand: "Expand",
    resize: "Resize",
    theme: "Switch HUD theme",
    statusLoading: "Reading quota...",
    statusReady: "Quota updated",
    statusError: "Unable to read quota",
    authRequired: "Quota data not found",
    paceTitle: "Usage pace advice",
    weeklyPace: "7-day pace",
    actualRemaining: "Used",
    idealRemaining: "Ideal",
    velocityRemaining: "Recent",
    paceDelta: "Delta",
    status: {
      urgent: "Use soon",
      accelerate: "Enough left",
      normal: "On track",
      recentFast: "Recent fast",
      coolingDown: "Cooling",
      slow: "Slow down",
      critical: "Nearly exhausted",
      unknown: "Unknown"
    },
    reasons: {
      ahead: "The 7-day quota is above the current time progress",
      onTrack: "The 7-day usage matches the current time progress",
      behind: "The 7-day quota is below the current time progress",
      critical: "The 7-day quota is at or below 5%",
      urgentAhead: "The 7-day quota is well above the ideal remaining quota",
      shortWindowTight: "The 5-hour window is burning too fast",
      shortWindowCritical: "The 5-hour window is tight",
      recentPaceRecovered: "The 5-hour window has recovered to a reasonable pace",
      bothWindowsBehind: "Both the 7-day and 5-hour windows are behind",
      dynamicPaceTight: "The recent pace would run out before reset",
      bothReferencesBehind: "The current quota is below both reference lines",
      insufficientData: "The 7-day reset time or window duration is missing",
      missingLongWindow: "No 7-day window data is available for the main decision"
    },
    reset: "resets in",
    resetting: "resetting",
    noReset: "reset time unavailable"
  }
};

// app 專屬字串蓋掉共用預設值（brand / statusLoading / statusError / authRequired）。
for (const [lang, overrides] of Object.entries(APP_CONFIG.copy || {})) {
  if (copy[lang]) Object.assign(copy[lang], overrides);
}

function t(path) {
  return path.split(".").reduce((value, key) => value?.[key], copy[state.lang]) ?? path;
}

function setText(element, value) {
  element.textContent = value;
}

function setTextAll(elements, value) {
  elements.forEach((element) => setText(element, value));
}

function setAttr(element, name, value) {
  element.setAttribute(name, value);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentText(value) {
  const number = finiteNumberOrNull(value);
  return number === null ? "--" : `${Math.round(number)}%`;
}

function signedPercentText(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "--";
  const rounded = Math.round(number);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function signedDeltaText(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "--";
  const rounded = Math.round(number);
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function compactDeltaClass(value) {
  const number = finiteNumberOrNull(value);
  if (number === null || Math.round(number) === 0) return "compact-delta neutral";
  return `compact-delta ${number > 0 ? "positive" : "negative"}`;
}

function toUsedPercent(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, 100 - number));
}

function clampPercentValue(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function formatWindow(window) {
  if (!window) return "--";
  const resetText = window.resetsAt ? formatReset(window.resetsAt) : t("noReset");
  return `${percentText(toUsedPercent(window.remainingPercent))} · ${resetText}`;
}

// 把重置時間顯示成倒數（幾天幾小時 / 幾小時幾分 / 幾分），格式比照 Claude-Usage-Widget.app
function formatCountdown(value) {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return t("noReset");
  const diffMs = target - Date.now();
  if (diffMs <= 0) return t("resetting");
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const zh = state.lang === "zh";
  if (days > 0) return zh ? `${days}天${hours}小時` : `${days}d ${hours}h`;
  if (hours > 0) return zh ? `${hours}小時${minutes}分` : `${hours}h ${minutes}m`;
  return zh ? `${minutes}分` : `${minutes}m`;
}

function formatReset(value) {
  return formatCountdown(value);
}

function compactResetTime(window) {
  if (!window?.resetsAt) return "--";
  return formatCountdown(window.resetsAt);
}

function compactResetDetail(window) {
  return compactResetTime(window);
}

function statusClassFromRemaining(remainingPercent) {
  const remaining = finiteNumberOrNull(remainingPercent);
  if (remaining === null) return "loading";
  if (remaining <= 0) return "danger";
  if (remaining < 10) return "warning";
  return "good";
}

function renderStaticCopy() {
  setText(els.brandName, t("brand"));
  setText(els.remainingLabel, t("remaining"));
  setText(els.primaryLabel, t("primary"));
  setText(els.secondaryLabel, t("secondary"));
  setText(els.planLabel, t("plan"));
  setText(els.paceTitle, t("paceTitle"));
  setText(els.weeklyPaceLabel, t("weeklyPace"));
  setText(els.actualPaceLabel, t("actualRemaining"));
  setText(els.idealPaceLabel, t("idealRemaining"));
  setText(els.velocityPaceLabel, t("velocityRemaining"));
  setText(els.deltaPaceLabel, t("paceDelta"));
  setText(els.langBtn, state.lang === "zh" ? "EN" : "中");
  renderCompactButton(state.compact);
  setAttr(els.refreshBtn, "title", t("refresh"));
  setAttr(els.refreshBtn, "aria-label", t("refresh"));
  setAttr(els.settingsBtn, "title", t("settings"));
  setAttr(els.settingsBtn, "aria-label", t("settings"));
  setAttr(els.compactSettingsBtn, "title", t("settings"));
  setAttr(els.compactSettingsBtn, "aria-label", t("settings"));
  setAttr(els.minimizeBtn, "title", t("hide"));
  setAttr(els.minimizeBtn, "aria-label", t("hide"));
  setAttr(els.closeBtn, "title", t("close"));
  setAttr(els.closeBtn, "aria-label", t("close"));
  setAttr(els.compactExpandBtn, "title", t("expand"));
  setAttr(els.compactExpandBtn, "aria-label", t("expand"));
  setAttr(els.compactCloseBtn, "title", t("hideToTray"));
  setAttr(els.compactCloseBtn, "aria-label", t("hideToTray"));
  setAttr(els.compactThemeBtn, "title", t("theme"));
  setAttr(els.compactThemeBtn, "aria-label", t("theme"));
  setAttr(els.compactResizeHandle, "title", t("resize"));
  setAttr(els.compactResizeHandle, "aria-label", t("resize"));
  setTextAll(els.compactResetLabels, t("reset"));
  renderCompactTheme(state.compactTheme, { persist: false });
}

function renderQuota(quota) {
  state.quota = quota;
  state.error = null;
  renderStaticCopy();

  const remaining = quota?.remainingPercent;
  const quotaState = statusClassFromRemaining(remaining);
  els.body.dataset.state = quotaState;
  els.trafficLight.className = `traffic-light ${quotaState}`;
  els.statusDot.className = `status-dot ${quotaState}`;
  setText(els.stateText, t("ready"));
  setText(els.statusText, t("statusReady"));
  const used = toUsedPercent(remaining);
  setText(els.remaining, percentText(used));
  els.liquidFill.style.height = percentText(used);
  renderCompactHud(quota);
  setText(els.primaryText, formatWindow(quota?.primary));
  setText(els.secondaryText, formatWindow(quota?.secondary));
  setText(els.planText, quota?.planType || t("unknown"));

  renderPaceAdvice(quota?.paceAdvice);
}

function renderPaceAdvice(advice) {
  const weekly = advice?.longWindow;
  const overall = advice?.overall || { status: "unknown", severity: "muted", reasonCode: "missingLongWindow" };

  setText(els.weeklyPaceText, t(`status.${weekly?.status || "unknown"}`));
  setText(els.paceBadge, t(`status.${overall.status}`));
  setText(els.actualPaceText, percentText(toUsedPercent(weekly?.remainingPercent)));
  setText(els.idealPaceText, percentText(toUsedPercent(weekly?.idealRemainingPercent)));
  setText(els.velocityPaceText, percentText(toUsedPercent(weekly?.velocity?.requiredRemainingPercent)));
  setText(els.deltaPaceText, signedPercentText(weekly?.paceDelta));
  els.paceBadge.className = `pace-badge ${overall.severity}`;
  renderCompactAdvice(advice);
}

function renderCompactAdvice(advice) {
  const overall = advice?.overall || { status: "unknown", severity: "muted" };
  const compactText = compactAdviceText(overall.status);
  setText(els.compactAdviceKicker, compactText.kicker);
  setText(els.compactAdviceValue, compactText.value);
  setAttr(els.compactAdviceText, "title", t(`status.${overall.status}`));
  setAttr(els.compactAdviceText, "aria-label", t(`status.${overall.status}`));
  els.compactAdviceText.className = `compact-advice ${overall.severity} ${overall.status}`;
  renderCompactPaceSignal(overall);
}

function compactAdviceText(status) {
  const statusKey = knownPaceStatus(status) ? status : "unknown";
  const labels = {
    zh: {
      urgent: { kicker: "加速", value: "蹬！" },
      accelerate: { kicker: "餘量", value: "充足" },
      normal: { kicker: "節奏", value: "正常" },
      recentFast: { kicker: "近期", value: "偏快" },
      coolingDown: { kicker: "繼續", value: "放緩" },
      slow: { kicker: "建議", value: "減速" },
      critical: { kicker: "接近", value: "耗盡" },
      unknown: { kicker: "狀態", value: "未知" }
    },
    en: {
      urgent: { kicker: "Use", value: "Soon" },
      accelerate: { kicker: "Use", value: "Fast" },
      normal: { kicker: "Status", value: "OK" },
      recentFast: { kicker: "Recent", value: "Fast" },
      coolingDown: { kicker: "Keep", value: "Slow" },
      slow: { kicker: "Use", value: "Less" },
      critical: { kicker: "Risk", value: "Pause" },
      unknown: { kicker: "Status", value: "?" }
    }
  };
  return (labels[state.lang] || labels.zh)[statusKey];
}

function renderCompactPaceSignal(overall) {
  const status = knownPaceStatus(overall?.status) ? overall.status : "unknown";
  const label = t(`status.${status}`);
  els.compactPaceSignal.className = `compact-pace-signal ${status}`;
  setAttr(els.compactPaceSignal, "title", label);
  setAttr(els.compactPaceSignal, "aria-label", label);
}

function knownPaceStatus(status) {
  return ["urgent", "accelerate", "normal", "recentFast", "coolingDown", "slow", "critical", "unknown"].includes(status);
}

function renderSignalSettings(settings) {
  state.signalSettings = normalizeSignalSettings(settings);
  document.documentElement.style.setProperty("--signal-recent-fast-cycle", `${state.signalSettings.recentFastBreathMs}ms`);
  document.documentElement.style.setProperty("--signal-critical-cycle", `${state.signalSettings.criticalBlinkMs}ms`);
}

function normalizeSignalSettings(settings) {
  return {
    recentFastBreathMs: clampSignalMs(settings?.recentFastBreathMs, 4000),
    criticalBlinkMs: clampSignalMs(settings?.criticalBlinkMs, 3000)
  };
}

function clampSignalMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(20000, Math.max(1000, Math.round(number)));
}

function setCompactTrack(
  fillElement,
  idealElement,
  idealTextElement,
  velocityElement,
  velocityTextElement,
  actualValue,
  idealValue,
  velocityValue
) {
  const actual = toUsedPercent(actualValue);
  const ideal = toUsedPercent(idealValue);
  const velocity = toUsedPercent(velocityValue);
  const track = fillElement.parentElement;

  fillElement.style.width = actual === null ? "0%" : `${actual}%`;
  fillElement.hidden = actual === null;

  idealElement.hidden = ideal === null;
  idealTextElement.hidden = ideal === null;
  velocityElement.hidden = velocity === null;
  velocityTextElement.hidden = velocity === null;
  track.dataset.referenceMode = "separate";

  if (ideal === null) {
    idealElement.style.left = "0%";
    idealTextElement.style.left = "0%";
    setText(idealTextElement, "--");
  } else {
    const idealPosition = `${ideal}%`;
    idealElement.style.left = markerPosition(ideal);
    idealTextElement.style.left = `clamp(20px, ${idealPosition}, calc(100% - 20px))`;
    setText(idealTextElement, compactReferenceText("ideal", ideal));
  }

  if (velocity === null) {
    velocityElement.style.left = "0%";
    velocityTextElement.style.left = "0%";
    setText(velocityTextElement, "--");
  } else {
    const velocityPosition = `${velocity}%`;
    velocityElement.style.left = markerPosition(velocity);
    velocityTextElement.style.left = `clamp(20px, ${velocityPosition}, calc(100% - 20px))`;
    setText(velocityTextElement, compactReferenceText("velocity", velocity));
  }

  resolveCompactReferenceOverlap(track, idealTextElement, velocityTextElement);
  const title =
    ideal !== null && velocity !== null
      ? `${t("idealRemaining")} ${percentText(ideal)} / ${t("velocityRemaining")} ${percentText(velocity)}`
      : ideal !== null
        ? `${t("idealRemaining")} ${percentText(ideal)}`
        : velocity !== null
          ? `${t("velocityRemaining")} ${percentText(velocity)}`
          : "";
  setAttr(idealTextElement, "title", title);
  setAttr(velocityTextElement, "title", title);
}

function compactReferenceText(type, value) {
  return percentText(value);
}

function markerPosition(value) {
  return `clamp(2px, ${value}%, calc(100% - 2px))`;
}

function resolveCompactReferenceOverlap(track, idealTextElement, velocityTextElement) {
  idealTextElement.classList.remove("merged");
  if (idealTextElement.hidden || velocityTextElement.hidden) return;

  const idealRect = idealTextElement.getBoundingClientRect();
  const velocityRect = velocityTextElement.getBoundingClientRect();
  const overlaps = idealRect.left <= velocityRect.right && velocityRect.left <= idealRect.right;
  if (!overlaps) return;

  velocityTextElement.hidden = true;
  track.dataset.referenceMode = "idealOnly";
}

function renderCompactMetric({ fill, ideal, idealText, velocity, velocityText, percentTextElement, deltaTextElement }, window) {
  setCompactTrack(
    fill,
    ideal,
    idealText,
    velocity,
    velocityText,
    window?.remainingPercent,
    window?.idealRemainingPercent,
    window?.velocity?.requiredRemainingPercent
  );
  setText(percentTextElement, percentText(toUsedPercent(window?.remainingPercent)));
  setText(deltaTextElement, signedDeltaText(window?.paceDelta));
  deltaTextElement.className = compactDeltaClass(window?.paceDelta);
}

function renderCompactHud(quota) {
  const weekly = quota?.paceAdvice?.longWindow;
  const short = quota?.paceAdvice?.shortWindow;

  renderCompactMetric(
    {
      fill: els.compactWeeklyFill,
      ideal: els.compactWeeklyIdeal,
      idealText: els.compactWeeklyIdealText,
      velocity: els.compactWeeklyVelocity,
      velocityText: els.compactWeeklyVelocityText,
      percentTextElement: els.compactWeeklyText,
      deltaTextElement: els.compactWeeklyDelta
    },
    weekly
  );
  renderCompactMetric(
    {
      fill: els.compactShortFill,
      ideal: els.compactShortIdeal,
      idealText: els.compactShortIdealText,
      velocity: els.compactShortVelocity,
      velocityText: els.compactShortVelocityText,
      percentTextElement: els.compactShortText,
      deltaTextElement: els.compactShortDelta
    },
    short
  );
  setText(els.compactWeeklyResetText, compactResetDetail(quota?.secondary));
  setText(els.compactShortResetText, compactResetDetail(quota?.primary));
}

function renderLoading() {
  renderStaticCopy();
  els.body.dataset.state = "loading";
  els.trafficLight.className = "traffic-light loading";
  els.statusDot.className = "status-dot loading";
  setText(els.stateText, t("loading"));
  setText(els.statusText, t("statusLoading"));
  if (!state.quota) {
    renderCompactHud(null);
    renderCompactAdvice(null);
  }
}

function renderError(error) {
  state.quota = null;
  state.error = error;
  renderStaticCopy();
  els.body.dataset.state = "danger";
  els.trafficLight.className = "traffic-light danger";
  els.statusDot.className = "status-dot danger";
  setText(els.stateText, t("error"));
  setText(els.statusText, `${t("statusError")}：${friendlyErrorMessage(error)}`);
  setText(els.remaining, "--%");
  els.liquidFill.style.height = "0%";
  renderCompactHud(null);
  setText(els.primaryText, "--");
  setText(els.secondaryText, "--");
  setText(els.planText, "--");
  renderPaceAdvice(null);
}

function renderQuotaState(snapshot) {
  const quota = snapshot?.quota || null;
  const error = snapshot?.error || null;
  const isRefreshing = Boolean(snapshot?.refreshing || snapshot?.status === "loading");
  state.loading = isRefreshing;

  if (quota) {
    renderQuota(quota);
    if (isRefreshing) {
      setText(els.stateText, t("loading"));
      setText(els.statusText, t("statusLoading"));
    } else if (snapshot?.status === "error" && error) {
      state.error = error;
      setText(els.stateText, t("error"));
      setText(els.statusText, `${t("statusError")}: ${friendlyErrorMessage(error)}`);
    }
    return;
  }

  if (snapshot?.status === "error") {
    renderError(error);
    state.loading = false;
  } else {
    renderLoading();
  }
}

function friendlyErrorMessage(error) {
  const message = error?.message || "";
  // Codex 版的錯誤會夾帶 "authentication required"；Claude 版不會，所以這條判斷對兩邊都安全。
  if (message.toLowerCase().includes("authentication required")) {
    return t("authRequired");
  }
  return message || t(APP_CONFIG.emptyErrorCopyKey || "unknown");
}

async function refreshQuota() {
  if (state.loading) return;
  state.loading = true;
  if (state.quota) {
    renderQuotaState({ status: "loading", quota: state.quota, refreshing: true });
  } else {
    renderLoading();
  }

  try {
    const quotaState = await window.quotaBridge.refreshQuota();
    renderQuotaState(quotaState);
  } catch (error) {
    renderError(error);
  } finally {
    state.loading = false;
  }
}

async function syncAlwaysOnTop() {
  const isPinned = await window.quotaBridge.getAlwaysOnTop();
  renderPin(isPinned);
}

async function syncCompactMode() {
  const isCompact = await window.quotaBridge.getCompactMode();
  renderCompactMode(isCompact);
}

async function syncCompactScale() {
  const compactScale = await window.quotaBridge.getCompactScale();
  renderCompactScale(compactScale);
}

async function syncCompactDisplayMode() {
  const compactDisplayMode = await window.quotaBridge.getCompactDisplayMode();
  renderCompactDisplayMode(compactDisplayMode);
}

function renderPin(isPinned) {
  els.pinBtn.classList.toggle("active", Boolean(isPinned));
  const label = isPinned ? t("unpin") : t("pin");
  setAttr(els.pinBtn, "title", label);
  setAttr(els.pinBtn, "aria-label", label);
}

function renderCompactMode(isCompact) {
  state.compact = Boolean(isCompact);
  els.body.dataset.view = state.compact ? "compact" : "full";
  renderCompactButton(state.compact);
  if (!state.compact) renderCompactExpanded(false);
  updateCompactMousePassthrough();
}

function normalizeCompactDisplayMode(value) {
  return COMPACT_DISPLAY_MODES.has(value) ? value : "hud";
}

function isTopStripMode() {
  return state.compactDisplayMode === "topStrip";
}

function renderCompactDisplayMode(value) {
  state.compactDisplayMode = normalizeCompactDisplayMode(value);
  els.body.dataset.compactDisplay = state.compactDisplayMode;
  renderCompactExpanded(false);
  if (!isTopStripMode()) {
    setCompactMousePassthrough(false);
  } else {
    updateCompactMousePassthrough();
  }
}

function clampCompactScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(COMPACT_SCALE_LIMITS.max, Math.max(COMPACT_SCALE_LIMITS.min, scale));
}

function snapCompactScale(value) {
  const scale = clampCompactScale(value);
  if (Math.abs(scale - COMPACT_DEFAULT_SCALE) <= COMPACT_DEFAULT_SCALE_SNAP_DISTANCE) {
    return COMPACT_DEFAULT_SCALE;
  }
  return scale;
}

function renderCompactScale(value) {
  state.compactScale = clampCompactScale(value);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--compact-scale", String(state.compactScale));
  rootStyle.setProperty(
    "--compact-ideal-font-size",
    `${compensatedFontSize(state.compactScale, { min: 8.5, base: 8.5, max: 11.5 })}px`
  );
  rootStyle.setProperty(
    "--compact-advice-font-size",
    `${compensatedFontSize(state.compactScale, { min: 10, base: 10.5, max: 13 })}px`
  );
  rootStyle.setProperty(
    "--compact-detail-font-size",
    `${compensatedFontSize(state.compactScale, { min: 10, base: 10.5, max: 13 })}px`
  );
  rootStyle.setProperty(
    "--compact-detail-label-font-size",
    `${compensatedFontSize(state.compactScale, { min: 10.5, base: 11, max: 13.5 })}px`
  );
  rootStyle.setProperty(
    "--compact-detail-line-height",
    `${compensatedFontSize(state.compactScale, { min: 12, base: 12.5, max: 16 })}px`
  );
}

function compensatedFontSize(scale, { min, base, max }) {
  const safeScale = clampCompactScale(scale);
  const visualSize = Math.min(max, Math.max(min, base * Math.sqrt(safeScale / COMPACT_DEFAULT_SCALE)));
  return visualSize / safeScale;
}

function normalizeCompactTheme(value) {
  return COMPACT_THEMES.has(value) ? value : "glass";
}

function loadCompactTheme() {
  return normalizeCompactTheme(window.localStorage.getItem(COMPACT_THEME_STORAGE_KEY));
}

function renderCompactTheme(value, options = {}) {
  const theme = normalizeCompactTheme(value);
  state.compactTheme = theme;
  els.body.dataset.compactTheme = theme;
  setText(els.compactThemeBtn, theme === "glass" ? "島" : "玻");
  if (options.persist !== false) {
    window.localStorage.setItem(COMPACT_THEME_STORAGE_KEY, theme);
  }
}

function toggleCompactTheme() {
  renderCompactTheme(state.compactTheme === "glass" ? "island" : "glass");
}

function reportInteractionError(error) {
  console.error(`${APP_CONFIG.brandName} interaction failed:`, error);
}

function setCompactMousePassthrough(enabled) {
  window.quotaBridge.setCompactMousePassthrough(Boolean(enabled)).catch(reportInteractionError);
}

function updateCompactMousePassthrough() {
  const passthrough =
    state.compact &&
    isTopStripMode() &&
    !state.moving &&
    !state.resizing &&
    !state.compactExpanded;
  setCompactMousePassthrough(passthrough);
}

function renderCompactButton(isCompact) {
  const label = isCompact ? t("expand") : t("compact");
  els.compactBtn.classList.toggle("active", Boolean(isCompact));
  setAttr(els.compactBtn, "title", label);
  setAttr(els.compactBtn, "aria-label", label);
}

function startCompactResize(event) {
  if (!state.compact || isTopStripMode()) return;
  event.preventDefault();
  event.stopPropagation();
  state.resizing = {
    startX: event.screenX,
    startY: event.screenY,
    startScale: state.compactScale,
    pendingScale: state.compactScale
  };
  els.body.classList.add("is-resizing");
  syncCompactHoverProbe();
  window.addEventListener("mousemove", handleCompactResize);
  window.addEventListener("mouseup", stopCompactResize, { once: true });
}

function handleCompactResize(event) {
  if (!state.resizing) return;
  event.preventDefault();
  const deltaX = event.screenX - state.resizing.startX;
  const deltaY = event.screenY - state.resizing.startY;
  const dominantDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  const nextScale = snapCompactScale(state.resizing.startScale + dominantDelta / 210);
  renderCompactScale(nextScale);
  scheduleCompactScaleCommit(nextScale);
}

function scheduleCompactScaleCommit(scale) {
  if (!state.resizing) return;
  state.resizing.pendingScale = scale;
  if (state.resizeFrame) return;

  state.resizeFrame = window.requestAnimationFrame(() => {
    state.resizeFrame = null;
    const pendingScale = state.resizing?.pendingScale;
    if (!Number.isFinite(Number(pendingScale))) return;
    window.quotaBridge.setCompactScale(pendingScale).catch(reportInteractionError);
  });
}

function stopCompactResize() {
  if (!state.resizing) return;
  window.removeEventListener("mousemove", handleCompactResize);
  if (state.resizeFrame) {
    window.cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = null;
  }
  els.body.classList.remove("is-resizing");
  state.resizing = null;
  window.quotaBridge.setCompactScale(state.compactScale).then(renderCompactScale).catch(reportInteractionError);
  syncCompactHoverProbe();
  updateCompactMousePassthrough();
}

function renderCompactExpanded(expanded) {
  state.compactExpanded = Boolean(expanded);
  els.body.dataset.compactExpanded = state.compactExpanded ? "true" : "false";
  syncCompactHoverProbe();
}

function setCompactExpanded(expanded) {
  const nextExpanded = Boolean(expanded) && state.compact;
  if (state.compactExpanded === nextExpanded) return;
  renderCompactExpanded(nextExpanded);
  if (nextExpanded) setCompactMousePassthrough(false);
  window.quotaBridge
    .setCompactExpanded(nextExpanded)
    .then(() => {
      if (!nextExpanded) updateCompactMousePassthrough();
    })
    .catch(reportInteractionError);
}

function handleCompactPointerMove(event) {
  if (!state.compact || state.moving || state.resizing) return;
  setCompactExpanded(isInsideCompactVisibleSurface(event));
}

function syncCompactHoverProbe() {
  if (state.hoverProbeTimer && (!state.compactExpanded || state.moving || state.resizing)) {
    window.clearInterval(state.hoverProbeTimer);
    state.hoverProbeTimer = null;
  }
  if (!state.compactExpanded || state.moving || state.resizing || state.hoverProbeTimer) return;
  state.hoverProbeTimer = window.setInterval(probeCompactHoverState, COMPACT_HOVER_PROBE_MS);
}

async function probeCompactHoverState() {
  if (!state.compactExpanded || state.moving || state.resizing) {
    syncCompactHoverProbe();
    return;
  }
  if (state.hoverProbeInFlight) return;
  state.hoverProbeInFlight = true;
  try {
    const cursorState = await window.quotaBridge.getCursorState();
    const pointerEvent = pointerEventFromCursorState(cursorState);
    if (!pointerEvent || !isInsideCompactVisibleSurface(pointerEvent)) {
      setCompactExpanded(false);
    }
  } catch (error) {
    reportInteractionError(error);
  } finally {
    state.hoverProbeInFlight = false;
  }
}

function pointerEventFromCursorState(cursorState) {
  const cursor = cursorState?.cursor;
  const bounds = cursorState?.windowBounds;
  if (!cursor || !bounds) return null;
  return {
    clientX: cursor.x - bounds.x,
    clientY: cursor.y - bounds.y
  };
}

function startCompactMove(event) {
  if (!state.compact || event.button !== 0) return;
  if (!isInsideCompactDragArea(event)) return;
  event.preventDefault();
  event.stopPropagation();
  setCompactMousePassthrough(false);
  state.moving = {
    lastX: event.screenX,
    lastY: event.screenY,
    pendingDeltaX: 0,
    pendingDeltaY: 0,
    movePromise: Promise.resolve()
  };
  els.body.classList.add("is-moving");
  syncCompactHoverProbe();
  window.addEventListener("mousemove", handleCompactMove);
  window.addEventListener("mouseup", stopCompactMove, { once: true });
}

function isInsideCompactDragArea(event) {
  if (isTopStripMode()) return isInsideCompactVisibleSurface(event);
  return isInsideCompactHudCapsule(event);
}

function isInsideCompactVisibleSurface(event) {
  if (isTopStripMode()) {
    return isInsideElementRect(event, els.compactHud);
  }
  if (isInsideCompactHudCapsule(event)) return true;
  if (!state.compactExpanded) return false;
  return [els.compactControls, els.compactAdviceText, els.compactResetInfo, els.compactResizeHandle].some((element) =>
    isInsideElementRect(event, element)
  );
}

function isInsideElementRect(event, element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function isInsideCompactHudCapsule(event) {
  const rect = els.compactHud.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;

  const radius = rect.height / 2;
  if (x < radius) {
    return Math.hypot(x - radius, y - radius) <= radius;
  }
  if (x > rect.width - radius) {
    return Math.hypot(x - (rect.width - radius), y - radius) <= radius;
  }
  return true;
}

function handleCompactMove(event) {
  if (!state.moving) return;
  event.preventDefault();
  const deltaX = event.screenX - state.moving.lastX;
  const deltaY = event.screenY - state.moving.lastY;
  state.moving.lastX = event.screenX;
  state.moving.lastY = event.screenY;
  state.moving.pendingDeltaX += deltaX;
  state.moving.pendingDeltaY += deltaY;
  scheduleCompactMove();
}

function scheduleCompactMove() {
  if (!state.moving || state.moveFrame) return;

  state.moveFrame = window.requestAnimationFrame(() => {
    state.moveFrame = null;
    if (!state.moving) return;
    flushCompactMove();
  });
}

function flushCompactMove() {
  if (!state.moving) return;
  const moving = state.moving;
  const deltaX = state.moving.pendingDeltaX;
  const deltaY = state.moving.pendingDeltaY;
  state.moving.pendingDeltaX = 0;
  state.moving.pendingDeltaY = 0;
  if (deltaX === 0 && deltaY === 0) return moving.movePromise;

  const request = moving.movePromise
    .catch(() => undefined)
    .then(() => window.quotaBridge.moveCompactWindow(deltaX, deltaY));
  moving.movePromise = request.catch(reportInteractionError);
  return moving.movePromise;
}

function stopCompactMove() {
  if (!state.moving) return;
  const moving = state.moving;
  window.removeEventListener("mousemove", handleCompactMove);
  if (state.moveFrame) {
    window.cancelAnimationFrame(state.moveFrame);
    state.moveFrame = null;
  }
  const finishMove = flushCompactMove() || moving.movePromise;
  els.body.classList.remove("is-moving");
  state.moving = null;
  syncCompactHoverProbe();
  finishMove
    .then(() => window.quotaBridge.snapCompactWindow())
    .then((snapResult) => {
      renderCompactDisplayMode(snapResult?.displayMode);
      updateCompactMousePassthrough();
    })
    .catch(reportInteractionError);
}

els.langBtn.addEventListener("click", () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  if (state.quota) {
    renderQuota(state.quota);
  } else if (state.error) {
    renderError(state.error);
  } else {
    renderLoading();
  }
  syncAlwaysOnTop();
});

els.compactBtn.addEventListener("click", async () => {
  const isCompact = await window.quotaBridge.setCompactMode(!state.compact);
  renderCompactMode(isCompact);
});

els.compactExpandBtn.addEventListener("click", async () => {
  const isCompact = await window.quotaBridge.setCompactMode(false);
  renderCompactMode(isCompact);
});

els.compactCloseBtn.addEventListener("click", () => window.quotaBridge.minimize());
els.compactThemeBtn.addEventListener("click", toggleCompactTheme);
window.addEventListener("mousemove", handleCompactPointerMove);
window.addEventListener("mouseout", (event) => {
  if (!event.relatedTarget) setCompactExpanded(false);
});
els.compactHud.addEventListener("mousedown", startCompactMove);
els.compactResizeHandle.addEventListener("mousedown", startCompactResize);

els.refreshBtn.addEventListener("click", refreshQuota);
els.settingsBtn.addEventListener("click", () => window.quotaBridge.openSettings().catch(reportInteractionError));
els.compactSettingsBtn.addEventListener("click", () => window.quotaBridge.openSettings().catch(reportInteractionError));
els.minimizeBtn.addEventListener("click", () => window.quotaBridge.minimize());
els.closeBtn.addEventListener("click", () => window.quotaBridge.close());
els.pinBtn.addEventListener("click", async () => {
  const next = !els.pinBtn.classList.contains("active");
  const isPinned = await window.quotaBridge.setAlwaysOnTop(next);
  renderPin(isPinned);
});

renderCompactTheme(loadCompactTheme(), { persist: false });
renderSignalSettings(state.signalSettings);

window.quotaBridge.onQuotaChanged(renderQuotaState);
window.quotaBridge.onAlwaysOnTopChanged(renderPin);
window.quotaBridge.onCompactChanged(renderCompactMode);
window.quotaBridge.onCompactScaleChanged((value) => {
  if (state.resizing) return;
  renderCompactScale(value);
});
window.quotaBridge.onCompactDisplayModeChanged(renderCompactDisplayMode);
window.quotaBridge.onSignalSettingsChanged(renderSignalSettings);

renderArchBadge();
window.quotaBridge
  .getAppVersion()
  .then((version) => {
    appVersion = version || "";
    renderArchBadge();
  })
  .catch(() => {});

els.updateBtn.addEventListener("click", async () => {
  const current = els.updateBtn.dataset.state;
  if (current === "checking") return;
  if (current === "available") {
    window.quotaBridge.openReleasePage().catch(reportInteractionError);
    return;
  }
  els.updateBtn.dataset.state = "checking";
  els.updateBtn.title = "檢查更新中…";
  try {
    renderUpdateState(await window.quotaBridge.checkForUpdate());
  } catch (error) {
    renderUpdateState({ updateAvailable: false });
    reportInteractionError(error);
  }
});
window.quotaBridge.onUpdateStateChanged(renderUpdateState);
window.quotaBridge.getUpdateState().then(renderUpdateState).catch(() => {});

renderLoading();
syncAlwaysOnTop();
syncCompactMode();
syncCompactDisplayMode();
syncCompactScale();
window.quotaBridge.getSignalSettings().then(renderSignalSettings).catch(reportInteractionError);
window.quotaBridge.getQuotaState().then(renderQuotaState).catch(renderError);

// 讓重置倒數每分鐘自己走，不必等下一次額度刷新
window.setInterval(() => {
  if (!state.quota || state.loading) return;
  setText(els.primaryText, formatWindow(state.quota.primary));
  setText(els.secondaryText, formatWindow(state.quota.secondary));
  setText(els.compactWeeklyResetText, compactResetDetail(state.quota.secondary));
  setText(els.compactShortResetText, compactResetDetail(state.quota.primary));
}, 30000);
