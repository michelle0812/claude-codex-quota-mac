const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildPaceAdvice } = require("../shared-gen/pace-advice");

// Codex 額度 = ChatGPT 訂閱方案的用量。直接打 OpenAI 的內部 endpoint 拿，
// 憑證用 Codex CLI 登入後留在 ~/.codex/auth.json 的 OAuth token，不再 spawn `codex` 子行程：
//   GET https://chatgpt.com/backend-api/wham/usage   Authorization: Bearer <access_token>
// 換不換 token 看這份 auth.json 歸誰管（main.js 依 profile 傳 allowRefresh）：
//   - 面板自己的窩（~/.codex/<id>，只有面板在用）：access_token 快過期就用 refresh_token 換新、原子寫回。
//   - 其他地方（例如指到 CLI 的 ~/.codex 或 CODEX_HOME 共用）：唯讀，絕不 refresh／寫回——
//     OpenAI 每次 refresh 都會輪替 refresh_token，會把同一份登入的 Codex CLI 踢掉（401 token_revoked）；
//     token 的新鮮度交給 codex CLI 自己維持。
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

// 多帳號時由 main.js 傳入各 profile 的 <CODEX_HOME>/auth.json；沒傳就是單帳號的老路徑。
function resolveAuthFilePath(authFilePath) {
  return authFilePath || process.env.CODEX_AUTH_FILE || DEFAULT_AUTH_FILE;
}

function displayPath(filePath) {
  const home = os.homedir();
  return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

// 預設帳號叫使用者跑 `codex login`；其他帳號要帶上自己的 CODEX_HOME，不然會登進預設帳號。
function loginCommand(filePath) {
  if (filePath === DEFAULT_AUTH_FILE) return "codex login";
  return `CODEX_HOME=${displayPath(path.dirname(filePath))} codex login`;
}

async function readAuthFile(authFilePath) {
  const filePath = resolveAuthFilePath(authFilePath);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      // renderer 的 friendlyErrorMessage 會把含 "authentication required" 的錯誤換成友善文案。
      throw new Error(
        `Codex authentication required：找不到 ${displayPath(filePath)}，請按齒輪登入 ChatGPT，或執行 \`${loginCommand(filePath)}\`。`
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${displayPath(filePath)} 內容不是有效 JSON：${error.message}`);
  }

  const tokens = parsed?.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) {
    throw new Error(
      `Codex authentication required：${displayPath(filePath)} 缺少登入 token，請按齒輪重新登入 ChatGPT，或執行 \`${loginCommand(filePath)}\`。`
    );
  }
  return { filePath, parsed, tokens };
}

async function writeAuthFileAtomically(filePath, parsed) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function decodeJwtPayload(jwt) {
  try {
    const payloadPart = String(jwt).split(".")[1];
    if (!payloadPart) return null;
    const json = Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

// 「還新不新」看 access_token 的 exp（打 usage 用的就是它，實測效期 10 天）；
// id_token 只有 1 小時，拿它當依據會每小時換一次 token。access_token 解不開才退回 id_token。
function decodeJwtExpiryMs(jwt) {
  const exp = decodeJwtPayload(jwt)?.exp;
  return Number.isFinite(exp) ? exp * 1000 : null;
}

async function fetchJson(url, options, label, filePath) {
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
        `Codex authentication required：登入已失效（${label} ${response.status}），請按齒輪重新登入 ChatGPT，或執行 \`${loginCommand(filePath)}\`。`
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
    "刷新 Codex 登入",
    authData.filePath
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
  await writeAuthFileAtomically(authData.filePath, {
    ...authData.parsed,
    tokens: nextTokens,
    last_refresh: new Date().toISOString()
  });
  return nextTokens;
}

// allowRefresh=false（預設）：唯讀，只讀出 auth.json 現有的 token。access_token 若已過期，
// fetchUsage() 打 usage 時會收到 401，由 fetchJson() 轉成「請重新登入」；token 的更新交給 codex CLI。
// allowRefresh=true：只給面板自己的窩用，快過期就 refresh 並寫回。
async function getValidTokens(authFilePath, allowRefresh) {
  const authData = await readAuthFile(authFilePath);
  if (!allowRefresh) return authData.tokens;

  const expiryMs = decodeJwtExpiryMs(authData.tokens.access_token) ?? decodeJwtExpiryMs(authData.tokens.id_token);
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

async function fetchUsage(authFilePath, allowRefresh) {
  const tokens = await getValidTokens(authFilePath, allowRefresh);
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
    "讀取 Codex 用量",
    resolveAuthFilePath(authFilePath)
  );
}

// quota-store 會用 readQuota(reason) 呼叫，reason 是字串，所以只認物件形式的 options。
async function getQuota(options) {
  const opts = options && typeof options === "object" ? options : {};
  const usage = await fetchUsage(opts.authFilePath, opts.allowRefresh === true);
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
  OAUTH_CLIENT_ID,
  TOKEN_URL,
  readAuthFile,
  writeAuthFileAtomically,
  decodeJwtPayload,
  getQuota,
  normalizeSnapshot,
  prettyPlan,
  whamWindow,
  decodeJwtExpiryMs,
  resolveAuthFilePath,
  loginCommand
};
