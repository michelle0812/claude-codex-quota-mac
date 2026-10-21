"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildPaceAdvice } = require("../shared-gen/pace-advice");

const DEFAULT_GROK_HOME = path.join(os.homedir(), ".grok");
const DEFAULT_AUTH_FILE = path.join(DEFAULT_GROK_HOME, "auth.json");

function resolveGrokHome(customHome) {
  return customHome || process.env.GROK_HOME || DEFAULT_GROK_HOME;
}

function displayPath(filePath) {
  const home = os.homedir();
  return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

async function readAuth(grokHome = DEFAULT_GROK_HOME) {
  const authFile = path.join(grokHome, "auth.json");
  let raw;
  try {
    raw = await fs.readFile(authFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Grok authentication required：找不到 ${displayPath(authFile)}，請在終端機執行 grok login，或按齒輪連接。`);
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${displayPath(authFile)} 不是有效 JSON：${error.message}`);
  }

  const entry = Object.values(parsed)[0];
  if (!entry || !entry.key) {
    throw new Error(`Grok authentication required：${displayPath(authFile)} 缺少登入金鑰，請執行 grok login。`);
  }

  const identity = entry.email || entry.user_id || "grok-user";
  const accountId = crypto.createHash("sha256").update(identity).digest("hex");

  return {
    authFile,
    token: entry.key,
    email: entry.email || null,
    firstName: entry.first_name || null,
    userId: entry.user_id || null,
    expiresAt: entry.expires_at || null,
    accountId
  };
}

async function findLatestSessionDir(grokHome) {
  const sessionsRoot = path.join(grokHome, "sessions");
  let newestDir = null;
  let newestTime = 0;

  async function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(path.join(sub, "signals.json"));
          if (stat.mtimeMs > newestTime) {
            newestTime = stat.mtimeMs;
            newestDir = sub;
          }
        } catch {
          await walk(sub, depth + 1);
        }
      }
    }
  }

  await walk(sessionsRoot);
  return newestDir;
}

async function resolveActiveOrLatestSession(grokHome) {
  const activeSessionsFile = path.join(grokHome, "active_sessions.json");
  try {
    const raw = await fs.readFile(activeSessionsFile, "utf8");
    const activeSessions = JSON.parse(raw);
    if (Array.isArray(activeSessions) && activeSessions.length > 0) {
      const active = activeSessions[0];
      if (active.session_id && active.cwd) {
        const encodedCwd = encodeURIComponent(active.cwd);
        const candidate = path.join(grokHome, "sessions", encodedCwd, active.session_id);
        const stat = await fs.stat(path.join(candidate, "signals.json")).catch(() => null);
        if (stat) {
          return { sessionDir: candidate, isActive: true, sessionId: active.session_id };
        }
      }
    }
  } catch {
    // Fall back to scanning
  }

  const latestDir = await findLatestSessionDir(grokHome);
  if (latestDir) {
    return { sessionDir: latestDir, isActive: false, sessionId: path.basename(latestDir) };
  }
  return null;
}

function normalizeResetTime(value) {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Grok 用量視窗的 resets_at 不是有效時間戳。");
  return new Date(ms).toISOString();
}

function normalizeWindow(window) {
  if (!window) return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    throw new Error("Grok 用量視窗缺少數值型的 used_percentage。");
  }
  if (window.usedPercent < 0 || window.usedPercent > 100) throw new Error("Grok 用量比例超出範圍。");
  const usedPercent = Math.round(window.usedPercent * 100) / 100;
  return {
    usedPercent,
    remainingPercent: Math.round((100 - usedPercent) * 100) / 100,
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: normalizeResetTime(window.resetsAt)
  };
}

function normalizeSnapshot(snapshot, now = Date.now()) {
  const primary = normalizeWindow(snapshot.primary);
  const secondary = normalizeWindow(snapshot.secondary);
  const active = primary || secondary;
  if (!active) {
    throw new Error("Grok 用量快照沒有可用的額度視窗。");
  }

  const normalized = {
    limitId: snapshot.limitId ?? "grok",
    limitName: snapshot.limitName ?? "Grok",
    planType: snapshot.planType ?? "Grok Build",
    reachedType: snapshot.reachedType ?? null,
    credits: null,
    primary,
    secondary,
    remainingPercent: active.remainingPercent,
    usedPercent: active.usedPercent,
    resetsAt: active.resetsAt,
    fetchedAt: new Date(now).toISOString(),
    account: snapshot.account ?? null,
    sessionSummary: snapshot.sessionSummary ?? null
  };

  return {
    ...normalized,
    paceAdvice: buildPaceAdvice(normalized, normalized.fetchedAt)
  };
}

async function getQuota({ grokHome = DEFAULT_GROK_HOME, now = Date.now() } = {}) {
  const home = resolveGrokHome(grokHome);
  const auth = await readAuth(home);
  const sessionInfo = await resolveActiveOrLatestSession(home);

  let signals = null;
  let usage = null;
  let summary = null;

  if (sessionInfo?.sessionDir) {
    try {
      const signalsRaw = await fs.readFile(path.join(sessionInfo.sessionDir, "signals.json"), "utf8");
      signals = JSON.parse(signalsRaw);
    } catch { /* optional */ }

    try {
      const usageRaw = await fs.readFile(path.join(sessionInfo.sessionDir, "usage.json"), "utf8");
      usage = JSON.parse(usageRaw);
    } catch { /* optional */ }

    try {
      const summaryRaw = await fs.readFile(path.join(sessionInfo.sessionDir, "summary.json"), "utf8");
      summary = JSON.parse(summaryRaw);
    } catch { /* optional */ }
  }

  const modelId = signals?.primaryModelId || summary?.current_model_id || "grok-4.7";
  const usedPercent = typeof signals?.contextWindowUsage === "number"
    ? signals.contextWindowUsage
    : signals?.contextTokensUsed && signals?.contextWindowTokens
    ? Math.round((signals.contextTokensUsed / signals.contextWindowTokens) * 100)
    : 0;

  // Session tokens and cost details
  const totalTokens = usage?.session?.totalTokens ?? signals?.contextTokensUsed ?? 0;
  const costTicks = usage?.session?.costUsdTicks ?? 0;
  const costUsd = costTicks ? (costTicks / 1e10).toFixed(2) : "0.00";

  const sessionSummaryText = [
    `模型: ${modelId}`,
    signals?.contextTokensUsed ? `Context: ${Math.round(signals.contextTokensUsed / 1000)}k / ${Math.round((signals.contextWindowTokens || 256000) / 1000)}k` : null,
    totalTokens ? `總用量: ${(totalTokens / 1e6).toFixed(2)}M tokens` : null,
    costTicks ? `費用: $${costUsd}` : null
  ].filter(Boolean).join(" · ");

  const rawSnapshot = {
    limitId: "grok-context",
    limitName: `Grok (${modelId})`,
    planType: summary?.agent_name ? `Grok (${summary.agent_name})` : "Grok Build",
    reachedType: null,
    primary: {
      usedPercent,
      windowDurationMins: null,
      resetsAt: auth.expiresAt || null
    },
    secondary: {
      usedPercent: Math.min(100, Math.round((totalTokens / 10_000_000) * 100)),
      windowDurationMins: 24 * 60,
      resetsAt: auth.expiresAt || null
    },
    account: {
      id: auth.accountId,
      email: auth.email,
      name: auth.firstName
    },
    sessionSummary: sessionSummaryText
  };

  return normalizeSnapshot(rawSnapshot, now);
}

module.exports = {
  DEFAULT_GROK_HOME,
  DEFAULT_AUTH_FILE,
  readAuth,
  resolveGrokHome,
  resolveActiveOrLatestSession,
  getQuota,
  normalizeSnapshot
};
