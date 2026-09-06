const assert = require("node:assert/strict");
const {
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

verifyPrettyPlan();
verifyWhamWindow();
verifyNormalizeFromWham();
verifyDecodeJwtExpiry();

console.log("Verified Codex usage: plan prettify, wham window mapping, snapshot normalization, and JWT expiry decode.");
