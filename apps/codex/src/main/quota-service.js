const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildPaceAdvice } = require("../shared-gen/pace-advice");

// Codex 額度 = ChatGPT 訂閱方案的用量。直接打 OpenAI 的內部 endpoint 拿，
// 憑證用 Codex CLI 登入後留在 ~/.codex/auth.json 的 OAuth token，不再 spawn `codex` 子行程：
//   GET https://chatgpt.com/backend-api/wham/usage   Authorization: Bearer <access_token>
// token 過期就用 refresh_token 換新，再原子寫回 auth.json（沿用 Codex CLI 自己的檔案格式）。
// client id / endpoint 皆為 OpenAI 未公開介面（見 openai/codex codex-rs/login、backend-client），
// 改版即可能失效。

const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REQUEST_TIMEOUT_MS = 12000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // 距到期不到 5 分鐘就先 refresh

const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const SEVEN_DAY_WINDOW_MINS = 7 * 24 * 60;

function resolveAuthFilePath() {
  return process.env.CODEX_AUTH_FILE || DEFAULT_AUTH_FILE;
}

async function readAuthFile() {
  const filePath = resolveAuthFilePath();
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      // renderer 的 friendlyErrorMessage 會把含 "authentication required" 的錯誤換成友善文案。
      throw new Error(
        "Codex authentication required：找不到 ~/.codex/auth.json，請先安裝並執行 `codex login`。"
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`~/.codex/auth.json 內容不是有效 JSON：${error.message}`);
  }

  const tokens = parsed?.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) {
    throw new Error(
      "Codex authentication required：~/.codex/auth.json 缺少登入 token，請重新執行 `codex login`。"
    );
  }
  return { parsed, tokens };
}

async function writeAuthFileAtomically(parsed) {
  const filePath = resolveAuthFilePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

// id_token / access_token 是一起發的，用 id_token 的 exp 當「還新不新」的依據即可。
function decodeJwtExpiryMs(jwt) {
  try {
    const payloadPart = String(jwt).split(".")[1];
    if (!payloadPart) return null;
    const json = Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = JSON.parse(json)?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label}逾時`);
    throw new Error(`${label}連線失敗：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Codex authentication required：登入已失效（${label} ${response.status}），請重新執行 \`codex login\`。`
      );
    }
    throw new Error(`${label}失敗：HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}回應不是 JSON：${text.slice(0, 200)}`);
  }
}

async function refreshTokens(authData) {
  const data = await fetchJson(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: authData.tokens.refresh_token,
        scope: "openid profile email"
      })
    },
    "刷新 Codex 登入"
  );

  if (!data?.access_token) {
    throw new Error("刷新 Codex 登入沒有回傳 access_token。");
  }

  const nextTokens = {
    ...authData.tokens,
    access_token: data.access_token,
    id_token: data.id_token || authData.tokens.id_token,
    // OpenAI 每次 refresh 會輪替 refresh_token，一定要寫回。
    refresh_token: data.refresh_token || authData.tokens.refresh_token
  };
  await writeAuthFileAtomically({
    ...authData.parsed,
    tokens: nextTokens,
    last_refresh: new Date().toISOString()
  });
  return nextTokens;
}

async function getValidTokens() {
  const authData = await readAuthFile();
  const expiryMs = decodeJwtExpiryMs(authData.tokens.id_token);
  const needsRefresh = expiryMs === null || expiryMs - Date.now() < TOKEN_REFRESH_SKEW_MS;
  if (!needsRefresh) return authData.tokens;

  try {
    return await refreshTokens(authData);
  } catch (error) {
    if (String(error?.message).includes("authentication required")) throw error;
    // refresh 本身失敗（例如暫時性網路問題），手上的 access_token 也許還能撐一下，
    // 直接拿去打 usage；真的不行 fetchUsage() 會回 auth 錯誤。
    console.warn(`刷新 Codex 登入失敗，改用現有 token 試一次：${error.message}`);
    return authData.tokens;
  }
}

async function fetchUsage() {
  const tokens = await getValidTokens();
  return fetchJson(
    USAGE_URL,
    {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "ChatGPT-Account-Id": tokens.account_id || "",
        "User-Agent": "codex-cli",
        Accept: "application/json"
      }
    },
    "讀取 Codex 用量"
  );
}

async function getQuota() {
  const usage = await fetchUsage();
  const rateLimit = usage?.rate_limit;
  if (!rateLimit || (!rateLimit.primary_window && !rateLimit.secondary_window)) {
    throw new Error("Codex 用量回應缺少 rate_limit 區塊。");
  }

  const snapshot = {
    limitId: "codex",
    limitName: "Codex",
    planType: prettyPlan(usage.plan_type) || "Codex",
    rateLimitReachedType: usage.rate_limit_reached_type ?? null,
    credits: null,
    primary: whamWindow(rateLimit.primary_window, FIVE_HOUR_WINDOW_MINS),
    secondary: whamWindow(rateLimit.secondary_window, SEVEN_DAY_WINDOW_MINS)
  };

  return {
    ...normalizeSnapshot(snapshot),
    source: "codex",
    account: { email: typeof usage.email === "string" ? usage.email : null, label: null, source: "codex" }
  };
}

function prettyPlan(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// wham/usage 的 window：{ used_percent, limit_window_seconds, reset_after_seconds, reset_at(epoch 秒) }
function whamWindow(window, fallbackDurationMins) {
  if (!window || window.used_percent === undefined || window.used_percent === null) {
    return null;
  }
  const durationSeconds = Number(window.limit_window_seconds);
  return {
    usedPercent: window.used_percent,
    resetsAt: window.reset_at ?? null,
    windowDurationMins: Number.isFinite(durationSeconds) ? Math.round(durationSeconds / 60) : fallbackDurationMins
  };
}

function normalizeSnapshot(snapshot) {
  const primary = normalizeWindow(snapshot.primary);
  const secondary = normalizeWindow(snapshot.secondary);
  const activeWindow = primary || secondary;
  if (!activeWindow) {
    throw new Error("Codex rate-limit snapshot does not include a usable quota window.");
  }
  const normalized = {
    limitId: snapshot.limitId ?? "codex",
    limitName: snapshot.limitName ?? "Codex",
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
    throw new Error("Codex quota window is missing a numeric usedPercent.");
  }
  return clampPercent(usedPercent);
}

function normalizeResetTime(value) {
  if (value === null || value === undefined) return null;
  const timestampSeconds = Number(value);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Codex quota window has an invalid reset timestamp.");
  }
  return new Date(timestampSeconds * 1000).toISOString();
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

module.exports = {
  getQuota,
  normalizeSnapshot,
  prettyPlan,
  whamWindow,
  decodeJwtExpiryMs,
  resolveAuthFilePath
};
