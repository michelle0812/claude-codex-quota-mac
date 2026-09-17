// Claude 多帳號 profile：不需要 codexHome、userData 分開、調色盤不撞色、app-config 覆寫。
// profiles.json 的解析細節（壞檔、重複 id、不合法 id）在 apps/codex/scripts/verify-profiles.js 測共用的 profile-core。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DEFAULT_PROFILE_ID, EXTRA_PROFILE_PALETTE, resolveProfile, listExtraProfileIds } = require("../src/main/profile");

const ACCENT_KEYS = ["weekly", "weeklyStrong", "short", "shortStrong"];
const repoApps = path.resolve(__dirname, "..", "..");

function loadAppConfig(appName, search) {
  const file = path.join(repoApps, appName, "src", "app-config.js");
  const context = search === undefined ? { window: {} } : { window: {}, URLSearchParams, location: { search } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.window.APP_CONFIG;
}

function fingerprint(accent) {
  return ACCENT_KEYS.map((key) => accent[key].toLowerCase()).join("/");
}

function verifyResolve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-quota-userdata-"));
  try {
    fs.writeFileSync(
      path.join(dir, "profiles.json"),
      JSON.stringify({ profiles: [{ id: "default", name: "主帳號" }, { id: "2", name: "新帳號" }, { id: "3" }] })
    );
    // Claude 版額外帳號不需要任何額外欄位。
    assert.deepEqual(listExtraProfileIds(dir), ["2", "3"]);

    const main = resolveProfile([], dir);
    assert.equal(main.id, DEFAULT_PROFILE_ID);
    assert.equal(main.isDefault, true);
    assert.equal(main.userDataPath, dir);
    assert.equal(main.name, "主帳號");
    assert.equal(main.accent, null);

    const two = resolveProfile(["--profile=2"], dir);
    assert.equal(two.isDefault, false);
    assert.equal(two.name, "新帳號");
    assert.equal(two.userDataPath, `${dir}-2`, "claude.ai 登入存在 userData，額外帳號一定要分開");
    assert.deepEqual(two.accent, EXTRA_PROFILE_PALETTE[0]);

    const three = resolveProfile(["--profile=3"], dir);
    assert.equal(three.name, "#3");
    assert.deepEqual(three.accent, EXTRA_PROFILE_PALETTE[1]);

    assert.throws(() => resolveProfile(["--profile=9"], dir), /找不到 profile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Claude 額外帳號的調色盤：彼此不撞，也不撞兩個 app 的預設色與 Codex 額外帳號的調色盤。
function verifyPalette() {
  const codexPalette = require(path.join(repoApps, "codex", "src", "main", "profile")).EXTRA_PROFILE_PALETTE;
  const taken = new Map([
    [fingerprint(loadAppConfig("claude").accent), "claude default"],
    [fingerprint(loadAppConfig("codex").accent), "codex default"],
    ...codexPalette.map((accent, i) => [fingerprint(accent), `codex palette ${i}`])
  ]);
  const weeklies = new Set([...taken.keys()].map((key) => key.split("/")[0]));
  EXTRA_PROFILE_PALETTE.forEach((accent, index) => {
    for (const key of ACCENT_KEYS) assert.match(accent[key], /^#[0-9A-Fa-f]{6}$/);
    const fp = fingerprint(accent);
    assert.ok(!taken.has(fp), `Claude 調色盤第 ${index} 組和 ${taken.get(fp)} 撞色`);
    assert.ok(!weeklies.has(fp.split("/")[0]), `Claude 調色盤第 ${index} 組的 weekly 主色和別組一樣`);
    taken.set(fp, `claude palette ${index}`);
    weeklies.add(fp.split("/")[0]);
  });
}

function verifyAppConfigOverride() {
  const query = encodeURIComponent(JSON.stringify({ name: "新帳號", accent: EXTRA_PROFILE_PALETTE[0], extra: true }));
  const config = loadAppConfig("claude", `?profile=${query}`);
  assert.equal(config.accent.weekly, EXTRA_PROFILE_PALETTE[0].weekly);
  assert.equal(config.copy.zh.brand, "Claude · 新帳號");
  assert.equal(config.auth.label, "claude.ai 帳號（新帳號）");
  assert.match(config.copy.zh.authRequired, /齒輪/, "額外帳號沒有本機 statusLine，提示要改成去齒輪登入");

  const plain = loadAppConfig("claude", "");
  assert.equal(plain.copy.zh.brand, "Claude 用量");
  assert.equal(plain.accent.weekly, "#2694C8");
  assert.match(plain.copy.zh.authRequired, /statusLine/);
}

verifyResolve();
verifyPalette();
verifyAppConfigOverride();

console.log("Verified Claude profiles: per-profile userData, palette uniqueness across both apps, and app-config override.");
