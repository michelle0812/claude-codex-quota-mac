"use strict";

// 全部用假的 fetch／瀏覽器，不連 xAI、不碰 ~/.grok。
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  CLIENT_ID,
  BILLING_URL,
  createGrokOAuthService,
  buildAuthorizeUrl,
  billingToSnapshot,
  describeHttpError
} = require("../src/main/grok-oauth-service");
const { windowLabels } = require("../src/shared-gen/window-labels");

const ISSUER = "https://auth.x.ai";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth2/authorize`,
  token_endpoint: `${ISSUER}/oauth2/token`
};

function jwt(claims) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

function jsonResponse(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// 依 2026-10-21 實測回應的欄位形狀（數值為假）。
function billingBody(overrides = {}) {
  return {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-10-16T07:20:31.679928+00:00",
        end: "2026-10-23T07:20:31.679928+00:00"
      },
      creditUsagePercent: 11,
      onDemandCap: { val: 0 },
      onDemandUsed: {},
      productUsage: [{}],
      isUnifiedBillingUser: true,
      prepaidBalance: {},
      topUpMethod: "TOP_UP_METHOD_UNSPECIFIED",
      billingPeriodStart: "2026-10-16T07:20:31.679928+00:00",
      billingPeriodEnd: "2026-10-23T07:20:31.679928+00:00",
      ...overrides
    }
  };
}

const fakeCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(`enc:${text}`).toString("base64"),
  decrypt: (data) => Buffer.from(data, "base64").toString("utf8").replace(/^enc:/, "")
};

// 模擬瀏覽器：讀授權網址、驗參數，再打 loopback callback。
function fakeBrowser({ mutate = (params) => params, seen = {} } = {}) {
  return async (url) => {
    const parsed = new URL(url);
    seen.url = parsed;
    const params = mutate({
      code: "auth-code-1",
      state: parsed.searchParams.get("state")
    });
    const callback = new URL(parsed.searchParams.get("redirect_uri"));
    for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
    setTimeout(() => fetch(callback).catch(() => {}), 10);
  };
}

function fakeFetch(handlers, calls = []) {
  return async (url, options = {}) => {
    const key = String(url);
    calls.push({ url: key, options });
    if (key === `${ISSUER}/.well-known/openid-configuration`) return jsonResponse(200, DISCOVERY);
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler(options, calls);
  };
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-oauth-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testAuthorizeUrl() {
  const url = new URL(buildAuthorizeUrl({
    authorizationEndpoint: DISCOVERY.authorization_endpoint,
    redirectUri: "http://127.0.0.1:5555/callback",
    challenge: "chal",
    state: "st",
    nonce: "no"
  }));
  assert.equal(url.origin + url.pathname, DISCOVERY.authorization_endpoint);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5555/callback");
  assert.ok(url.searchParams.get("scope").split(" ").includes("grok-cli:access"));
  assert.ok(url.searchParams.get("scope").split(" ").includes("offline_access"));
  assert.equal(url.searchParams.get("referrer"), "grok-build");
}

async function testLoginSavesEncryptedPerProfileSession() {
  await withTempDir(async (dir) => {
    const seen = {};
    const calls = [];
    let tokenParams;
    const service = createGrokOAuthService({
      cipher: fakeCipher,
      openExternal: fakeBrowser({ seen }),
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: (options) => {
          tokenParams = new URLSearchParams(options.body);
          const nonce = seen.url.searchParams.get("nonce");
          return jsonResponse(200, {
            access_token: jwt({ principal_type: "User", principal_id: "user-1", team_id: "team-9" }),
            refresh_token: "refresh-secret-1",
            id_token: jwt({ iss: ISSUER, aud: CLIENT_ID, nonce, sub: "user-1", email: "a@example.com", exp: Date.now() / 1000 + 3600 }),
            expires_in: 3600
          });
        }
      }, calls)
    });
    await service.configure(dir);
    assert.equal(await service.hasSession(), false);
    const result = await service.login();
    assert.equal(result.email, "a@example.com");
    assert.equal(tokenParams.get("grant_type"), "authorization_code");
    assert.equal(tokenParams.get("code"), "auth-code-1");
    assert.equal(tokenParams.get("client_id"), CLIENT_ID);
    assert.match(tokenParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(tokenParams.get("code_verifier").length >= 43);
    assert.equal(await service.hasSession(), true);

    const raw = await fs.readFile(path.join(dir, "grok-oauth.json"), "utf8");
    assert.ok(!raw.includes("refresh-secret-1"), "token 不應明文落地");
    const stat = await fs.stat(path.join(dir, "grok-oauth.json"));
    assert.equal(stat.mode & 0o777, 0o600);

    await service.logout();
    assert.equal(await service.hasSession(), false);
  });
}

async function testLoginRejectsBadNonceAndOAuthError() {
  await withTempDir(async (dir) => {
    const service = createGrokOAuthService({
      cipher: fakeCipher,
      openExternal: fakeBrowser(),
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: () => jsonResponse(200, {
          access_token: jwt({}),
          id_token: jwt({ iss: ISSUER, aud: CLIENT_ID, nonce: "wrong", sub: "u" })
        })
      })
    });
    await service.configure(dir);
    await assert.rejects(service.login(), /nonce/);
    assert.equal(await service.hasSession(), false);
  });

  await withTempDir(async (dir) => {
    const service = createGrokOAuthService({
      cipher: fakeCipher,
      openExternal: fakeBrowser({ mutate: ({ state }) => ({ state, error: "access_denied", error_description: "User denied" }) }),
      fetchImpl: fakeFetch({})
    });
    await service.configure(dir);
    await assert.rejects(service.login(), /User denied/);
  });
}

// 舊分頁（state 不符）打進來不能被當成這次的授權，也不能中止這次登入。
async function testStaleStateCallbackIgnored() {
  await withTempDir(async (dir) => {
    let exchangedCode;
    let staleStatus;
    let nonce;
    const service = createGrokOAuthService({
      cipher: fakeCipher,
      openExternal: async (url) => {
        const parsed = new URL(url);
        nonce = parsed.searchParams.get("nonce");
        const callback = parsed.searchParams.get("redirect_uri");
        const stale = new URL(callback);
        stale.searchParams.set("code", "stale-code");
        stale.searchParams.set("state", "old-state");
        staleStatus = (await fetch(stale)).status;
        const good = new URL(callback);
        good.searchParams.set("code", "good-code");
        good.searchParams.set("state", parsed.searchParams.get("state"));
        setTimeout(() => fetch(good).catch(() => {}), 10);
      },
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: (options) => {
          exchangedCode = new URLSearchParams(options.body).get("code");
          return jsonResponse(200, {
            access_token: jwt({}),
            id_token: jwt({ iss: ISSUER, aud: CLIENT_ID, nonce, sub: "u" })
          });
        }
      })
    });
    await service.configure(dir);
    await service.login();
    assert.equal(staleStatus, 400);
    assert.equal(exchangedCode, "good-code");
  });
}

async function testTeamPrincipalUsesPrincipalId() {
  await withTempDir(async (dir) => {
    const calls = [];
    const service = createGrokOAuthService({
      cipher: fakeCipher,
      openExternal: fakeBrowser(),
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: () => jsonResponse(200, {
          access_token: jwt({ principal_type: "Team", principal_id: "team-42" }),
          refresh_token: "rt",
          expires_in: 3600
        }),
        [BILLING_URL]: () => jsonResponse(200, billingBody())
      }, calls)
    });
    await service.configure(dir);
    await service.login();
    await service.getQuota();
    const billing = calls.find((call) => call.url === BILLING_URL);
    assert.equal(billing.options.headers["x-userid"], "team-42");
  });
}

async function seedSession(dir, session) {
  await fs.writeFile(path.join(dir, "grok-oauth.json"), JSON.stringify({ version: 1, session }), { mode: 0o600 });
}

async function testQuotaHeadersAndWeeklyWindow() {
  await withTempDir(async (dir) => {
    const calls = [];
    const service = createGrokOAuthService({
      cipher: { ...fakeCipher, available: () => false },
      fetchImpl: fakeFetch({ [BILLING_URL]: () => jsonResponse(200, billingBody()) }, calls),
      appVersion: "9.9.9"
    });
    await service.configure(dir);
    await seedSession(dir, {
      accessToken: "access-ok",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() + 3600e3).toISOString(),
      userId: "user-1",
      email: "a@example.com"
    });
    const quota = await service.getQuota();
    const headers = calls[0].options.headers;
    assert.equal(headers.Authorization, "Bearer access-ok");
    assert.equal(headers["X-XAI-Token-Auth"], "xai-grok-cli");
    assert.equal(headers["x-userid"], "user-1");
    assert.equal(headers["x-grok-client-mode"], "headless");
    assert.ok(headers["x-grok-client-version"]);
    assert.match(headers["User-Agent"], /^GrokQuota\/9\.9\.9 grok-shell\//);

    assert.equal(quota.primary, null);
    assert.equal(quota.secondary.usedPercent, 11);
    assert.equal(quota.secondary.remainingPercent, 89);
    assert.equal(quota.secondary.windowDurationMins, 7 * 24 * 60);
    assert.equal(quota.secondary.resetsAt, "2026-10-23T07:20:31.679Z");
    assert.equal(quota.remainingPercent, 89);
    assert.equal(windowLabels(quota, "zh").secondary, "本週");
    assert.match(quota.sessionSummary, /xAI 帳號用量/);
  });
}

async function testBillingShapes() {
  const session = { userId: "u", email: null, name: null };
  const monthly = billingToSnapshot(billingBody({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" },
    creditUsagePercent: 40
  }), session);
  assert.equal(monthly.secondary.windowDurationMins, 30 * 24 * 60);
  assert.equal(windowLabels(monthly, "zh").secondary, "本月");
  assert.equal(monthly.secondary.resetsAt, "2026-10-31T00:00:00.000Z");

  // proto3 省略 0 值：有週期沒百分比 → 0%。
  const zero = billingToSnapshot(billingBody({ creditUsagePercent: undefined }), session);
  assert.equal(zero.secondary.usedPercent, 0);

  // 舊制欄位退回。
  const legacy = billingToSnapshot({ config: {
    monthlyLimit: { val: 1000 }, used: { val: 250 },
    billingPeriodStart: "2026-10-01T00:00:00Z", billingPeriodEnd: "2026-11-01T00:00:00Z"
  } }, session);
  assert.equal(legacy.secondary.usedPercent, 25);
  assert.equal(legacy.secondary.resetsAt, "2026-11-01T00:00:00.000Z");

  assert.throws(() => billingToSnapshot({}, session), /config/);
  assert.throws(() => billingToSnapshot({ config: {} }, session), /creditUsagePercent/);
}

async function testRefreshAndErrors() {
  // 過期 → refresh（帶 principal），存新 token，refresh token 未回傳時沿用舊的。
  await withTempDir(async (dir) => {
    let refreshParams;
    const calls = [];
    const service = createGrokOAuthService({
      cipher: { ...fakeCipher, available: () => false },
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: (options) => {
          refreshParams = new URLSearchParams(options.body);
          return jsonResponse(200, { access_token: "access-new", expires_in: 3600 });
        },
        [BILLING_URL]: (options) => jsonResponse(options.headers.Authorization === "Bearer access-new" ? 200 : 401, billingBody())
      }, calls)
    });
    await service.configure(dir);
    await seedSession(dir, {
      accessToken: "access-old", refreshToken: "rt-old",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      userId: "user-1", principalType: "User", principalId: "user-1"
    });
    const quota = await service.getQuota();
    assert.equal(quota.secondary.usedPercent, 11);
    assert.equal(refreshParams.get("grant_type"), "refresh_token");
    assert.equal(refreshParams.get("refresh_token"), "rt-old");
    assert.equal(refreshParams.get("principal_type"), "User");
    assert.equal(refreshParams.get("principal_id"), "user-1");
    const saved = JSON.parse(await fs.readFile(path.join(dir, "grok-oauth.json"), "utf8")).session;
    assert.equal(saved.accessToken, "access-new");
    assert.equal(saved.refreshToken, "rt-old");
  });

  // 未過期但被撤銷（401）→ refresh 一次再試。
  await withTempDir(async (dir) => {
    let refreshes = 0;
    const service = createGrokOAuthService({
      cipher: { ...fakeCipher, available: () => false },
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: () => { refreshes += 1; return jsonResponse(200, { access_token: "access-new", refresh_token: "rt-2", expires_in: 3600 }); },
        [BILLING_URL]: (options) => jsonResponse(options.headers.Authorization === "Bearer access-new" ? 200 : 401, billingBody())
      })
    });
    await service.configure(dir);
    await seedSession(dir, { accessToken: "revoked", refreshToken: "rt", expiresAt: new Date(Date.now() + 3600e3).toISOString(), userId: "u" });
    await service.getQuota();
    assert.equal(refreshes, 1);
  });

  // refresh token 被撤銷 → 明確要求重新登入；錯誤訊息不帶 token。
  await withTempDir(async (dir) => {
    const service = createGrokOAuthService({
      cipher: { ...fakeCipher, available: () => false },
      fetchImpl: fakeFetch({
        [DISCOVERY.token_endpoint]: () => jsonResponse(400, { error: "invalid_grant", error_description: "revoked rt-secret" })
      })
    });
    await service.configure(dir);
    await seedSession(dir, { accessToken: "a", refreshToken: "rt-secret", expiresAt: new Date(0).toISOString(), userId: "u" });
    await assert.rejects(service.getQuota(), (error) => /重新登入/.test(error.message) && !error.message.includes("rt-secret"));
  });

  // 403 不悄悄退回，回明確原因。
  await withTempDir(async (dir) => {
    const service = createGrokOAuthService({
      cipher: { ...fakeCipher, available: () => false },
      fetchImpl: fakeFetch({ [BILLING_URL]: () => jsonResponse(403, { error: "forbidden" }) })
    });
    await service.configure(dir);
    await seedSession(dir, { accessToken: "a", expiresAt: new Date(Date.now() + 3600e3).toISOString(), userId: "u" });
    await assert.rejects(service.getQuota(), /HTTP 403（forbidden）/);
  });

  // 沒登入。
  await withTempDir(async (dir) => {
    const service = createGrokOAuthService({ cipher: fakeCipher, fetchImpl: fakeFetch({}) });
    await service.configure(dir);
    await assert.rejects(service.getQuota(), (error) => error.code === "GROK_NOT_SIGNED_IN");
  });

  assert.equal(describeHttpError(500, "<html>access_token=abc</html>"), "HTTP 500");
}

async function main() {
  await testAuthorizeUrl();
  await testLoginSavesEncryptedPerProfileSession();
  await testLoginRejectsBadNonceAndOAuthError();
  await testStaleStateCallbackIgnored();
  await testTeamPrincipalUsesPrincipalId();
  await testQuotaHeadersAndWeeklyWindow();
  await testBillingShapes();
  await testRefreshAndErrors();
  console.log("Grok OAuth／billing 驗證通過");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
