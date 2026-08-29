// 更新檢查的純邏輯（不碰 electron，方便單元測試）。
// - isNewerVersion：semver 比對（只看數字段，忽略 pre-release 標籤）
// - msUntilNextWeeklySlot：算距離「下一個 星期X 時:分（某時區）」還有多少毫秒
// - fetchLatestRelease：打 GitHub API 拿最新 release 的 tag 與網址
//
// 使用者要求：只提醒、不自動下載、不背景偷偷更新。這裡只負責「知道有沒有新版」。

"use strict";

const https = require("node:https");

const RELEASES_PAGE = (repo) => `https://github.com/${repo}/releases/latest`;

function parseVersion(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^v/i, "");
  const core = cleaned.split(/[-+]/)[0];
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

// latest 比 current 新才回 true。任一個解析不出來就回 false（保守，不亂報有更新）。
function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// now：Date 或 timestamp。weekday：0=日..6=六（預設 1 = 星期一）。
// hour/minute：目標時刻。tzOffsetMinutes：目標時區相對 UTC 的分鐘數（台灣 = +480）。
// 回傳距離「下一個」該時刻的毫秒數（永遠 > 0）。
function msUntilNextWeeklySlot(now = Date.now(), opts = {}) {
  const { weekday = 1, hour = 10, minute = 0, tzOffsetMinutes = 480 } = opts;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  // 換算到「目標時區的牆上時鐘」：把 UTC 往前推 tzOffset 就是當地時間。
  const localNow = new Date(nowMs + tzOffsetMinutes * 60_000);
  const localDay = localNow.getUTCDay();

  let addDays = (weekday - localDay + 7) % 7;
  // 當地當天的目標時刻（用 UTC getter 讀，因為 localNow 已經是位移過的牆上時鐘）
  const slotLocal = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate() + addDays,
    hour,
    minute,
    0,
    0
  );
  // 轉回真正的 UTC timestamp
  let slotUtc = slotLocal - tzOffsetMinutes * 60_000;
  if (slotUtc <= nowMs) slotUtc += 7 * 24 * 60 * 60 * 1000;
  return slotUtc - nowMs;
}

function fetchLatestRelease(repo, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          "User-Agent": "claude-codex-quota-mac-update-check",
          Accept: "application/vnd.github+json"
        }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API 回應 ${res.statusCode}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            const version = parseVersion(json.tag_name);
            if (!version) {
              reject(new Error(`看不懂的 tag_name：${json.tag_name}`));
              return;
            }
            resolve({
              version: version.join("."),
              tag: json.tag_name,
              url: json.html_url || RELEASES_PAGE(repo)
            });
          } catch (error) {
            reject(new Error(`GitHub API 回應不是 JSON：${error.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("GitHub API 逾時"));
    });
  });
}

module.exports = { isNewerVersion, msUntilNextWeeklySlot, fetchLatestRelease, parseVersion, RELEASES_PAGE };
