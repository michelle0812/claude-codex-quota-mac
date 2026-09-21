"use strict";

// 多帳號（兩個 app 共用）：同一個 App 用 `--profile=<id>` 多開，一個 profile = 一個帳號 = 一個面板。
//
// - 沒帶 --profile 就是 default：沿用原本的 userData，行為跟單帳號時代完全一樣。
// - 其他帳號寫在「default 的 userData/profiles.json」：
//     { "profiles": [
//         { "id": "default", "name": "個人" },          // 選填，只是幫預設帳號取名／設主色
//         { "id": "2", "name": "工作", "accent": { ... } }, // 各 app 可以再要求自己的欄位（例如 Codex 的 codexHome）
//     ] }
// - 每個 profile 的 userData 收在 `<default userData>/profiles/<id>`；Electron 的 single-instance
//   lock 跟著 userData 走，所以同一個 profile 不會重複開，不同 profile 可以並存。
//   刻意做成巢狀子資料夾，不在 Application Support 底下散出 xxx-2、xxx-3。
// - 這支只 require node 內建模組；launchExtraProfiles 需要的 electron app 由呼叫端傳入。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PROFILE_ID = "default";
const PROFILES_DIR_NAME = "profiles";
const ADD_ID_PREFIX = "add-";
// 孤兒清理只敢碰名字長這樣的資料夾（App 自己發出去的 id），使用者手放進去的東西一律不動。
const ADD_ID_PATTERN = /^add-[1-9][0-9]*$/;
const PROFILES_FILE_NAME = "profiles.json";
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ACCENT_KEYS = ["weekly", "weeklyStrong", "short", "shortStrong"];
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

// 額外帳號的 userData：收在預設 userData 底下的 profiles/<id>，不在旁邊長出平行資料夾。
function profileUserDataPath(defaultUserDataPath, id) {
  return path.join(defaultUserDataPath, PROFILES_DIR_NAME, id);
}

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

function pickAccent(accent) {
  return Object.fromEntries(ACCENT_KEYS.map((key) => [key, accent[key]]));
}

// ---- 面板增減（＋／－）----
// profiles.json 是唯一的帳號清單，＋－ 就是在改它。
// 讀改寫都在 default 行程裡做，避免多份同時寫同一個檔。

function readRawProfiles(defaultUserDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesFilePath(defaultUserDataPath), "utf8"));
    return Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  } catch {
    return [];
  }
}

function writeRawProfiles(defaultUserDataPath, profiles) {
  const file = profilesFilePath(defaultUserDataPath);
  const tempFile = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tempFile, `${JSON.stringify({ profiles }, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, file);
}

// 下一個沒被用掉的 id：add-1、add-2、add-3…（default 是主面板，不占號碼）。
// 刻意找「最小的空號」而不是一路往上加：刪掉 add-2 之後再按＋，拿回來的還是 add-2。
function nextProfileId(defaultUserDataPath) {
  const used = new Set(readRawProfiles(defaultUserDataPath).map((entry) => String(entry?.id ?? "").trim()));
  for (let n = 1; n <= 99; n += 1) {
    const id = `${ADD_ID_PREFIX}${n}`;
    if (!used.has(id)) return id;
  }
  return null;
}

// 新增一個空帳號並回傳它的 id。帳號本身不在這裡登入 —— 面板開起來之後，
// 使用者在齒輪裡登入，登入結果就寫進這個 profile 自己的 userData。
// buildEntry(id) 讓各 app 補自己需要的欄位（Codex 要 codexHome）。
function addProfile(defaultUserDataPath, { buildEntry, name } = {}) {
  const id = nextProfileId(defaultUserDataPath);
  if (!id) throw new Error("面板數量已達上限");

  const profiles = readRawProfiles(defaultUserDataPath);
  const cleanedName = cleanName(name);
  const entry = { id, ...(cleanedName ? { name: cleanedName } : {}), ...(buildEntry ? buildEntry(id) : {}) };
  profiles.push(entry);
  writeRawProfiles(defaultUserDataPath, profiles);
  return id;
}

// 移除一個額外帳號。default 永遠不能移除 —— 這就是「至少保留一個面板」的守門。
// 回傳被移掉的那一筆（app 層要靠它才知道還有哪些東西該清，例如 Codex 的 codexHome）。
function removeProfile(defaultUserDataPath, id) {
  if (!id || id === DEFAULT_PROFILE_ID) throw new Error("主面板不能移除");
  const profiles = readRawProfiles(defaultUserDataPath);
  const removed = profiles.find((entry) => String(entry?.id ?? "").trim() === id) || null;
  const kept = profiles.filter((entry) => String(entry?.id ?? "").trim() !== id);
  if (kept.length === profiles.length) return null;
  writeRawProfiles(defaultUserDataPath, kept);
  return removed;
}

// 孤兒清理：profiles/ 底下有資料夾、但 profiles.json 裡沒這一筆 = 已經被「－」掉的殘骸。
//
// 為什麼要這樣繞：面板沒辦法一邊用自己的 userData、一邊把它刪掉，所以「－」只負責
// 改 profiles.json 並關掉自己，真正刪資料夾交給主面板事後收。刪不乾淨也不怕，
// 下次主面板啟動會再補一次。
//
// 三道閘一個都不能少：必須在 profiles/ 底下、名字必須是 add-N、而且不是現役的 id。
// 使用者自己放在 profiles/ 裡的東西（名字不符 add-N）一律不動。
function cleanupOrphanProfileDirs(defaultUserDataPath) {
  const dir = path.join(defaultUserDataPath, PROFILES_DIR_NAME);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const live = new Set(readRawProfiles(defaultUserDataPath).map((entry) => String(entry?.id ?? "").trim()));
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!ADD_ID_PATTERN.test(entry.name)) continue;
    if (live.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      console.warn(`清除已刪面板 ${entry.name} 的資料夾失敗：${error.message}`);
    }
  }
  return removed;
}

function profilesFilePath(defaultUserDataPath) {
  return path.join(defaultUserDataPath, PROFILES_FILE_NAME);
}

function cleanName(name) {
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : null;
}

// 讀 profiles.json。缺檔 = 只有 default；壞檔也退回只有 default（印警告，不讓整個 App 起不來）。
// validateEntry(entry) 回傳錯誤字串代表這筆不能用（例如 Codex 缺 codexHome），回 null 代表 OK。
function loadProfilesFile(defaultUserDataPath, { validateEntry } = {}) {
  const file = profilesFilePath(defaultUserDataPath);
  const empty = { defaultEntry: null, extras: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`讀取 ${file} 失敗：${error.message}`);
    return empty;
  }

  let list;
  try {
    list = JSON.parse(raw)?.profiles;
  } catch (error) {
    console.warn(`${file} 不是有效 JSON，先只開預設帳號：${error.message}`);
    return empty;
  }
  if (!Array.isArray(list)) return empty;

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
    const problem = validateEntry ? validateEntry(entry) : null;
    if (problem) {
      console.warn(`profiles.json：${id} ${problem}，略過`);
      continue;
    }
    seen.add(id);
    extras.push({ ...entry, id });
  }
  return { defaultEntry, extras };
}

// 回傳這個行程要用的 profile。defaultUserDataPath 是還沒被 setPath 改過的 app.getPath("userData")。
// palette：額外帳號沒指定 accent 時，依 profiles.json 裡的順序套用。
function resolveProfile(argv, defaultUserDataPath, { palette = [], validateEntry } = {}) {
  const id = parseProfileArg(argv);
  const { defaultEntry, extras } = loadProfilesFile(defaultUserDataPath, { validateEntry });

  if (id === DEFAULT_PROFILE_ID) {
    return {
      id,
      isDefault: true,
      name: cleanName(defaultEntry?.name),
      userDataPath: defaultUserDataPath,
      entry: defaultEntry || {},
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
    isDefault: false,
    name: cleanName(entry.name) || `#${id}`,
    userDataPath: profileUserDataPath(defaultUserDataPath, id),
    entry,
    accent: isValidAccent(entry.accent)
      ? pickAccent(entry.accent)
      : palette.length > 0
        ? palette[index % palette.length]
        : null
  };
}

// default 行程啟動時要帶起來的其他 profile id。
function listExtraProfileIds(defaultUserDataPath, { validateEntry } = {}) {
  return loadProfilesFile(defaultUserDataPath, { validateEntry }).extras.map((entry) => entry.id);
}

// 給 renderer / settings 視窗網址 ?profile= 用的內容（app-config.js 會讀）。沒名稱也沒主色就不帶。
function rendererQueryFor(profile) {
  return profile.name || profile.accent ? { name: profile.name, accent: profile.accent } : undefined;
}

// 再啟動一份同一個 App。目標 profile 已經在跑時，新的那份拿不到 single-instance lock 會自己結束，
// 並讓對方收到 second-instance（→ 叫回視窗）；沒在跑就真的開起來。
// 新面板從按下＋到建好自己的資料夾，實測不到一秒；給到 6 秒是留給冷啟動。
const LAUNCH_TIMEOUT_MS = 6000;

function waitForProfileDir(defaultUserDataPath, id, timeoutMs) {
  const target = profileUserDataPath(defaultUserDataPath, id);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (fs.existsSync(target)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// 「－」的確認視窗。用 Electron 原生 dialog（不是網頁 alert），
// 預設落在「取消」，避免一個 Enter 就把帳號資料砍掉。
function confirmRemovePanel(dialog, browserWindow, profile) {
  const label = profile.name ? `${profile.name}（${profile.id}）` : profile.id;
  const options = {
    type: "warning",
    buttons: ["取消", "刪除面板"],
    defaultId: 0,
    cancelId: 0,
    title: "刪除面板",
    message: `刪除面板「${label}」？`,
    detail: "這個面板的登入資料會一併清空，無法還原。\n之後再按＋會拿到一個全新的空面板，需要重新登入。"
  };
  const index = browserWindow
    ? dialog.showMessageBoxSync(browserWindow, options)
    : dialog.showMessageBoxSync(options);
  return index === 1;
}

// main-core 的 config.panels：面板上的 ＋／－ 靠這組做事。
//   ＋ 在 profiles.json 加一筆空帳號，再開一份 App 帶 --profile=<id>（面板裡自己登入）
//   － 把自己從 profiles.json 移掉並關閉自己；主面板（default）不給移除
// buildEntry(id)：各 app 補自己要的欄位（Codex 需要 codexHome）。
function panelHooks(app, profile, defaultUserDataPath, { buildEntry, validateEntry, confirmRemove, cleanupEntry } = {}) {
  const isDefault = profile.isDefault ?? profile.id === DEFAULT_PROFILE_ID;
  return {
    // 主面板啟動時先收一次殘骸（上一輪被「－」掉的面板資料夾）。
    cleanupOrphans() {
      if (!isDefault) return [];
      return cleanupOrphanProfileDirs(defaultUserDataPath);
    },
    getState() {
      // 面板關閉後主面板才刪得掉它的資料夾，所以查狀態時順手再收一次。
      if (isDefault) cleanupOrphanProfileDirs(defaultUserDataPath);
      const extras = listExtraProfileIds(defaultUserDataPath, { validateEntry });
      return {
        id: profile.id,
        name: profile.name || null,
        isDefault,
        panelCount: extras.length + 1,
        canAdd: isDefault && nextProfileId(defaultUserDataPath) !== null,
        // 主面板是其他面板的樞紐（負責把大家叫回來），所以它自己不給關 ——
        // 這同時保證了「至少留一個面板」。
        canRemove: !isDefault
      };
    },
    // 命名視窗要先知道會配到哪個 id，好拿來當預設名稱的提示。
    nextId() {
      return isDefault ? nextProfileId(defaultUserDataPath) : null;
    },
    async add({ name } = {}) {
      if (!isDefault) return { ok: false, reason: "not-default" };
      let id;
      try {
        id = addProfile(defaultUserDataPath, { buildEntry, name });
      } catch (error) {
        return { ok: false, reason: "add-failed", message: error.message };
      }

      spawnSelf(app, [`--profile=${id}`]);

      // 確認它真的起來了。新面板一啟動就會建自己的 userData 資料夾，拿這個當憑據。
      // 沒起來就把剛寫進 profiles.json 的那筆撤掉 —— 否則使用者每按一次沒反應的＋，
      // 清單就多一筆幽靈帳號，而且主面板會以為面板數變多了。
      const started = await waitForProfileDir(defaultUserDataPath, id, LAUNCH_TIMEOUT_MS);
      if (!started) {
        try {
          const rolledBack = removeProfile(defaultUserDataPath, id);
          if (rolledBack && cleanupEntry) cleanupEntry(rolledBack, id);
        } catch (error) {
          console.warn(`撤回沒啟動成功的面板 ${id} 失敗：${error.message}`);
        }
        return { ok: false, reason: "launch-failed", message: `新面板 ${id} 沒有啟動起來` };
      }
      return { ok: true, id };
    },
    remove() {
      if (isDefault) return { ok: false, reason: "last-panel" };

      // 資料刪掉就回不來了，先問過使用者。
      if (confirmRemove && !confirmRemove(profile)) return { ok: false, reason: "cancelled" };

      let removed;
      try {
        removed = removeProfile(defaultUserDataPath, profile.id);
      } catch (error) {
        return { ok: false, reason: "remove-failed", message: error.message };
      }

      // 自己的 userData 沒辦法自己刪（正用著），交給主面板的孤兒清理。
      // 這裡只清「自己以外」的東西，例如 Codex 那個帳號的 codexHome。
      if (removed && cleanupEntry) {
        try {
          cleanupEntry(removed, profile.id);
        } catch (error) {
          console.warn(`清除面板 ${profile.id} 的帳號資料失敗：${error.message}`);
        }
      }
      return { ok: true, id: profile.id, quitSelf: true };
    }
  };
}

// 自己這份行程若是被 --user-data-dir 指到別的地方跑的（測試／隔離用），
// 開出來的新面板也要跟著去同一個地方，否則它會回頭讀正式的 profiles.json，
// 找不到自己的 profile 就靜靜地結束 —— 看起來就是「按了沒反應」。
function inheritedUserDataDirArg() {
  const arg = process.argv.find((item) => String(item).startsWith("--user-data-dir="));
  return arg ? [arg] : [];
}

function spawnSelf(app, args) {
  const allArgs = [...args, ...inheritedUserDataDirArg()];
  if (app.isPackaged) {
    // .../X.app/Contents/MacOS/X → .../X.app
    const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
    spawn("/usr/bin/open", ["-n", "-a", bundlePath, "--args", ...allArgs], { detached: true, stdio: "ignore" }).unref();
  } else {
    // npm start：直接用同一顆 electron 再開一份。
    spawn(process.execPath, [app.getAppPath(), ...allArgs], { detached: true, stdio: "ignore" }).unref();
  }
}

// 在 default 行程裡呼叫：把其他帳號各開一份（或叫回已經在跑的）。
function launchExtraProfiles(app, defaultUserDataPath, { validateEntry } = {}) {
  for (const id of listExtraProfileIds(defaultUserDataPath, { validateEntry })) {
    try {
      spawnSelf(app, [`--profile=${id}`]);
    } catch (error) {
      console.warn(`帶起 profile ${id} 失敗：${error.message}`);
    }
  }
}

// 在額外帳號行程裡呼叫：叫 default 出來，由它再把所有帳號的面板叫回來。
function launchDefaultProfile(app) {
  try {
    spawnSelf(app, []);
  } catch (error) {
    console.warn(`叫回預設面板失敗：${error.message}`);
  }
}

// main.js 直接展開進 startQuotaWidget 的 config：
//   default：被叫起來或使用者再打開 App → 叫回其他帳號
//   額外帳號：使用者再打開 App（macOS 剛好通知到這份）→ 叫 default；被叫起來 → 只顯示自己，不再往外叫
function reopenHooks(app, profile, defaultUserDataPath, { validateEntry } = {}) {
  if (profile.isDefault) {
    const launchExtras = () => launchExtraProfiles(app, defaultUserDataPath, { validateEntry });
    return { onReopen: launchExtras, onSecondInstance: launchExtras };
  }
  return { onReopen: () => launchDefaultProfile(app), onSecondInstance: undefined };
}

module.exports = {
  DEFAULT_PROFILE_ID,
  ACCENT_KEYS,
  parseProfileArg,
  expandHome,
  isValidAccent,
  resolveProfile,
  listExtraProfileIds,
  profilesFilePath,
  rendererQueryFor,
  profileUserDataPath,
  nextProfileId,
  addProfile,
  removeProfile,
  cleanupOrphanProfileDirs,
  confirmRemovePanel,
  panelHooks,
  launchExtraProfiles,
  launchDefaultProfile,
  reopenHooks
};
