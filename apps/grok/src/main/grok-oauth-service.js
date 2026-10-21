"use strict";

// 設定視窗（齒輪）裡的「xAI 帳號登入」。走跟官方 `grok login` 相同的 OIDC 流程：
// 系統瀏覽器 + PKCE + 只綁 127.0.0.1 的 loopback callback，換到的 token 存在這個
// profile 自己的 userData/grok-oauth.json，不讀也不改 ~/.grok/auth.json。
//
// 用量來源是官方 CLI 的 billing 路徑：GET <cli-chat-proxy>/billing?format=credits，
// 回應外層是 { config: { creditUsagePercent, currentPeriod: { type, start, end }, ... } }。
// 協定依據：github.com/xai-org/grok-build 的 xai-grok-login（config.rs、oidc/login.rs、
// oidc/protocol.rs）與 xai-grok-shell/src/extensions/billing.rs。

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { normalizeSnapshot } = require("./quota-service");

const ISSUER = "https://auth.x.ai";
// 官方 Grok Build CLI 的公開 OAuth client（PKCE，無 client secret）。
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPES = [
  "openid", "profile", "email", "offline_access", "grok-cli:access", "api:access",
  "conversations:read", "conversations:write", "workspaces:read", "workspaces:write"
];
const REFERRER = "grok-build";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const TOKEN_AUTH_HEADER = "xai-grok-cli";
// billing 端點要求 x-grok-client-version；對齊本機已驗證過的 CLI 版本。
const GROK_CLIENT_VERSION = "1.0.62";
const TEAM_PRINCIPAL_TYPE = "Team";

const STORE_FILE_NAME = "grok-oauth.json";
const STORE_VERSION = 1;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;

const PERIOD_NAMES = {
  USAGE_PERIOD_TYPE_WEEKLY: "每週",
  USAGE_PERIOD_TYPE_MONTHLY: "每月"
};

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// 錯誤訊息只留 OAuth 的 error 欄位或 HTTP 狀態，不把回應本文（可能含 token）帶出去。
function describeHttpError(status, text) {
  let code = null;
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === "string") code = body.error;
    else if (typeof body?.error?.message === "string") code = body.error.message;
  } catch {
    // 不是 JSON 就只回狀態碼
  }
  return code ? `HTTP ${status}（${code.slice(0, 120)}）` : `HTTP ${status}`;
}

async function fetchWithTimeout(fetchImpl, url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new Error(error?.name === "AbortError" ? `${label}逾時` : `${label}連線失敗：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${label}失敗：${describeHttpError(response.status, text)}`);
    error.status = response.status;
    try { error.oauthError = JSON.parse(text)?.error; } catch { /* 非 JSON */ }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}的回應不是 JSON`);
  }
}

async function discover(fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, `${ISSUER}/.well-known/openid-configuration`, {}, "讀取 xAI 登入設定");
  const doc = await readJson(response, "讀取 xAI 登入設定");
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error("xAI 登入設定缺少 authorization／token endpoint");
  return doc;
}

function buildAuthorizeUrl({ authorizationEndpoint, redirectUri, challenge, state, nonce }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    referrer: REFERRER
  });
  return `${authorizationEndpoint}?${params.toString()}`;
}

function callbackPage(title, message) {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">`
    + `<div style="text-align:center"><h1 style="font-size:18px">${title}</h1><p>${message}</p></div></body></html>`;
}

// 先在隨機埠監聽（跟官方 CLI 一樣讓系統挑），拿到 redirect_uri 後才開瀏覽器。
function captureAuthorizationCode({ buildUrl, state, openExternal, timeoutMs = LOGIN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let redirectUri = null;
    const server = http.createServer((request, response) => {
      const reply = (status, title, message) => {
        response.writeHead(status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Connection": "close"
        });
        response.end(callbackPage(title, message));
      };
      let url;
      try {
        url = new URL(request.url, redirectUri);
      } catch {
        reply(400, "無效的登入回呼", "請回到 Grok 額度重試。");
        return;
      }
      if (request.method !== "GET" || url.pathname !== "/callback") {
        reply(404, "找不到此頁面", "");
        return;
      }
      // 過期分頁或別的登入流程不得中止這次登入。
      if (url.searchParams.get("state") !== state) {
        reply(400, "登入驗證不符", "請使用這次開啟的登入分頁。");
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const description = url.searchParams.get("error_description");
        response.once("finish", () => finish(new Error(`xAI 登入未完成：${(description || oauthError).slice(0, 200)}`)));
        reply(400, "登入未完成", "請回到 Grok 額度重試。");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        reply(400, "登入回呼缺少授權碼", "請回到 Grok 額度重試。");
        return;
      }
      reply(200, "已收到授權", "請回到 Grok 額度確認登入結果，此分頁可以關閉。");
      finish(null, { code, redirectUri });
    });
    const timer = setTimeout(() => finish(new Error("等待瀏覽器登入逾時，請重新點選登入")), timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) server.closeAllConnections();
      else server.closeIdleConnections();
      if (error) reject(error);
      else resolve(result);
    }
    server.on("error", (error) => finish(new Error(`無法啟動登入回呼：${error.message}`)));
    server.listen(0, "127.0.0.1", () => {
      if (settled) {
        server.close();
        return;
      }
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      Promise.resolve()
        .then(() => openExternal(buildUrl(redirectUri)))
        .catch(() => finish(new Error("無法開啟系統瀏覽器，請確認預設瀏覽器設定後重試")));
    });
  });
}

async function postToken(fetchImpl, tokenEndpoint, params, label) {
  const response = await fetchWithTimeout(fetchImpl, tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-grok-client-version": GROK_CLIENT_VERSION
    },
    body: new URLSearchParams(params).toString()
  }, label);
  const data = await readJson(response, label);
  if (!data.access_token) throw new Error(`${label}的回應缺少 access_token`);
  return data;
}

// id_token 直接從 token endpoint 經 TLS 取得（OIDC Core 3.1.3.7），這裡檢查 iss／aud／nonce／exp。
function checkIdToken(idToken, nonce, now = Date.now()) {
  const claims = decodeJwtPayload(idToken);
  if (!claims) throw new Error("xAI 登入回應缺少有效的 id_token");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new Error("xAI id_token 的 issuer 不符");
  if (!aud.includes(CLIENT_ID)) throw new Error("xAI id_token 的 audience 不符");
  if (claims.nonce !== nonce) throw new Error("xAI id_token 的 nonce 不符，已中止");
  if (typeof claims.exp === "number" && claims.exp * 1000 < now - 60000) throw new Error("xAI id_token 已過期");
  if (!claims.sub) throw new Error("xAI id_token 缺少 sub");
  return claims;
}

// 依官方 login.rs：同意畫面選的 principal 寫在 access token；選 Team 時 user_id 用 principal_id。
function buildSession(tokens, { nonce, now = Date.now() }) {
  const access = decodeJwtPayload(tokens.access_token) || {};
  const principalType = access.principal_type || access.principalType || null;
  const principalId = access.principal_id || access.principalId || null;
  const teamId = access.team_id || null;
  let userId;
  let email = null;
  let name = null;
  if (principalType === TEAM_PRINCIPAL_TYPE) {
    if (!principalId) throw new Error("xAI 團隊登入缺少 principal_id");
    userId = principalId;
  } else {
    const claims = checkIdToken(tokens.id_token, nonce, now);
    userId = claims.sub;
    email = claims.email || null;
    name = claims.given_name || claims.first_name || claims.name || null;
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: Number.isFinite(tokens.expires_in) ? new Date(now + tokens.expires_in * 1000).toISOString() : null,
    userId,
    email,
    name,
    principalType: principalType && principalId ? principalType : null,
    principalId: principalType && principalId ? principalId : null,
    teamId: teamId || (principalType === TEAM_PRINCIPAL_TYPE ? principalId : null)
  };
}

function parseTime(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// 官方建議：優先用 creditUsagePercent／currentPeriod，缺了才退回舊欄位。
function billingToSnapshot(body, session, now = Date.now()) {
  const config = body?.config;
  if (!config || typeof config !== "object") throw new Error("xAI 用量回應缺少 config，無法判讀帳號額度");

  let usedPercent = Number(config.creditUsagePercent);
  if (!Number.isFinite(usedPercent)) {
    // proto3 JSON 省略 0 值；有週期卻沒有百分比時，代表用了 0%。
    const limit = Number(config.monthlyLimit?.val);
    const used = Number(config.used?.val ?? 0);
    if (Number.isFinite(limit) && limit > 0) usedPercent = (used / limit) * 100;
    else if (config.currentPeriod) usedPercent = 0;
    else throw new Error("此帳號的 xAI 用量回應沒有 creditUsagePercent，額度暫無法顯示");
  }
  usedPercent = Math.min(100, Math.max(0, usedPercent));

  const period = config.currentPeriod || {};
  const startMs = parseTime(period.start) ?? parseTime(config.billingPeriodStart);
  const endMs = parseTime(period.end) ?? parseTime(config.billingPeriodEnd);
  const periodName = PERIOD_NAMES[period.type] || null;

  const onDemandUsed = Number(config.onDemandUsed?.val);
  const summary = [
    `來源：xAI 帳號用量（${periodName ? `${periodName}週期` : "目前週期"}）`,
    config.isUnifiedBillingUser ? "統一計費" : null,
    Number.isFinite(onDemandUsed) && onDemandUsed > 0 ? `超額用量 $${(onDemandUsed / 100).toFixed(2)}` : null
  ].filter(Boolean).join(" · ");

  return normalizeSnapshot({
    limitId: "grok-account",
    limitName: "Grok 帳號額度",
    planType: periodName ? `Grok（${periodName}額度）` : "Grok 帳號額度",
    reachedType: null,
    primary: null,
    secondary: {
      usedPercent,
      windowDurationMins: startMs !== null && endMs !== null && endMs > startMs ? Math.round((endMs - startMs) / 60000) : null,
      resetsAt: endMs !== null ? new Date(endMs).toISOString() : null
    },
    account: {
      id: crypto.createHash("sha256").update(session.userId).digest("hex"),
      email: session.email,
      name: session.name
    },
    sessionSummary: summary
  }, now);
}

function electronStore() {
  const { safeStorage } = require("electron");
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data, "base64"))
  };
}

function createGrokOAuthService({
  fetchImpl = (...args) => fetch(...args),
  openExternal = (url) => require("electron").shell.openExternal(url),
  cipher = null,
  appVersion = null
} = {}) {
  let storeFile = null;
  let refreshing = null;
  let loginInFlight = null;
  const getCipher = () => cipher || (cipher = electronStore());

  function ensureConfigured() {
    if (!storeFile) throw new Error("grok-oauth-service 尚未 configure()");
  }

  async function load() {
    ensureConfigured();
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(storeFile, "utf8"));
    } catch {
      return null;
    }
    if (raw?.version !== STORE_VERSION) return null;
    try {
      if (raw.encrypted) return JSON.parse(getCipher().decrypt(raw.encrypted));
      return raw.session || null;
    } catch {
      return null;
    }
  }

  async function save(session) {
    ensureConfigured();
    const c = getCipher();
    const payload = c.available()
      ? { version: STORE_VERSION, encrypted: c.encrypt(JSON.stringify(session)) }
      : { version: STORE_VERSION, session };
    const temp = `${storeFile}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    try {
      await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, storeFile);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function refresh(session) {
    if (!session.refreshToken) throw new Error("xAI 登入已過期且沒有 refresh token，請在齒輪重新登入");
    const discovery = await discover(fetchImpl);
    const params = { grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: CLIENT_ID };
    if (session.principalType) params.principal_type = session.principalType;
    if (session.principalId) params.principal_id = session.principalId;
    let tokens;
    try {
      tokens = await postToken(fetchImpl, discovery.token_endpoint, params, "更新 xAI 登入");
    } catch (error) {
      if (error.oauthError === "invalid_grant" || error.oauthError === "invalid_client") {
        throw new Error("xAI 登入已失效，請在齒輪重新登入");
      }
      throw error;
    }
    const next = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || session.refreshToken,
      expiresAt: Number.isFinite(tokens.expires_in) ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null
    };
    await save(next);
    return next;
  }

  async function freshSession({ force = false } = {}) {
    const session = await load();
    if (!session) {
      const error = new Error("尚未登入 xAI 帳號，請按齒輪登入");
      error.code = "GROK_NOT_SIGNED_IN";
      throw error;
    }
    const expMs = parseTime(session.expiresAt);
    if (!force && (expMs === null || expMs - Date.now() > REFRESH_SKEW_MS)) return session;
    if (!refreshing) refreshing = refresh(session).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function requestBilling(session) {
    const userAgent = appVersion
      ? `GrokQuota/${appVersion} grok-shell/${GROK_CLIENT_VERSION} (macos; ${process.arch === "arm64" ? "aarch64" : process.arch})`
      : `grok-shell/${GROK_CLIENT_VERSION} (macos; ${process.arch === "arm64" ? "aarch64" : process.arch})`;
    return fetchWithTimeout(fetchImpl, BILLING_URL, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
        "x-userid": session.userId,
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-client-mode": "headless",
        "User-Agent": userAgent
      }
    }, "讀取 xAI 帳號用量");
  }

  return {
    async configure(userDataPath) {
      if (!userDataPath) throw new Error("grok-oauth-service 需要 userDataPath");
      storeFile = path.join(userDataPath, STORE_FILE_NAME);
    },

    async hasSession() {
      return Boolean(await load());
    },

    async login() {
      if (loginInFlight) throw new Error("已有一個 xAI 登入在進行中，請先在瀏覽器完成或等它逾時");
      loginInFlight = (async () => {
        ensureConfigured();
        const discovery = await discover(fetchImpl);
        const { verifier, challenge } = createPkce();
        const state = base64url(crypto.randomBytes(24));
        const nonce = base64url(crypto.randomBytes(24));
        const { code, redirectUri } = await captureAuthorizationCode({
          state,
          openExternal,
          buildUrl: (uri) => buildAuthorizeUrl({
            authorizationEndpoint: discovery.authorization_endpoint,
            redirectUri: uri,
            challenge,
            state,
            nonce
          })
        });
        const tokens = await postToken(fetchImpl, discovery.token_endpoint, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: CLIENT_ID,
          code_verifier: verifier
        }, "換取 xAI token");
        const session = buildSession(tokens, { nonce });
        await save(session);
        return { email: session.email };
      })();
      try {
        return await loginInFlight;
      } finally {
        loginInFlight = null;
      }
    },

    async logout() {
      ensureConfigured();
      await fs.rm(storeFile, { force: true });
    },

    async getQuota() {
      let session = await freshSession();
      let response = await requestBilling(session);
      // token 被提早撤銷時，refresh 一次再試。
      if (response.status === 401 && session.refreshToken) {
        await response.text().catch(() => {});
        session = await freshSession({ force: true });
        response = await requestBilling(session);
      }
      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => "");
        throw new Error(`xAI 拒絕讀取帳號用量：${describeHttpError(response.status, text)}；請在齒輪重新登入`);
      }
      const body = await readJson(response, "讀取 xAI 帳號用量");
      return billingToSnapshot(body, session);
    }
  };
}

module.exports = {
  CLIENT_ID,
  SCOPES,
  BILLING_URL,
  createGrokOAuthService,
  createPkce,
  buildAuthorizeUrl,
  buildSession,
  billingToSnapshot,
  captureAuthorizationCode,
  describeHttpError
};
