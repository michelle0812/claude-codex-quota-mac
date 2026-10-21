"use strict";

const { BrowserWindow, session, safeStorage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeSnapshot } = require("./quota-service");

const GROK_ORIGIN = "https://grok.com";
const LOGIN_URL = "https://grok.com/";
const CREDENTIALS_FILE_NAME = "grok-web-credentials.json";
const CREDENTIALS_VERSION = 1;

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ALLOWED_LOGIN_DOMAINS = [
  "grok.com",
  "x.ai",
  "twitter.com",
  "x.com",
  "auth.x.ai",
  "accounts.google.com",
  "appleid.apple.com"
];

let credentialsFilePath = null;

function configure(userDataPath) {
  if (!userDataPath) {
    throw new Error("grok-web-service 需要 userDataPath。");
  }
  credentialsFilePath = path.join(userDataPath, CREDENTIALS_FILE_NAME);
}

function ensureConfigured() {
  if (!credentialsFilePath) {
    throw new Error("grok-web-service 尚未 configure()。");
  }
}

async function readRawCredentials() {
  ensureConfigured();
  try {
    const raw = await fs.readFile(credentialsFilePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadCredentials() {
  const raw = await readRawCredentials();
  if (!raw) return null;
  let cookies = raw.cookies;
  if (raw.cookiesEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(raw.cookiesEncrypted, "base64"));
      cookies = JSON.parse(decrypted);
    } catch {
      // Fall back to plain cookies if any
    }
  }
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) return null;
  return {
    cookies,
    email: raw.email || null,
    name: raw.name || null
  };
}

async function hasSession() {
  return Boolean(await loadCredentials());
}

async function saveCredentials({ cookies, email = null, name = null }) {
  ensureConfigured();
  const payload = {
    version: CREDENTIALS_VERSION,
    email,
    name,
    savedAt: new Date().toISOString()
  };
  const jsonStr = JSON.stringify(cookies);
  if (safeStorage.isEncryptionAvailable()) {
    payload.cookiesEncrypted = safeStorage.encryptString(jsonStr).toString("base64");
  } else {
    payload.cookies = cookies;
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
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: "grok.com" });
    for (const c of cookies) {
      await session.defaultSession.cookies.remove(GROK_ORIGIN, c.name);
    }
  } catch {
    // Ignore
  }
}

async function restoreCookies(cookies) {
  if (!Array.isArray(cookies)) return;
  for (const c of cookies) {
    try {
      await session.defaultSession.cookies.set({
        url: GROK_ORIGIN,
        name: c.name,
        value: c.value,
        domain: c.domain || ".grok.com",
        path: c.path || "/",
        secure: c.secure !== false,
        httpOnly: Boolean(c.httpOnly)
      });
    } catch {
      // Ignore individual cookie errors
    }
  }
}

function isAllowedLoginUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_LOGIN_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function captureWebSession() {
  return new Promise((resolve, reject) => {
    const loginWin = new BrowserWindow({
      width: 1020,
      height: 740,
      title: "登入 Grok (grok.com)",
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let settled = false;
    let pollTimer = null;

    const checkCookiesAndFinish = async () => {
      if (settled) return;
      try {
        const cookies = await session.defaultSession.cookies.get({ domain: "grok.com" });
        const ssoCookie = cookies.find((c) => c.name === "sso" || c.name === "sso-rw" || c.name.includes("session"));
        if (ssoCookie && ssoCookie.value) {
          finish(resolve, cookies);
        }
      } catch {
        // Continue polling
      }
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (!loginWin.isDestroyed()) loginWin.close();
      fn(arg);
    };

    pollTimer = setInterval(checkCookiesAndFinish, 1000);

    loginWin.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedLoginUrl(url)) {
        event.preventDefault();
        console.warn(`[Grok 登入] 擋下非信任網域：${url}`);
      }
    });

    loginWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    loginWin.on("closed", () => finish(reject, new Error("登入視窗已關閉")));
    loginWin.loadURL(LOGIN_URL, { userAgent: CHROME_USER_AGENT });
  });
}

async function login() {
  ensureConfigured();
  const cookies = await captureWebSession();
  await saveCredentials({ cookies });
  return { success: true };
}

function fetchWebRateLimitsViaWindow() {
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

    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
      reject(new Error("讀取 grok.com 逾時（可能遭 Cloudflare 阻擋或需重新登入）"));
    }, 20000);

    win.webContents.on("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const res = await fetch("https://grok.com/rest/rate-limits", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestKind: "DEFAULT" })
              });
              const text = await res.text();
              let limits = null;
              try { limits = JSON.parse(text); } catch(e) { return { html: text.slice(0, 300) }; }

              let sessionData = null;
              try {
                const sRes = await fetch("https://grok.com/api/auth/session");
                sessionData = await sRes.json();
              } catch(e) {}

              return { limits, session: sessionData };
            } catch(e) {
              return { error: e.message };
            }
          })()
        `);
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
        reject(err);
      }
    });

    win.webContents.on("did-fail-load", (_event, code, desc) => {
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      reject(new Error(`載入 grok.com 失敗: ${code} ${desc}`));
    });

    win.loadURL("https://grok.com", { userAgent: CHROME_USER_AGENT });
  });
}

async function getWebQuota(now = Date.now()) {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new Error("尚未登入 grok.com，請點擊齒輪進行網頁登入。");
  }
  await restoreCookies(credentials.cookies);

  const payload = await fetchWebRateLimitsViaWindow();
  if (payload?.error) {
    throw new Error(`grok.com 抓取失敗: ${payload.error}`);
  }

  const limits = payload?.limits;
  if (!limits || typeof limits !== "object") {
    throw new Error("grok.com 未回傳額度資料，請重新登入。");
  }

  const defaultLimit = limits.DEFAULT || limits.REASONING || Object.values(limits)[0];
  if (!defaultLimit || typeof defaultLimit.total !== "number") {
    throw new Error("grok.com 額度格式不相容。");
  }

  const total = defaultLimit.total || 1;
  const remaining = typeof defaultLimit.remaining === "number" ? defaultLimit.remaining : total;
  const used = Math.max(0, total - remaining);
  const usedPercent = Math.min(100, Math.round((used / total) * 100));

  const windowSeconds = defaultLimit.windowSizeSeconds || 7200;
  const windowDurationMins = Math.round(windowSeconds / 60);
  const resetsAt = new Date(now + windowSeconds * 1000).toISOString();

  // Check if weekly/compute pool exists in payload
  let secondary = null;
  const weeklyPool = limits.COMPUTE_POOL || limits.WEEKLY || null;
  if (weeklyPool && typeof weeklyPool.total === "number") {
    const secTotal = weeklyPool.total || 1;
    const secRem = typeof weeklyPool.remaining === "number" ? weeklyPool.remaining : secTotal;
    const secUsed = Math.max(0, secTotal - secRem);
    secondary = {
      usedPercent: Math.min(100, Math.round((secUsed / secTotal) * 100)),
      remainingPercent: Math.round((secRem / secTotal) * 100),
      windowDurationMins: 10080,
      resetsAt: weeklyPool.resetsAt ? new Date(weeklyPool.resetsAt).toISOString() : null
    };
  }

  const user = payload?.session?.user || null;
  const email = user?.email || credentials.email || null;
  const name = user?.name || credentials.name || null;

  const rawSnapshot = {
    limitId: "grok-web",
    limitName: "Grok (Web Quota)",
    planType: user?.plan || "SuperGrok / Grok Web",
    reachedType: null,
    primary: {
      usedPercent,
      windowDurationMins,
      resetsAt
    },
    secondary,
    account: {
      id: user?.id || "grok-web-user",
      email,
      name
    },
    sessionSummary: `網頁額度: 剩餘 ${remaining} / ${total} 次 (每 ${windowDurationMins >= 60 ? (windowDurationMins / 60).toFixed(1) + " 小時" : windowDurationMins + " 分"} 重置)`
  };

  return normalizeSnapshot(rawSnapshot, now);
}

module.exports = {
  configure,
  hasSession,
  login,
  logout: clearCredentials,
  getWebQuota
};
