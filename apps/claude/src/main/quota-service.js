const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildPaceAdvice } = require("../shared-gen/pace-advice");

// Claude Code 每次刷新 statusLine 時會把完整 session JSON 從 stdin 傳給 hook script，
// 由 scripts/usage-statusline.py 落地成這個檔。widget 反向讀取它，
// 取出 rate_limits.five_hour / seven_day 的已用百分比與重置時間。
const DEFAULT_STATUS_FILE = path.join(os.homedir(), ".claude", "usage-status.json");

// usage-status.json 沒有訂閱方案資訊，方案要另外從這兩個檔案讀（只取方案字串，不碰 token）。
const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const CLAUDE_CONFIG_FILE = path.join(os.homedir(), ".claude.json");

const PLAN_LABELS = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  max_5x: "Max 5×",
  max_20x: "Max 20×",
  team: "Team",
  enterprise: "Enterprise"
};

// 超過這個時間沒有新的 statusLine 更新，就視為資料過期（Claude Code 沒在跑）。
const STALE_AFTER_MS = 20 * 60 * 1000;

const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const SEVEN_DAY_WINDOW_MINS = 7 * 24 * 60;

function resolveStatusFilePath() {
  return process.env.CLAUDE_USAGE_STATUS_FILE || DEFAULT_STATUS_FILE;
}

async function readStatusFile() {
  const filePath = resolveStatusFilePath();
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "找不到 ~/.claude/usage-status.json，請先安裝 Claude Code 的 statusLine hook（見 README 的「安裝 statusLine hook」）。"
      );
    }
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`usage-status.json 內容不是有效 JSON：${error.message}`);
  }
}

function prettyPlan(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().replace(/^claude[_-]/, "");
  return PLAN_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

// 方案來源：優先 ~/.claude/.credentials.json 的 claudeAiOauth.subscriptionType
// （Claude Code 自己用的權威欄位），讀不到再退到 ~/.claude.json 的 oauthAccount.organizationType。
async function readPlan() {
  try {
    const cred = JSON.parse(await fs.readFile(CREDENTIALS_FILE, "utf8"));
    const plan = prettyPlan(cred?.claudeAiOauth?.subscriptionType);
    if (plan) return plan;
  } catch {
    /* 檔案不存在或無法解析就往下試 */
  }
  try {
    const cfg = JSON.parse(await fs.readFile(CLAUDE_CONFIG_FILE, "utf8"));
    const plan = prettyPlan(cfg?.oauthAccount?.organizationType);
    if (plan) return plan;
  } catch {
    /* 忽略 */
  }
  return null;
}

async function getQuota() {
  const data = await readStatusFile();
  const limits = data?.rate_limits;

  if (!limits || (!limits.five_hour && !limits.seven_day)) {
    throw new Error(
      "usage-status.json 缺少 rate_limits 區塊，請在 Claude Code 內至少跑過一次對話讓 statusLine hook 寫入資料。"
    );
  }

  const receivedAtMs = Number(data._received_at_ts) * 1000;
  if (Number.isFinite(receivedAtMs) && Date.now() - receivedAtMs > STALE_AFTER_MS) {
    const minutes = Math.round((Date.now() - receivedAtMs) / 60000);
    throw new Error(`usage-status.json 已 ${minutes} 分鐘沒有更新，請開一個 Claude Code session 讓它刷新。`);
  }

  const plan = await readPlan();
  const snapshot = {
    limitId: "claude",
    limitName: data?.model?.display_name ? `Claude Code · ${data.model.display_name}` : "Claude Code",
    planType: plan || "Claude Code",
    rateLimitReachedType: null,
    credits: null,
    primary: rawWindow(limits.five_hour, FIVE_HOUR_WINDOW_MINS),
    secondary: rawWindow(limits.seven_day, SEVEN_DAY_WINDOW_MINS)
  };

  const normalized = normalizeSnapshot(snapshot);
  const fetchedAt = typeof data._received_at === "string" ? data._received_at : normalized.fetchedAt;

  return {
    ...normalized,
    fetchedAt,
    paceAdvice: buildPaceAdvice({ ...normalized, fetchedAt }, fetchedAt)
  };
}

function rawWindow(window, windowDurationMins) {
  if (!window || window.used_percentage === undefined || window.used_percentage === null) {
    return null;
  }
  return {
    usedPercent: window.used_percentage,
    resetsAt: window.resets_at ?? null,
    windowDurationMins
  };
}

function normalizeSnapshot(snapshot) {
  const primary = normalizeWindow(snapshot.primary);
  const secondary = normalizeWindow(snapshot.secondary);
  const activeWindow = primary || secondary;
  if (!activeWindow) {
    throw new Error("Claude 用量快照沒有可用的額度視窗。");
  }
  const normalized = {
    limitId: snapshot.limitId ?? "claude",
    limitName: snapshot.limitName ?? "Claude Code",
    planType: snapshot.planType ?? "unknown",
    reachedType: snapshot.rateLimitReachedType ?? null,
    credits: snapshot.credits ?? null,
    primary,
    secondary,
    remainingPercent: activeWindow.remainingPercent,
    usedPercent: activeWindow.usedPercent,
    resetsAt: activeWindow.resetsAt,
    fetchedAt: new Date().toISOString()
  };

  return {
    ...normalized,
    paceAdvice: buildPaceAdvice(normalized, normalized.fetchedAt)
  };
}

function normalizeWindow(window) {
  if (!window) return null;
  const usedPercent = normalizeUsedPercent(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: normalizeResetTime(window.resetsAt)
  };
}

function normalizeUsedPercent(value) {
  const usedPercent = Number(value);
  if (!Number.isFinite(usedPercent)) {
    throw new Error("Claude 用量視窗缺少數值型的 used_percentage。");
  }
  return clampPercent(usedPercent);
}

function normalizeResetTime(value) {
  if (value === null || value === undefined) return null;
  const timestampSeconds = Number(value);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Claude 用量視窗的 resets_at 不是有效時間戳。");
  }
  return new Date(timestampSeconds * 1000).toISOString();
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

module.exports = { getQuota, normalizeSnapshot, resolveStatusFilePath, readPlan };
