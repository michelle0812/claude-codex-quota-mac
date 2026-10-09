const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  getQuota,
  loginCommand,
  normalizeSnapshot,
  prettyPlan,
  whamWindow,
  decodeJwtExpiryMs,
  TOKEN_URL
} = require("../src/main/quota-service");

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verifyPrettyPlan() {
  assert.equal(prettyPlan("plus"), "Plus");
  assert.equal(prettyPlan("pro_plan"), "Pro Plan");
  assert.equal(prettyPlan("team-enterprise"), "Team Enterprise");
  assert.equal(prettyPlan(""), null);
  assert.equal(prettyPlan(null), null);
}

function verifyWhamWindow() {
  const weekly = whamWindow(
    { used_percent: 80, limit_window_seconds: 604800, reset_after_seconds: 83043, reset_at: 1788752551 },
    7 * 24 * 60
  );
  assert.deepEqual(weekly, { usedPercent: 80, resetsAt: 1788752551, windowDurationMins: 10080 });

  // 缺 limit_window_seconds 時退回 fallback
  const fallback = whamWindow({ used_percent: 0, reset_at: 1788687509 }, 300);
  assert.equal(fallback.windowDurationMins, 300);

  assert.equal(whamWindow(null, 300), null);
  assert.equal(whamWindow({ limit_window_seconds: 300 }, 300), null); // 沒有 used_percent
}

function verifyNormalizeFromWham() {
  const snapshot = {
    limitId: "codex",
    limitName: "Codex",
    planType: prettyPlan("plus"),
    rateLimitReachedType: null,
    credits: null,
    primary: whamWindow({ used_percent: 0, limit_window_seconds: 18000, reset_at: 1788687509 }, 300),
    secondary: whamWindow({ used_percent: 80, limit_window_seconds: 604800, reset_at: 1788752551 }, 10080)
  };
  const normalized = normalizeSnapshot(snapshot);

  assert.equal(normalized.planType, "Plus");
  assert.equal(normalized.primary.usedPercent, 0);
  assert.equal(normalized.primary.remainingPercent, 100);
  assert.equal(normalized.secondary.usedPercent, 80);
  assert.equal(normalized.secondary.remainingPercent, 20);
  assert.equal(normalized.primary.resetsAt, new Date(1788687509 * 1000).toISOString());
  assert.equal(normalized.primary.windowDurationMins, 300);
  assert.ok(normalized.paceAdvice, "normalizeSnapshot 應附上 paceAdvice");
}

function verifyDecodeJwtExpiry() {
  const exp = 1788656035;
  const jwt = `${base64url({ alg: "none" })}.${base64url({ exp })}.sig`;
  assert.equal(decodeJwtExpiryMs(jwt), exp * 1000);
  assert.equal(decodeJwtExpiryMs("not-a-jwt"), null);
  assert.equal(decodeJwtExpiryMs(undefined), null);
}

// 多帳號：傳入 authFilePath 時要讀那一份，不能碰 ~/.codex/auth.json。
async function verifyPerProfileAuthFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-profile-"));
  const authFilePath = path.join(dir, "auth.json");
  const farFuture = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(
    authFilePath,
    JSON.stringify({
      tokens: {
        id_token: `${base64url({ alg: "none" })}.${base64url({ exp: farFuture })}.sig`,
        access_token: "profile-2-access",
        refresh_token: "profile-2-refresh",
        account_id: "acct-2"
      }
    })
  );

  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, headers: options.headers });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plan_type: "plus",
          email: "two@example.com",
          rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: farFuture } }
        })
    };
  };
  try {
    const quota = await getQuota({ authFilePath });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.Authorization, "Bearer profile-2-access");
    assert.equal(seen[0].headers["ChatGPT-Account-Id"], "acct-2");
    assert.equal(quota.account.email, "two@example.com");
    assert.equal(quota.primary.usedPercent, 12);

    // 非預設帳號缺檔時，錯誤訊息要教使用者帶 CODEX_HOME 登入。
    await assert.rejects(() => getQuota({ authFilePath: path.join(dir, "missing.json") }), (error) => {
      assert.match(error.message, /authentication required/);
      assert.match(error.message, /CODEX_HOME=.* codex login/);
      return true;
    });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(loginCommand(path.join(os.homedir(), ".codex", "auth.json")), "codex login");
  assert.equal(loginCommand(path.join(os.homedir(), ".codex-2", "auth.json")), "CODEX_HOME=~/.codex-2 codex login");
}

// 換不換 token：allowRefresh 沒給（或 false）一律唯讀，過期也不碰 auth.json；
// allowRefresh=true 才在 access_token 快過期時 refresh 並寫回。判斷看 access_token 的 exp，
// 不看只有 1 小時的 id_token。
async function verifyRefreshPolicy() {
  const now = Math.floor(Date.now() / 1000);
  const jwt = (exp) => `${base64url({ alg: "none" })}.${base64url({ exp })}.sig`;
  const usageBody = JSON.stringify({
    plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: now + 3600 } }
  });

  async function run({ accessExp, idExp, allowRefresh }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-refresh-"));
    const authFilePath = path.join(dir, "auth.json");
    const original = JSON.stringify({
      tokens: { id_token: jwt(idExp), access_token: jwt(accessExp), refresh_token: "old-refresh", account_id: "acct" }
    });
    fs.writeFileSync(authFilePath, original);
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      const body = url === TOKEN_URL
        ? JSON.stringify({ access_token: jwt(now + 864000), id_token: jwt(now + 3600), refresh_token: "new-refresh" })
        : usageBody;
      return { ok: true, status: 200, text: async () => body };
    };
    try {
      const options = { authFilePath };
      if (allowRefresh !== undefined) options.allowRefresh = allowRefresh;
      await getQuota(options);
      return { calls, original, after: fs.readFileSync(authFilePath, "utf8") };
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 共用 CLI 的家（預設）：access_token 已過期也不 refresh、不寫檔，直接拿現有 token 打 usage。
  for (const allowRefresh of [undefined, false]) {
    const r = await run({ accessExp: now - 60, idExp: now - 60, allowRefresh });
    assert.equal(r.calls.filter((c) => c.url === TOKEN_URL).length, 0, "唯讀模式不能打 token endpoint");
    assert.equal(r.after, r.original, "唯讀模式不能改 auth.json");
  }

  // 面板自己的窩：access_token 過期 → refresh、寫回新 token，usage 用新的 access_token。
  const refreshed = await run({ accessExp: now - 60, idExp: now - 60, allowRefresh: true });
  const tokenCall = refreshed.calls.find((c) => c.url === TOKEN_URL);
  assert.ok(tokenCall, "自己的窩過期時要 refresh");
  assert.equal(JSON.parse(tokenCall.options.body).refresh_token, "old-refresh");
  const saved = JSON.parse(refreshed.after);
  assert.equal(saved.tokens.refresh_token, "new-refresh");
  assert.ok(saved.last_refresh);
  const usageCall = refreshed.calls.find((c) => c.url !== TOKEN_URL);
  assert.equal(usageCall.options.headers.Authorization, `Bearer ${saved.tokens.access_token}`);

  // access_token 還有效、只有 id_token 過期：不 refresh（以前看 id_token 會每小時換一次）。
  const fresh = await run({ accessExp: now + 86400, idExp: now - 60, allowRefresh: true });
  assert.equal(fresh.calls.filter((c) => c.url === TOKEN_URL).length, 0);
  assert.equal(fresh.after, fresh.original);
}

(async () => {
  verifyPrettyPlan();
  verifyWhamWindow();
  verifyNormalizeFromWham();
  verifyDecodeJwtExpiry();
  await verifyPerProfileAuthFile();
  await verifyRefreshPolicy();

  console.log(
    "Verified Codex usage: plan prettify, wham window mapping, snapshot normalization, JWT expiry decode, per-profile auth file, and refresh policy."
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
