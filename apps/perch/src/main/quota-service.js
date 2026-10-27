"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { buildPaceAdvice } = require("../shared-gen/pace-advice");
const run = promisify(execFile);
const OFFICIAL_ORIGIN = "https://app.perchai.app";

// Follow perchai-cli 2.4.120's exact credential location. Never refresh, copy,
// delete or write the CLI session, and never send it to a credential-supplied host.
async function readCredential({ authDir = process.env.PERCH_CLI_AUTH_DIR, platform = process.platform, execute = run, readFile = fs.readFile } = {}) {
  let raw;
  try {
    raw = authDir || platform !== "darwin"
      ? await readFile(path.join(authDir || path.join(os.homedir(), ".perch"), "cli-auth-session.json"), "utf8")
      : (await execute("/usr/bin/security", ["find-generic-password", "-s", "app.perchai.cli-auth", "-a", "default", "-w"], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  } catch {
    throw new Error("Perch authentication required：無法讀取 CLI 登入，請先在終端機執行 perch login，再重新整理。");
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Perch CLI 登入資料格式無效，請重新登入。"); }
  if (value.version !== 1 || typeof value.accessToken !== "string" || !value.accessToken.trim()
    || typeof value.userId !== "string" || !value.userId.trim()) throw new Error("Perch CLI 登入資料不完整，請重新登入。");
  let url;
  try { url = new URL(value.appUrl); } catch { throw new Error("Perch CLI 伺服器網址無效。"); }
  if (url.origin !== OFFICIAL_ORIGIN || url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("Perch 面板只允許連接官方 app.perchai.app。");
  }
  if (value.expiresAt != null && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)
    || value.expiresAt * 1000 <= Date.now())) throw new Error("Perch 登入已過期，請在 CLI 更新登入後重新整理；面板不會輪替 CLI 憑證。");
  return { accessToken: value.accessToken, userId: value.userId, email: typeof value.email === "string" ? value.email : null,
    accountId: crypto.createHash("sha256").update(value.userId).digest("hex") };
}

function nonnegative(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Perch 用量欄位無效：${field}`);
  return value;
}
function makeWindow(used, cap, minutes, nextFreedAt = null, labels = null, abbreviation = null) {
  nonnegative(used, "used"); nonnegative(cap, "cap");
  if (!cap) return null;
  if (nextFreedAt != null && (typeof nextFreedAt !== "string" || !Number.isFinite(Date.parse(nextFreedAt)))) throw new Error("Perch 額度釋出時間無效。");
  const usedPercent = Math.min(100, Math.round(used / cap * 10000) / 100);
  // nextFreedAt is the first rolling release, NOT a full-window reset. Leave
  // resetsAt unknown so the shared pace engine cannot invent a reset schedule.
  return { usedPercent, remainingPercent: Math.round((100 - usedPercent) * 100) / 100,
    windowDurationMins: minutes, resetsAt: null, nextFreedAt, labels, abbreviation,
    used, limit: cap };
}
function normalizeAccount(payload, credential, now = Date.now()) {
  const { session, usageMeter: meter } = payload || {};
  if (payload?.ok !== true || !session || !meter) throw new Error("Perch 官方未提供帳號用量，請稍後重試。");
  if (session.userId && session.userId !== credential.userId) throw new Error("Perch 用量帳號與 CLI 登入不符。");
  const groups = [];
  const add = (id, name, primary, secondary) => {
    if (primary || secondary) groups.push({ id, name, primary, secondary, paceAdvice: buildPaceAdvice({ primary, secondary }, now) });
  };
  for (const [key, name] of [["roostRolling", "Roost"], ["manualRolling", "Manual"]]) {
    const rolling = meter[key];
    if (!rolling?.enabled) continue;
    const primary = rolling.window5hCapUsd == null ? null : makeWindow(rolling.window5hUsd, rolling.window5hCapUsd, 300, rolling.window5hNextFreedAt);
    const secondary = makeWindow(rolling.window7dUsd, rolling.window7dCapUsd, 10080, rolling.window7dNextFreedAt);
    add(key, name, primary, secondary);
  }
  const entitlements = Array.isArray(session.entitlements) ? session.entitlements : [];
  const limitFor = key => entitlements.find(e => e.key === key)?.value_json?.limit;
  const plan = session.planCode;
  const manualCap = limitFor("usage.manual_monthly_pt") ?? ({ pro: 75000, ultra: 225000 }[plan]);
  const monthlyCap = limitFor("usage.monthly_pt") ?? (["pilot", "demo", "starter"].includes(plan) ? 20000 : null);
  // These are account billing-period PT, not language-model tokens or context.
  const monthly = (usedPt, cap, label) => cap == null || usedPt == null ? null
    : makeWindow(usedPt, cap, null, null, { zh: label, en: label === "手動本期" ? "Manual period" : "Billing period" }, "PT");
  const manualPeriod = monthly(meter.monthlyManualPt, manualCap, "手動本期");
  const accountPeriod = monthly(meter.monthlyUsd == null ? null : nonnegative(meter.monthlyUsd, "monthlyUsd") * 1000, monthlyCap, "帳號本期");
  // A sole billing-period allowance belongs in the long-window HUD, not in
  // the short-window slot. No duration or reset date is assumed.
  add("period", "本期 PT", manualPeriod && accountPeriod ? manualPeriod : null, accountPeriod || manualPeriod);
  const period = groups.find(group => group.id === "period");
  if (period) {
    period.windowLabels = { primary: !accountPeriod ? { zh: "帳號本期", en: "Account period" } : { zh: "手動本期", en: "Manual period" },
      secondary: accountPeriod ? { zh: "帳號本期", en: "Account period" } : { zh: "手動本期", en: "Manual period" },
      pace: { zh: "本期用量", en: "Period usage" }, longAbbreviation: "PT", shortAbbreviation: "PT" };
    period.detail = [manualPeriod && `Manual ${manualPeriod.used.toLocaleString("en-US")} / ${manualPeriod.limit.toLocaleString("en-US")} PT`,
      accountPeriod && `Account ${accountPeriod.used.toLocaleString("en-US")} / ${accountPeriod.limit.toLocaleString("en-US")} PT`].filter(Boolean).join(" · ");
  }
  if (!groups.length) throw new Error("Perch 尚未提供可計算比例的額度上限；不以 0% 代替未知用量。");
  const first = groups[0], active = first.primary || first.secondary;
  return { ...first, limitId: "perch:all", limitName: "Perch", planType: session.planName || plan || "Perch", source: "perch-account",
    groups, usedPercent: active.usedPercent, remainingPercent: active.remainingPercent,
    resetsAt: null, fetchedAt: new Date(now).toISOString(),
    account: { id: credential.accountId, email: credential.email }, credits: null };
}
function createQuotaService({ readToken = readCredential, fetchImpl = globalThis.fetch } = {}) {
  return { async getQuota() {
    const credential = await readToken();
    let response;
    try {
      response = await fetchImpl(`${OFFICIAL_ORIGIN}/api/perchai/account`, { method: "GET", redirect: "error",
        headers: { Accept: "application/json", Authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(15000) });
    } catch { throw new Error("無法連接 Perch 官方用量服務，請檢查網路後重試。"); }
    if ([401, 403].includes(response.status)) throw new Error("Perch authentication required：登入已失效，請先在 CLI 更新登入。");
    if (!response.ok) throw new Error(`Perch 用量查詢失敗（HTTP ${response.status}）。`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error("Perch 用量服務未回傳有效 JSON。"); }
    return normalizeAccount(payload, credential);
  } };
}
module.exports = { OFFICIAL_ORIGIN, readCredential, normalizeAccount, createQuotaService };
