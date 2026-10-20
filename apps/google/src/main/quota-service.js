"use strict";

// Account quotas come only from the authenticated AGY API, never context usage
// or statusLine files. Credentials belong to AGY and are always read-only.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { buildPaceAdvice } = require("../shared-gen/pace-advice");
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";
const REQUEST_TIMEOUT_MS = 15_000;
const FIVE_HOUR_WINDOW_MINS = 300;
const SEVEN_DAY_WINDOW_MINS = 10080;
const QUOTA_GROUPS = Object.freeze([
  Object.freeze({ id: "gemini", label: "Gemini", prefix: "gemini" }),
  Object.freeze({ id: "third-party", label: "Claude / GPT", prefix: "3p" })
]);
const quotaError = (message, code) => Object.assign(new Error(message), { code });
function quotaGroup(id) {
  const group = QUOTA_GROUPS.find((entry) => entry.id === id);
  if (!group) throw quotaError("不支援的 Google 額度群組。", "INVALID_GROUP");
  return group;
}
function decodeClaims(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) || {}; }
  catch { return {}; }
}
async function readCredential(source, { readFile = fs.readFile, runCommand = run } = {}) {
  let raw;
  if (source && typeof source === "object") {
    if (source.type !== "keychain" || source.account !== "antigravity") {
      throw quotaError("不支援的 AGY 鑰匙圈來源。", "INVALID_CREDENTIAL");
    }
    try {
      const result = await runCommand("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
        timeout: 30000, maxBuffer: 1024 * 1024
      });
      raw = result.stdout.trim();
    } catch { throw quotaError("無法讀取本機 AGY 登入；請先登入 AGY，並允許 macOS 鑰匙圈存取。", "CREDENTIAL_MISSING"); }
  } else {
    try { raw = await readFile(source, "utf8"); }
    catch { throw quotaError("無法讀取此面板連接的 AGY 憑證，請按齒輪重新連接。", "CREDENTIAL_MISSING"); }
  }
  let stored;
  try {
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("too large");
    if (raw.startsWith("go-keyring-base64:")) raw = Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8");
    stored = JSON.parse(raw);
  } catch { throw quotaError("AGY 憑證不是有效的 JSON。", "INVALID_CREDENTIAL"); }
  const token = stored?.token || stored;
  if (!token || typeof token.access_token !== "string" || !token.access_token.trim()) {
    throw quotaError("AGY 憑證缺少 access_token。", "INVALID_CREDENTIAL");
  }
  const claims = decodeClaims(stored.id_token || token.id_token || "");
  // Local identity pin only, not an authentication decision: Google validates
  // the access token. Without an ID token, pin the refresh-token fingerprint.
  const subject = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  const email = typeof claims.email === "string" ? claims.email : null;
  const identity = subject ? `sub:${subject}` : email ? `email:${email}`
    : typeof token.refresh_token === "string" && token.refresh_token ? `refresh:${token.refresh_token}` : null;
  if (!identity) throw quotaError("無法辨識 AGY 帳號，請重新登入 AGY 後再連接。", "INVALID_CREDENTIAL");
  const expiresAt = token.expiry === undefined ? null : Date.parse(token.expiry);
  if (expiresAt !== null && !Number.isFinite(expiresAt)) throw quotaError("AGY 憑證的到期時間無效。", "INVALID_CREDENTIAL");
  return { accessToken: token.access_token, accountId: crypto.createHash("sha256").update(identity).digest("hex"), email, expiresAt };
}
function normalizeResetTime(value) {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Google 用量視窗的 resets_at 不是有效時間戳。");
  return new Date(ms).toISOString();
}
function normalizeWindow(window) {
  if (!window) return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    throw new Error("Google 用量視窗缺少數值型的 used_percentage。");
  }
  if (window.usedPercent < 0 || window.usedPercent > 100) throw new Error("Google 用量比例超出範圍。");
  const usedPercent = Math.round(window.usedPercent * 10) / 10;
  return { usedPercent, remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
    windowDurationMins: window.windowDurationMins ?? null, resetsAt: normalizeResetTime(window.resetsAt) };
}
function normalizeSnapshot(snapshot, now = Date.now()) {
  const primary = normalizeWindow(snapshot.primary), secondary = normalizeWindow(snapshot.secondary);
  const active = primary || secondary;
  if (!active) throw new Error("Google 用量快照沒有可用的額度視窗。");
  const normalized = { limitId: snapshot.limitId ?? "google", limitName: snapshot.limitName ?? "Google",
    planType: snapshot.planType ?? "Google AI", reachedType: snapshot.rateLimitReachedType ?? null,
    credits: null, primary, secondary, remainingPercent: active.remainingPercent,
    usedPercent: active.usedPercent, resetsAt: active.resetsAt, fetchedAt: new Date(now).toISOString() };
  return { ...normalized, paceAdvice: buildPaceAdvice(normalized, normalized.fetchedAt) };
}
function parseQuotaSummary(data, { group = "gemini", planName = "Google AI", now = Date.now() } = {}) {
  const selected = quotaGroup(group);
  const buckets = [...(Array.isArray(data?.buckets) ? data.buckets : []),
    ...(Array.isArray(data?.groups) ? data.groups.flatMap((entry) => Array.isArray(entry?.buckets) ? entry.buckets : []) : [])];
  function windowFor(suffix, duration, windowName) {
    const matches = buckets.filter((bucket) => bucket?.bucketId === `${selected.prefix}-${suffix}`);
    if (matches.length !== 1 || matches[0].disabled === true) {
      throw quotaError(`Google 回應缺少 ${selected.label} 的唯一 ${windowName} 額度。`, "INVALID_QUOTA");
    }
    const bucket = matches[0];
    if (bucket.window !== undefined && bucket.window !== suffix) throw quotaError("Google 額度視窗與群組不符。", "INVALID_QUOTA");
    if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)
      || bucket.remainingFraction < 0 || bucket.remainingFraction > 1) throw quotaError("Google 額度比例無效。", "INVALID_QUOTA");
    const resetsAt = normalizeResetTime(bucket.resetTime);
    if (!resetsAt || Date.parse(resetsAt) <= now) throw quotaError("Google 額度重置時間缺漏或已過期，請稍後重新整理。", "INVALID_QUOTA");
    return { usedPercent: (1 - bucket.remainingFraction) * 100, resetsAt, windowDurationMins: duration };
  }
  const primary = windowFor("5h", FIVE_HOUR_WINDOW_MINS, "5 小時"), secondary = windowFor("weekly", SEVEN_DAY_WINDOW_MINS, "每週");
  return normalizeSnapshot({ limitId: `google:${group}`, limitName: `Google · ${selected.label}`, planType: `${planName} · ${selected.label}`,
    rateLimitReachedType: primary.usedPercent >= 100 || secondary.usedPercent >= 100 ? "rate_limit_reached" : null, primary, secondary }, now);
}
async function requestJson(action, body, credential, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${BASE_URL}:${action}`, { method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${credential.accessToken}`, "Content-Type": "application/json",
        "User-Agent": `antigravity/1.0 (os_type=darwin; arch=${process.arch === "arm64" ? "arm64" : "amd64"})` }, body: JSON.stringify(body) });
    if (response.status === 401) throw quotaError("AGY 登入已過期，請先在 AGY 重新登入，再重新整理。", "AUTH_EXPIRED");
    if (response.status === 403) throw quotaError("此 AGY 帳號無權讀取 Google 額度。", "AUTH_DENIED");
    if (!response.ok) throw quotaError(`Google 額度查詢失敗（HTTP ${response.status}）。`, "HTTP_ERROR");
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw quotaError("Google 回應過大。", "INVALID_RESPONSE");
    try { return JSON.parse(text); }
    catch { throw quotaError("Google 額度回應不是有效的 JSON。", "INVALID_RESPONSE"); }
  } catch (error) {
    if (controller.signal.aborted) throw quotaError("Google 額度查詢逾時，請稍後重試。", "TIMEOUT");
    if (["AUTH_EXPIRED", "AUTH_DENIED", "HTTP_ERROR", "INVALID_RESPONSE"].includes(error.code)) throw error;
    // Transport messages and response bodies can contain credentials.
    throw quotaError("無法連線到 Google 額度服務，請稍後重試。", "NETWORK_ERROR");
  } finally { clearTimeout(timer); }
}
function createQuotaService({ readCredential: readToken = readCredential, fetchImpl = globalThis.fetch,
  now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let projectCache = null;
  return { async getQuota({ tokenFile, keychainAccount, accountId, group = "gemini" }) {
    quotaGroup(group);
    if ((!tokenFile && !keychainAccount) || !accountId) throw quotaError("尚未連接此面板的 AGY 帳號，請按齒輪連接。", "NOT_CONNECTED");
    const credential = await readToken(keychainAccount ? { type: "keychain", account: keychainAccount } : tokenFile);
    if (credential.accountId !== accountId) {
      projectCache = null;
      throw quotaError("AGY 憑證已換成另一個帳號；此面板已停止讀取，請按齒輪重新連接。", "ACCOUNT_CHANGED");
    }
    if (credential.expiresAt !== null && credential.expiresAt <= now() + 5000) {
      throw quotaError("AGY 登入已過期，請開啟 AGY 更新登入，再重新整理。", "AUTH_EXPIRED");
    }
    const tokenKey = crypto.createHash("sha256").update(credential.accessToken).digest("hex");
    const request = (action, body) => requestJson(action, body, credential, { fetchImpl, timeoutMs });
    if (!projectCache || projectCache.tokenKey !== tokenKey || projectCache.accountId !== accountId) {
      projectCache = null;
      const info = await request("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY",
        platform: process.arch === "arm64" ? "DARWIN_ARM64" : "DARWIN_AMD64", pluginType: "GEMINI" } });
      const project = typeof info?.cloudaicompanionProject === "string" ? info.cloudaicompanionProject : info?.cloudaicompanionProject?.id;
      if (typeof project !== "string" || !project.trim()) throw quotaError("Google 未回傳此帳號的有效 project。", "INVALID_RESPONSE");
      const plan = info?.paidTier?.name || info?.currentTier?.name;
      projectCache = { tokenKey, accountId, project, planName: typeof plan === "string" ? plan : "Google AI" };
    }
    let summary;
    try { summary = await request("retrieveUserQuotaSummary", { project: projectCache.project }); }
    catch (error) { projectCache = null; throw error; }
    const quota = parseQuotaSummary(summary, { group, planName: projectCache.planName, now: now() });
    return { ...quota, source: "google-api", account: { id: accountId, email: credential.email, source: "agy" } };
  } };
}
module.exports = { DEFAULT_TOKEN_FILE, REQUEST_TIMEOUT_MS, FIVE_HOUR_WINDOW_MINS, SEVEN_DAY_WINDOW_MINS,
  QUOTA_GROUPS, quotaGroup, readCredential, normalizeWindow, normalizeSnapshot, parseQuotaSummary, requestJson, createQuotaService };
