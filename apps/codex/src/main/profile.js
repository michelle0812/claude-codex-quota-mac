"use strict";

// 多帳號：同一個 Codex 額度 App 用 `--profile=<id>` 多開，一個 profile = 一個帳號 = 一個面板。
//
// - 沒帶 --profile 就是 default：沿用原本的 userData 與 ~/.codex，行為跟單帳號時代完全一樣。
// - 其他帳號寫在「default 的 userData/profiles.json」：
//     { "profiles": [
//         { "id": "default", "name": "個人" },                       // 選填，只是幫預設帳號取名
//         { "id": "2", "name": "工作", "codexHome": "~/.codex-2" },
//         { "id": "3", "name": "備用", "codexHome": "~/.codex-3", "accent": { ... } }
//     ] }
//   帳號登入用 `CODEX_HOME=~/.codex-2 codex login`，每個帳號各一份 auth.json，
//   token 輪替時只寫自己那份，不會把別的帳號踢下線。
// - 每個 profile 的 userData 是 `<default userData>-<id>`；Electron 的 single-instance lock
//   跟著 userData 走，所以同一個 profile 不會重複開，不同 profile 可以並存。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PROFILE_ID = "default";
const PROFILES_FILE_NAME = "profiles.json";
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ACCENT_KEYS = ["weekly", "weeklyStrong", "short", "shortStrong"];
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

// 額外帳號依 profiles.json 裡的順序套用。default 不在這裡：它沿用 app-config.js 的綠色。
// 刻意避開 Claude 版的水藍（#2694C8 系），細條模式下才分得出來。
const EXTRA_PROFILE_PALETTE = [
  { weekly: "#1E9E9A", weeklyStrong: "#3CC4BE", short: "#6FE0D6", shortStrong: "#A6F0E8" }, // 青綠
  { weekly: "#8A9E1E", weeklyStrong: "#AEC43C", short: "#CCE06F", shortStrong: "#E2F0A6" }, // 黃綠
  { weekly: "#6A5ACD", weeklyStrong: "#8E80E6", short: "#B3A8F2", shortStrong: "#D4CDF8" }, // 紫
  { weekly: "#C87A26", weeklyStrong: "#E09A52", short: "#F0BE7D", shortStrong: "#F8DAB0" } // 橘
];

function parseProfileArg(argv = []) {
  for (const arg of argv) {
    const match = /^--profile=(.*)$/.exec(String(arg));
    if (!match) continue;
    const id = match[1].trim();
    if (!id || id === DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_ID;
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new Error(`--profile=${id} 不合法：只能用英數字、底線、連字號（最多 32 字）`);
    }
    return id;
  }
  return DEFAULT_PROFILE_ID;
}

function expandHome(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  const trimmed = p.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function isValidAccent(accent) {
  return Boolean(accent) && ACCENT_KEYS.every((key) => HEX_PATTERN.test(String(accent[key])));
}

function profilesFilePath(defaultUserDataPath) {
  return path.join(defaultUserDataPath, PROFILES_FILE_NAME);
}

// 讀 profiles.json。缺檔 = 只有 default；壞檔也退回只有 default（印警告，不讓整個 App 起不來）。
function loadProfilesFile(defaultUserDataPath) {
  const file = profilesFilePath(defaultUserDataPath);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`讀取 ${file} 失敗：${error.message}`);
    return { defaultEntry: null, extras: [] };
  }

  let list;
  try {
    list = JSON.parse(raw)?.profiles;
  } catch (error) {
    console.warn(`${file} 不是有效 JSON，先只開預設帳號：${error.message}`);
    return { defaultEntry: null, extras: [] };
  }
  if (!Array.isArray(list)) return { defaultEntry: null, extras: [] };

  let defaultEntry = null;
  const extras = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (id === DEFAULT_PROFILE_ID) {
      defaultEntry = entry;
      continue;
    }
    if (!PROFILE_ID_PATTERN.test(id)) {
      console.warn(`profiles.json：略過 id 不合法的項目 ${JSON.stringify(entry?.id)}`);
      continue;
    }
    if (seen.has(id)) {
      console.warn(`profiles.json：id ${id} 重複，只用第一筆`);
      continue;
    }
    if (!expandHome(entry.codexHome)) {
      console.warn(`profiles.json：${id} 缺少 codexHome，略過`);
      continue;
    }
    seen.add(id);
    extras.push({ ...entry, id });
  }
  return { defaultEntry, extras };
}

function cleanName(name) {
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : null;
}

// 回傳這個行程要用的 profile。defaultUserDataPath 是還沒被 setPath 改過的 app.getPath("userData")。
function resolveProfile(argv, defaultUserDataPath) {
  const id = parseProfileArg(argv);
  const { defaultEntry, extras } = loadProfilesFile(defaultUserDataPath);

  if (id === DEFAULT_PROFILE_ID) {
    return {
      id,
      name: cleanName(defaultEntry?.name),
      userDataPath: defaultUserDataPath,
      authFilePath: null, // null = quota-service 走原本的 CODEX_AUTH_FILE / ~/.codex/auth.json
      accent: isValidAccent(defaultEntry?.accent) ? pickAccent(defaultEntry.accent) : null
    };
  }

  const index = extras.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new Error(`profiles.json 裡找不到 profile「${id}」（${profilesFilePath(defaultUserDataPath)}）`);
  }
  const entry = extras[index];
  return {
    id,
    name: cleanName(entry.name) || `#${id}`,
    userDataPath: `${defaultUserDataPath}-${id}`,
    authFilePath: path.join(expandHome(entry.codexHome), "auth.json"),
    accent: isValidAccent(entry.accent)
      ? pickAccent(entry.accent)
      : EXTRA_PROFILE_PALETTE[index % EXTRA_PROFILE_PALETTE.length]
  };
}

function pickAccent(accent) {
  return Object.fromEntries(ACCENT_KEYS.map((key) => [key, accent[key]]));
}

// default 行程啟動時要帶起來的其他 profile id。
function listExtraProfileIds(defaultUserDataPath) {
  return loadProfilesFile(defaultUserDataPath).extras.map((entry) => entry.id);
}

module.exports = {
  DEFAULT_PROFILE_ID,
  EXTRA_PROFILE_PALETTE,
  parseProfileArg,
  expandHome,
  resolveProfile,
  listExtraProfileIds,
  profilesFilePath
};
