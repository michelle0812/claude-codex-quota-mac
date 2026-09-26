"use strict";

// 設定視窗（齒輪）裡的「ChatGPT 帳號登入」。每個 profile 一份，登入結果寫進該 profile 的
// <CODEX_HOME>/auth.json，格式跟 `codex login` 寫的一樣，所以 Codex CLI 也讀得懂。
//
// 使用系統瀏覽器完成驗證，透過僅綁定 loopback 的 HTTP server 接回 PKCE code。
// 各面板仍寫入自己的 auth.json；瀏覽器的帳號需由使用者確認。

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
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
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

  if (parsed.searchParams.get("state") !== expectedState) {
    throw new Error("ChatGPT 登入失敗：state 不符，已中止（請重試）");
  }
  const error = parsed.searchParams.get("error");
  if (error) {
    const description = parsed.searchParams.get("error_description");
    throw new Error(`ChatGPT 登入失敗：${description || error}`);
  }
  const code = parsed.searchParams.get("code");
  if (!code) throw new Error("ChatGPT 登入失敗：回呼網址沒有 code");
  return code;
}

// 先監聽再開瀏覽器；同時登入另一個面板時會明確回報埠被占用。
function captureAuthorizationCode({
  authorizeUrl,
  state,
  openExternal = (url) => require("electron").shell.openExternal(url),
  port = 1455,
  timeoutMs = LOGIN_TIMEOUT_MS
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((request, response) => {
      const reply = (status, message) => {
        response.writeHead(status, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Connection": "close"
        });
        response.end(message);
      };
      let url;
      try {
        url = new URL(request.url, REDIRECT_URI);
      } catch {
        reply(400, "無效的登入回呼。");
        return;
      }
      if (request.method !== "GET" || `${url.origin}${url.pathname}` !== REDIRECT_URI) {
        reply(404, "找不到此頁面。");
        return;
      }
      // 過期分頁或其他登入流程不得中止這次登入。
      if (url.searchParams.get("state") !== state) {
        reply(400, "登入驗證不符，請使用這次開啟的登入分頁。");
        return;
      }
      try {
        const code = parseCallbackUrl(url.href, state);
        reply(200, "已收到授權回覆，請回到 Codex 額度確認登入結果。此分頁可以關閉。");
        finish(null, code);
      } catch (error) {
        response.once("finish", () => finish(error));
        reply(400, "登入未完成，請回到 Codex 額度重試。");
      }
    });
    const timer = setTimeout(() => finish(new Error("等待瀏覽器登入逾時，請重新點選登入 ChatGPT")), timeoutMs);
    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) server.closeAllConnections();
      else server.closeIdleConnections();
      if (error) reject(error);
      else resolve(code);
    }
    server.on("error", (error) => finish(new Error(error.code === "EADDRINUSE"
      ? "登入連接埠 1455 已被占用，請先完成其他面板或 Codex CLI 的登入，再重試"
      : `無法啟動登入回呼：${error.message}`)));
    server.listen(port, "127.0.0.1", () => {
      if (settled) {
        server.close();
        return;
      }
      Promise.resolve().then(() => openExternal(authorizeUrl)).catch(() => {
        finish(new Error("無法開啟系統瀏覽器，請確認預設瀏覽器設定後重試"));
      });
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

function createCodexAuth({ authFilePath }) {
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
      state
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
  captureAuthorizationCode,
  buildAuthorizeUrl,
  parseCallbackUrl,
  buildAuthJson
};
