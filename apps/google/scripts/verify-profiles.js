// Google 多帳號 profile：userData 分開、調色盤不撞色、app-config 覆寫。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DEFAULT_PROFILE_ID, EXTRA_PROFILE_PALETTE, resolveProfile, listExtraProfileIds, reopenHooks } = require("../src/main/profile");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "google-quota-userdata-"));
  try {
    fs.writeFileSync(
      path.join(dir, "profiles.json"),
      JSON.stringify({ profiles: [{ id: "default", name: "主帳號" }, { id: "2", name: "新帳號" }, { id: "3" }] })
    );
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
    assert.equal(two.userDataPath, path.join(dir, "profiles", "2"));
    assert.deepEqual(two.accent, EXTRA_PROFILE_PALETTE[0]);

    const three = resolveProfile(["--profile=3"], dir);
    assert.equal(three.name, "#3");
    assert.deepEqual(three.accent, EXTRA_PROFILE_PALETTE[1]);

    assert.throws(() => resolveProfile(["--profile=9"], dir), /找不到 profile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Google 額外帳號的調色盤：彼此不撞，也不撞三款 app 的預設色與 Claude / Codex 額外帳號的調色盤。
function verifyPalette() {
  const claudePalette = require(path.join(repoApps, "claude", "src", "main", "profile")).EXTRA_PROFILE_PALETTE;
  const codexPalette = require(path.join(repoApps, "codex", "src", "main", "profile")).EXTRA_PROFILE_PALETTE;
  const taken = new Map([
    [fingerprint(loadAppConfig("claude").accent), "claude default"],
    [fingerprint(loadAppConfig("codex").accent), "codex default"],
    [fingerprint(loadAppConfig("google").accent), "google default"],
    ...claudePalette.map((accent, i) => [fingerprint(accent), `claude palette ${i}`]),
    ...codexPalette.map((accent, i) => [fingerprint(accent), `codex palette ${i}`])
  ]);
  const weeklies = new Set([...taken.keys()].map((key) => key.split("/")[0]));
  EXTRA_PROFILE_PALETTE.forEach((accent, index) => {
    for (const key of ACCENT_KEYS) assert.match(accent[key], /^#[0-9A-Fa-f]{6}$/);
    const fp = fingerprint(accent);
    assert.ok(!taken.has(fp), `Google 調色盤第 ${index} 組和 ${taken.get(fp)} 撞色`);
    assert.ok(!weeklies.has(fp.split("/")[0]), `Google 調色盤第 ${index} 組的 weekly 主色和別組一樣`);
    taken.set(fp, `google palette ${index}`);
    weeklies.add(fp.split("/")[0]);
  });
}

function verifyAppConfigOverride() {
  const query = encodeURIComponent(JSON.stringify({ name: "新帳號", accent: EXTRA_PROFILE_PALETTE[0], extra: true }));
  const config = loadAppConfig("google", `?profile=${query}`);
  assert.equal(config.accent.weekly, EXTRA_PROFILE_PALETTE[0].weekly);
  assert.equal(config.copy.zh.brand, "Google · 新帳號");
  assert.equal(config.auth.label, "Google 帳號（新帳號）");

  const plain = loadAppConfig("google", "");
  assert.equal(plain.copy.zh.brand, "Google 主帳號");
  assert.equal(plain.accent.weekly, "#D9658B");
}

function verifyReopenHooks() {
  const fakeApp = { isPackaged: true, getPath: () => "/nonexistent" };
  const main = reopenHooks(fakeApp, { isDefault: true }, "/tmp/none");
  assert.equal(typeof main.onReopen, "function");
  assert.equal(typeof main.onSecondInstance, "function");
  const extra = reopenHooks(fakeApp, { isDefault: false }, "/tmp/none");
  assert.equal(typeof extra.onReopen, "function");
  assert.equal(extra.onSecondInstance, undefined);
}

verifyResolve();
verifyReopenHooks();
verifyPalette();
verifyAppConfigOverride();

console.log("Verified Google profiles: per-profile userData, palette uniqueness across all apps, and app-config override.");
