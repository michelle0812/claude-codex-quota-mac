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
  decodeJwtExpiryMs
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

(async () => {
  verifyPrettyPlan();
  verifyWhamWindow();
  verifyNormalizeFromWham();
  verifyDecodeJwtExpiry();
  await verifyPerProfileAuthFile();

  console.log(
    "Verified Codex usage: plan prettify, wham window mapping, snapshot normalization, JWT expiry decode, and per-profile auth file."
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
