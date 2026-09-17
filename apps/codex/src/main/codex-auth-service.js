"use strict";

// 設定視窗（齒輪）裡的「ChatGPT 帳號登入」。每個 profile 一份，登入結果寫進該 profile 的
// <CODEX_HOME>/auth.json，格式跟 `codex login` 寫的一樣，所以 Codex CLI 也讀得懂。
//
// 流程跟 Codex CLI 的瀏覽器登入相同（參數取自 codex-cli 0.154.0 的 login/src/server.rs）：
//   1. 產生 PKCE verifier/challenge 與 state
//   2. 開 https://auth.openai.com/oauth/authorize?...，redirect_uri=http://localhost:1455/auth/callback
//   3. CLI 會在 1455 埠起本機 server 接 code；我們是 App 內視窗，直接在 webRequest 攔下那個網址，
//      不用佔埠，也不會跟正在跑的 `codex login` 撞埠
//   4. POST /oauth/token（form-urlencoded, grant_type=authorization_code）換 token
//
// 登入視窗用「每次新開、不落地」的 session partition：瀏覽器裡已登入的帳號不會被自動帶進來，
// 三個面板才能各登各的帳號。

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { BrowserWindow, session } = require("electron");
const {
  OAUTH_CLIENT_ID,
  TOKEN_URL,
  readAuthFile,
  writeAuthFileAtomically,
  decodeJwtPayload
} = require("./quota-service");

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "codex_cli_rs";
const TOKEN_TIMEOUT_MS = 20000;
// OpenAI / Google 對「Electron」字樣的 UA 會比較刁難，登入視窗用一般 Chrome 的 UA。
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl({ challenge, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// 解析 callback 網址；不是 callback 回 null，state 不符或 OAuth 回錯誤就丟例外。
function parseCallbackUrl(url, expectedState) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (`${parsed.origin}${parsed.pathname}` !== REDIRECT_URI) return null;

  const error = parsed.searchParams.get("error");
  if (error) {
    const description = parsed.searchParams.get("error_description");
    throw new Error(`ChatGPT 登入失敗：${description || error}`);
  }
  if (parsed.searchParams.get("state") !== expectedState) {
    throw new Error("ChatGPT 登入失敗：state 不符，已中止（請重試）");
  }
  const code = parsed.searchParams.get("code");
  if (!code) throw new Error("ChatGPT 登入失敗：回呼網址沒有 code");
  return code;
}

// 開 App 內登入視窗，等到 OpenAI 導回 callback，回傳 authorization code。
function captureAuthorizationCode({ authorizeUrl, state, title }) {
  return new Promise((resolve, reject) => {
    const partition = `codex-login-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const loginSession = session.fromPartition(partition, { cache: false });
    const loginWin = new BrowserWindow({
      width: 520,
      height: 760,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        session: loginSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    let settled = false;
    const popups = new Set();
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      loginSession.webRequest.onBeforeRequest(null);
      for (const popup of popups) if (!popup.isDestroyed()) popup.close();
      if (!loginWin.isDestroyed()) loginWin.close();
      loginSession.clearStorageData().catch(() => {});
      fn(arg);
    };

    loginSession.webRequest.onBeforeRequest({ urls: ["http://localhost:1455/*"] }, (details, callback) => {
      callback({ cancel: true });
      try {
        const code = parseCallbackUrl(details.url, state);
        if (code) finish(resolve, code);
      } catch (error) {
        finish(reject, error);
      }
    });

    // 登入頁會開 Google 等小彈窗。讓它照常以子視窗開（同一個 session，callback 一樣攔得到），
    // 不能把網址搶進主視窗載入：那樣 OpenAI 登入頁一打開就被帶去 Google，沒機會選 Email 登入。
    loginWin.webContents.setWindowOpenHandler(({ url }) => {
      if (!/^https:\/\//.test(url)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 500,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: { session: loginSession, nodeIntegration: false, contextIsolation: true, sandbox: true }
        }
      };
    });
    loginWin.webContents.on("did-create-window", (popup) => {
      popups.add(popup);
      popup.webContents.setUserAgent(CHROME_USER_AGENT);
      popup.on("closed", () => popups.delete(popup));
    });

    loginWin.on("closed", () => finish(reject, new Error("登入視窗已關閉，未完成登入")));
    loginWin.loadURL(authorizeUrl, { userAgent: CHROME_USER_AGENT }).catch((error) => {
      // callback 被我們 cancel 時 loadURL 也會 reject（ERR_BLOCKED_BY_CLIENT），那不算失敗。
      if (!settled && !/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(String(error?.message))) {
        finish(reject, new Error(`無法開啟 ChatGPT 登入頁：${error.message}`));
      }
    });
  });
}

async function exchangeCode({ code, verifier }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: verifier
      }).toString(),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error?.name === "AbortError" ? "換取 ChatGPT token 逾時" : `換取 ChatGPT token 連線失敗：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) throw new Error(`換取 ChatGPT token 失敗：HTTP ${response.status} ${text.slice(0, 200)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("換取 ChatGPT token 的回應不是 JSON");
  }
  if (!data.id_token || !data.access_token || !data.refresh_token) {
    throw new Error("換取 ChatGPT token 的回應缺少 id_token / access_token / refresh_token");
  }
  return data;
}

// 組出跟 `codex login` 相同格式的 auth.json 內容。
function buildAuthJson(tokenResponse, now = new Date()) {
  const claims = decodeJwtPayload(tokenResponse.id_token) || {};
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokenResponse.id_token,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      account_id: accountId
    },
    last_refresh: now.toISOString()
  };
}

function createCodexAuth({ authFilePath, profileName }) {
  async function hasSession() {
    try {
      await readAuthFile(authFilePath);
      return true;
    } catch {
      return false;
    }
  }

  async function login() {
    const { verifier, challenge } = createPkce();
    const state = base64url(crypto.randomBytes(24));
    const code = await captureAuthorizationCode({
      authorizeUrl: buildAuthorizeUrl({ challenge, state }),
      state,
      title: profileName ? `登入 ChatGPT（${profileName}）` : "登入 ChatGPT"
    });
    const tokens = await exchangeCode({ code, verifier });
    const authJson = buildAuthJson(tokens);
    await writeAuthFileAtomically(authFilePath, authJson);
    const email = decodeJwtPayload(tokens.id_token)?.email || null;
    return { email };
  }

  // 登出不直接刪：改名成 auth.json.logout-<時間>，萬一登出錯帳號還救得回來。
  async function logout() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      await fs.rename(authFilePath, `${authFilePath}.logout-${stamp}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return { hasSession, login, logout };
}

module.exports = {
  REDIRECT_URI,
  createCodexAuth,
  createPkce,
  buildAuthorizeUrl,
  parseCallbackUrl,
  buildAuthJson
};
