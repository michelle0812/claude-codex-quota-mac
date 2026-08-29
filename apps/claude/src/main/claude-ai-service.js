const { BrowserWindow, session, safeStorage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeSnapshot, readPlan } = require("./quota-service");

// claude.ai 沒有公開的用量 API，但登入後的 session cookie（sessionKey）可以打
// https://claude.ai/api/organizations/<org>/usage 拿到帳號級別的 5 小時 / 7 天用量。
// 這條路不受「哪台機器在跑 Claude Code」影響，適合放在沒有本機 statusLine 資料的機器上。
//
// claude.ai 走 Cloudflare，會擋掉 Electron 預設的 request headers，所以：
//   1. 登入用一個正常的 BrowserWindow 打開 https://claude.ai/login，登完攔 sessionKey cookie。
//   2. 抓資料用隱藏 BrowserWindow 載入 API URL，讀 document body 的純文字再 JSON.parse，
//      藉此沿用瀏覽器 session 並帶上 Chrome User-Agent 繞過 bot 偵測。
// 做法參考自舊版 SlavomirDurej/claude-usage-widget。

const CLAUDE_ORIGIN = "https://claude.ai";
const LOGIN_URL = "https://claude.ai/login";
const ORGANIZATIONS_URL = "https://claude.ai/api/organizations";
const CREDENTIALS_FILE_NAME = "claude-ai-credentials.json";
const CREDENTIALS_VERSION = 1;

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const SEVEN_DAY_WINDOW_MINS = 7 * 24 * 60;

// 登入視窗只允許導向 claude.ai 本身與常見的 OAuth 供應商，避免被導到釣魚頁。
const ALLOWED_LOGIN_DOMAINS = [
  "claude.ai",
  "anthropic.com",
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com"
];

// claude.ai 擋掉或改版時回傳的已知訊號；抓到就丟出可辨識的錯誤讓上層決定要不要要求重新登入。
const BLOCKED_SIGNATURES = [
  { pattern: "Just a moment", error: "CloudflareBlocked" },
  { pattern: "Enable JavaScript and cookies to continue", error: "CloudflareChallenge" },
  { pattern: "<html", error: "UnexpectedHTML" }
];

let credentialsFilePath = null;

function configure(userDataPath) {
  if (!userDataPath) {
    throw new Error("claude-ai-service 需要 userDataPath。");
  }
  credentialsFilePath = path.join(userDataPath, CREDENTIALS_FILE_NAME);
}

function ensureConfigured() {
  if (!credentialsFilePath) {
    throw new Error("claude-ai-service 尚未 configure()。");
  }
}

async function readRawCredentials() {
  ensureConfigured();
  try {
    const parsed = JSON.parse(await fs.readFile(credentialsFilePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`讀取 claude.ai 憑證失敗：${error.message}`);
    }
    return null;
  }
}

function decryptSessionKey(raw) {
  if (raw?.sessionKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(raw.sessionKeyEncrypted, "base64"));
    } catch (error) {
      console.warn(`解密 claude.ai sessionKey 失敗：${error.message}`);
      return null;
    }
  }
  return raw?.sessionKey || null;
}

async function loadCredentials() {
  const raw = await readRawCredentials();
  if (!raw) return null;
  const sessionKey = decryptSessionKey(raw);
  if (!sessionKey || !raw.organizationId) return null;
  return { sessionKey, organizationId: raw.organizationId };
}

async function hasSession() {
  return Boolean(await loadCredentials());
}

async function saveCredentials({ sessionKey, organizationId }) {
  ensureConfigured();
  const payload = {
    version: CREDENTIALS_VERSION,
    organizationId,
    savedAt: new Date().toISOString()
  };
  if (safeStorage.isEncryptionAvailable()) {
    payload.sessionKeyEncrypted = safeStorage.encryptString(sessionKey).toString("base64");
  } else {
    payload.sessionKey = sessionKey;
  }
  const tempPath = `${credentialsFilePath}.tmp`;
  await fs.mkdir(path.dirname(credentialsFilePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, credentialsFilePath);
}

async function clearCredentials() {
  ensureConfigured();
  try {
    await fs.unlink(credentialsFilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await session.defaultSession.cookies.remove(CLAUDE_ORIGIN, "sessionKey");
  } catch {
    /* cookie 本來就不在就算了 */
  }
}

async function setSessionCookie(sessionKey) {
  await session.defaultSession.cookies.set({
    url: CLAUDE_ORIGIN,
    name: "sessionKey",
    value: sessionKey,
    domain: ".claude.ai",
    path: "/",
    secure: true,
    httpOnly: true
  });
}

function parseResponseBody(bodyText) {
  const text = typeof bodyText === "string" ? bodyText : "";
  for (const signature of BLOCKED_SIGNATURES) {
    if (text.includes(signature.pattern)) {
      throw new Error(`${signature.error}: ${text.substring(0, 200)}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`InvalidJSON: ${text.substring(0, 200)}`);
  }
}

function isBlockedError(error) {
  const message = error?.message || "";
  return (
    message.startsWith("CloudflareBlocked") ||
    message.startsWith("CloudflareChallenge") ||
    message.startsWith("UnexpectedHTML")
  );
}

function fetchJsonViaWindow(url, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      fn(arg);
    };

    const timer = setTimeout(() => finish(reject, new Error("RequestTimeout")), timeoutMs);

    win.webContents.on("did-finish-load", async () => {
      try {
        const body = await win.webContents.executeJavaScript(
          "document.body.innerText || document.body.textContent"
        );
        finish(resolve, parseResponseBody(body));
      } catch (error) {
        finish(reject, error);
      }
    });

    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      finish(reject, new Error(`LoadFailed: ${errorCode} ${errorDescription}`));
    });

    win.loadURL(url, { userAgent: CHROME_USER_AGENT });
  });
}

async function fetchOrganizationId() {
  const data = await fetchJsonViaWindow(ORGANIZATIONS_URL);
  if (!Array.isArray(data) || data.length === 0) {
    if (data && data.error) {
      throw new Error(typeof data.error === "string" ? data.error : data.error.message || "claude.ai 回傳錯誤");
    }
    throw new Error("claude.ai 沒有回傳任何組織資料");
  }
  const chatOrgs = data.filter((org) => Array.isArray(org?.capabilities) && org.capabilities.includes("chat"));
  const pool = chatOrgs.length > 0 ? chatOrgs : data;
  const org = pool.find((entry) => entry.raven_type === "team") || pool[0];
  const organizationId = org.uuid || org.id;
  if (!organizationId) {
    throw new Error("claude.ai 組織資料缺少 uuid");
  }
  return organizationId;
}

function isAllowedLoginUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_LOGIN_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

// 為什麼不把登入頁直接嵌在小工具視窗裡：claude.ai 透過 Cloudflare 會偵測並擋掉
// Electron 內嵌的登入。開一個獨立視窗讓使用者正常登入，再攔 sessionKey cookie。
function captureSessionKey() {
  return new Promise((resolve, reject) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 720,
      title: "登入 claude.ai",
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let settled = false;

    const onCookieChanged = (_event, cookie, _cause, removed) => {
      if (
        cookie.name === "sessionKey" &&
        cookie.domain.includes("claude.ai") &&
        !removed &&
        cookie.value
      ) {
        finish(resolve, cookie.value);
      }
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      session.defaultSession.cookies.removeListener("changed", onCookieChanged);
      if (!loginWin.isDestroyed()) loginWin.close();
      fn(arg);
    };

    session.defaultSession.cookies.on("changed", onCookieChanged);

    loginWin.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedLoginUrl(url)) {
        event.preventDefault();
        console.warn(`[登入] 擋下非信任網域：${url}`);
      }
    });

    loginWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    loginWin.on("closed", () => finish(reject, new Error("登入視窗已關閉")));

    loginWin.loadURL(LOGIN_URL, { userAgent: CHROME_USER_AGENT });
  });
}

async function login() {
  ensureConfigured();
  try {
    await session.defaultSession.cookies.remove(CLAUDE_ORIGIN, "sessionKey");
  } catch {
    /* ignore */
  }
  const sessionKey = await captureSessionKey();
  await setSessionCookie(sessionKey);
  const organizationId = await fetchOrganizationId();
  await saveCredentials({ sessionKey, organizationId });
  return { organizationId };
}

function toWindow(raw, windowDurationMins) {
  if (!raw || raw.utilization === undefined || raw.utilization === null) {
    return null;
  }
  const resetsAtMs = raw.resets_at ? Date.parse(raw.resets_at) : NaN;
  return {
    usedPercent: Number(raw.utilization),
    resetsAt: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : null,
    windowDurationMins
  };
}

async function getQuota() {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new Error("尚未登入 claude.ai");
  }
  await setSessionCookie(credentials.sessionKey);

  const usageUrl = `${CLAUDE_ORIGIN}/api/organizations/${credentials.organizationId}/usage`;
  let data;
  try {
    data = await fetchJsonViaWindow(usageUrl);
  } catch (error) {
    if (isBlockedError(error)) {
      await clearCredentials();
      throw new Error("claude.ai 登入已失效，請重新登入。");
    }
    throw error;
  }

  const fiveHour = data?.five_hour;
  const sevenDay = data?.seven_day;
  if (!fiveHour && !sevenDay) {
    throw new Error("claude.ai 回傳的用量資料缺少 five_hour / seven_day 區塊。");
  }

  const plan = await readPlan();
  const snapshot = {
    limitId: "claude",
    limitName: "Claude Code",
    planType: plan || "Claude Code",
    rateLimitReachedType: null,
    credits: null,
    primary: toWindow(fiveHour, FIVE_HOUR_WINDOW_MINS),
    secondary: toWindow(sevenDay, SEVEN_DAY_WINDOW_MINS)
  };

  return { ...normalizeSnapshot(snapshot), source: "claude.ai" };
}

module.exports = {
  configure,
  login,
  logout: clearCredentials,
  hasSession,
  getQuota
};
