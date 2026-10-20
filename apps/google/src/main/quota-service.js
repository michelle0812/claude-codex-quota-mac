"use strict";

// Read the official AGY /usage JSON: direct web API calls were verified to
// return a different quota scope. AGY owns login, token refresh and API routing.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { buildPaceAdvice } = require("../shared-gen/pace-advice");
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const AGY_EXECUTABLE = path.join(os.homedir(), ".local", "bin", "agy");
const REQUEST_TIMEOUT_MS = 45_000;
const FIVE_HOUR_WINDOW_MINS = 300;
const SEVEN_DAY_WINDOW_MINS = 10080;
const QUOTA_GROUPS = Object.freeze([
  Object.freeze({ id: "gemini", label: "Gemini Models", shortId: "gemini-5h", weeklyId: "gemini-weekly" }),
  Object.freeze({ id: "third-party", label: "Claude and GPT Models", shortId: "3p-5h", weeklyId: "3p-weekly" }),
  Object.freeze({ id: "argon", label: "Gemini 4 Argon", shortId: null, weeklyId: "gemini-argon-wtu-weekly" })
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
  const usedPercent = Math.round(window.usedPercent * 100) / 100;
  return { usedPercent, remainingPercent: Math.round((100 - usedPercent) * 100) / 100,
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
function parseUsageDocument(document, { now = Date.now() } = {}) {
  if (document?.status !== "SUCCESS" || document?.num_turns !== 0 || document?.command?.name !== "usage"
    || !Array.isArray(document.command.data?.groups)) {
    throw quotaError("AGY 未回傳有效的 /usage 資料，請先在 AGY 確認登入。", "INVALID_USAGE");
  }
  const buckets = document.command.data.groups.flatMap(group => Array.isArray(group?.buckets) ? group.buckets : []);
  function windowFor(id, duration) {
    if (!id) return null;
    const matches = buckets.filter(bucket => bucket?.id === id);
    if (!matches.length) return null;
    if (matches.length !== 1) throw quotaError("AGY 回傳重複的額度視窗。", "INVALID_USAGE");
    const bucket = matches[0], fraction = bucket.remaining_fraction;
    if (bucket.disabled === true || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw quotaError("AGY 額度比例無效。", "INVALID_USAGE");
    }
    const expectedWindow = duration === FIVE_HOUR_WINDOW_MINS ? "5h" : "weekly";
    if (bucket.window !== expectedWindow) throw quotaError("AGY 額度視窗不符。", "INVALID_USAGE");
    const resetsAt = normalizeResetTime(bucket.reset_time);
    if (!resetsAt || Date.parse(resetsAt) <= now) throw quotaError("AGY 額度重置時間缺漏或已過期。", "INVALID_USAGE");
    const remainingPercent = Math.round(fraction * 10000) / 100;
    return { remainingPercent, usedPercent: Math.round((100 - remainingPercent) * 100) / 100,
      windowDurationMins: duration, resetsAt };
  }
  const groups = QUOTA_GROUPS.map(group => ({ id: group.id, name: group.label,
    primary: windowFor(group.shortId, FIVE_HOUR_WINDOW_MINS), secondary: windowFor(group.weeklyId, SEVEN_DAY_WINDOW_MINS) }));
  for (const group of groups) {
    group.paceAdvice = buildPaceAdvice({ ...group, limitId: `google:${group.id}` }, new Date(now).toISOString());
  }
  const active = groups.find(group => group.primary || group.secondary);
  if (!active) throw quotaError("AGY /usage 沒有已知的額度資料。", "INVALID_USAGE");
  const overview = normalizeSnapshot({ limitId: "google:all", limitName: "Google · AGY", planType: "AGY",
    primary: active.primary, secondary: active.secondary }, now);
  return { ...overview, groups, source: "agy-cli" };
}
async function readUsageJson({ runCommand = run, executable = AGY_EXECUTABLE, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let result;
  try {
    const operation = runCommand(executable, ["-p", "/usage", "--output-format", "json"], {
      cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true
    });
    operation.child?.stdin?.end();
    result = await operation;
  } catch (error) {
    if (error.code === "ENOENT") throw quotaError("找不到 AGY，請先安裝 AGY CLI。", "CLI_MISSING");
    if (error.killed || error.code === "ETIMEDOUT") throw quotaError("AGY /usage 查詢逾時，請稍後重試。", "TIMEOUT");
    throw quotaError("AGY /usage 讀取失敗，請先在 AGY 確認登入後重試。", "CLI_ERROR");
  }
  if (typeof result?.stdout !== "string" || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) {
    throw quotaError("AGY /usage 回應無效。", "INVALID_USAGE");
  }
  try { return JSON.parse(result.stdout); }
  catch { throw quotaError("AGY /usage 回應不是有效 JSON。", "INVALID_USAGE"); }
}
function createQuotaService({ readCredential: readToken = readCredential, readUsage = readUsageJson, now = Date.now } = {}) {
  return { async getQuota({ tokenFile, keychainAccount, accountId }) {
    if ((!tokenFile && !keychainAccount) || !accountId) throw quotaError("尚未連接此面板的 AGY 帳號，請按齒輪連接。", "NOT_CONNECTED");
    const source = keychainAccount ? { type: "keychain", account: keychainAccount } : tokenFile;
    async function verifyIdentity() {
      const credential = await readToken(source);
      if (credential.accountId !== accountId) throw quotaError("AGY 已換成另一個帳號，請重新連接此面板。", "ACCOUNT_CHANGED");
      // Old file-based bindings may remain, but the CLI reads the local AGY
      // account. Never present another account's CLI data in such a panel.
      if (!keychainAccount && (await readToken({ type: "keychain", account: "antigravity" })).accountId !== accountId) {
        throw quotaError("此面板與本機 AGY 帳號不同，請連接本機 AGY。", "ACCOUNT_CHANGED");
      }
      return credential;
    }
    await verifyIdentity();
    const document = await readUsage();
    const credential = await verifyIdentity();
    const quota = parseUsageDocument(document, { now: now() });
    return { ...quota, account: { id: accountId, email: credential.email, source: "agy" } };
  } };
}
module.exports = { DEFAULT_TOKEN_FILE, AGY_EXECUTABLE, REQUEST_TIMEOUT_MS, FIVE_HOUR_WINDOW_MINS, SEVEN_DAY_WINDOW_MINS,
  QUOTA_GROUPS, quotaGroup, readCredential, normalizeWindow, normalizeSnapshot, parseUsageDocument, readUsageJson, createQuotaService };
