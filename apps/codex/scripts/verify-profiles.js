// 多帳號 profile：argv 解析、profiles.json 讀取、userData / auth 路徑推導、主色不撞。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  DEFAULT_PROFILE_ID,
  EXTRA_PROFILE_PALETTE,
  parseProfileArg,
  expandHome,
  resolveProfile,
  listExtraProfileIds,
  profilesFilePath
} = require("../src/main/profile");

const ACCENT_KEYS = ["weekly", "weeklyStrong", "short", "shortStrong"];

function withUserData(profilesJson, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-userdata-"));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    if (profilesJson !== undefined) fs.writeFileSync(profilesFilePath(dir), profilesJson);
    fn(dir);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fingerprint(accent) {
  return ACCENT_KEYS.map((key) => accent[key].toLowerCase()).join("/");
}

function loadAppAccent(appName) {
  const file = path.resolve(__dirname, "..", "..", appName, "src", "app-config.js");
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.window.APP_CONFIG.accent;
}

function verifyParseProfileArg() {
  assert.equal(parseProfileArg([]), DEFAULT_PROFILE_ID);
  assert.equal(parseProfileArg(["/x/Electron", "."]), DEFAULT_PROFILE_ID);
  assert.equal(parseProfileArg(["--profile=2"]), "2");
  assert.equal(parseProfileArg(["--profile=work_a-1"]), "work_a-1");
  assert.equal(parseProfileArg(["--profile="]), DEFAULT_PROFILE_ID);
  assert.equal(parseProfileArg(["--profile=default"]), DEFAULT_PROFILE_ID);
  assert.throws(() => parseProfileArg(["--profile=../evil"]), /不合法/);
  assert.throws(() => parseProfileArg(["--profile=a/b"]), /不合法/);
}

function verifyExpandHome() {
  assert.equal(expandHome("~/.codex-2"), path.join(os.homedir(), ".codex-2"));
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome(""), null);
  assert.equal(expandHome(undefined), null);
}

function verifyMissingOrBrokenFile() {
  withUserData(undefined, (dir) => {
    assert.deepEqual(listExtraProfileIds(dir), []);
    const profile = resolveProfile([], dir);
    assert.equal(profile.id, DEFAULT_PROFILE_ID);
    assert.equal(profile.userDataPath, dir);
    assert.equal(profile.authFilePath, null);
    assert.equal(profile.name, null);
    assert.equal(profile.accent, null);
  });

  withUserData("{ not json", (dir) => {
    assert.deepEqual(listExtraProfileIds(dir), []);
    assert.equal(resolveProfile([], dir).id, DEFAULT_PROFILE_ID);
    assert.throws(() => resolveProfile(["--profile=2"], dir), /找不到 profile/);
  });
}

function verifyProfilesFile() {
  const json = JSON.stringify({
    profiles: [
      { id: "default", name: "個人" },
      { id: "2", name: "工作", codexHome: "~/.codex-2" },
      { id: "3", codexHome: "/tmp/codex-3" },
      { id: "../bad", codexHome: "~/.codex-bad" },
      { id: "2", name: "重複", codexHome: "~/.codex-dup" },
      { id: "nohome", name: "沒有 codexHome" },
      {
        id: "custom",
        codexHome: "~/.codex-c",
        accent: { weekly: "#112233", weeklyStrong: "#223344", short: "#334455", shortStrong: "#445566" }
      }
    ]
  });

  withUserData(json, (dir) => {
    assert.deepEqual(listExtraProfileIds(dir), ["2", "3", "custom"]);

    const main = resolveProfile([], dir);
    assert.equal(main.name, "個人");
    assert.equal(main.userDataPath, dir);
    assert.equal(main.authFilePath, null);

    const two = resolveProfile(["--profile=2"], dir);
    assert.equal(two.name, "工作");
    assert.equal(two.userDataPath, `${dir}-2`);
    assert.equal(two.authFilePath, path.join(os.homedir(), ".codex-2", "auth.json"));
    assert.deepEqual(two.accent, EXTRA_PROFILE_PALETTE[0]);

    const three = resolveProfile(["--profile=3"], dir);
    assert.equal(three.name, "#3");
    assert.equal(three.authFilePath, "/tmp/codex-3/auth.json");
    assert.deepEqual(three.accent, EXTRA_PROFILE_PALETTE[1]);

    const custom = resolveProfile(["--profile=custom"], dir);
    assert.equal(custom.accent.weekly, "#112233");

    assert.throws(() => resolveProfile(["--profile=nohome"], dir), /找不到 profile/);
  });
}

// 內建調色盤彼此不能撞，也不能撞到 Codex 預設綠與 Claude 水藍。
function verifyPaletteUniqueness() {
  const seen = new Map([
    [fingerprint(loadAppAccent("codex")), "codex default"],
    [fingerprint(loadAppAccent("claude")), "claude"]
  ]);
  EXTRA_PROFILE_PALETTE.forEach((accent, index) => {
    for (const key of ACCENT_KEYS) assert.match(accent[key], /^#[0-9A-Fa-f]{6}$/);
    const fp = fingerprint(accent);
    assert.ok(!seen.has(fp), `調色盤第 ${index} 組和 ${seen.get(fp)} 撞色`);
    seen.set(fp, `palette ${index}`);
    const weeklies = [...seen.keys()].map((key) => key.split("/")[0]);
    assert.equal(new Set(weeklies).size, weeklies.length, `調色盤第 ${index} 組的 weekly 主色和別組一樣`);
  });
}

// app-config.js 讀網址 ?profile= 覆寫名稱、主色與登入提示。
function verifyAppConfigOverride() {
  const file = path.resolve(__dirname, "..", "src", "app-config.js");
  const query = JSON.stringify({ name: "工作", accent: EXTRA_PROFILE_PALETTE[0] });
  const context = { window: {}, URLSearchParams, location: { search: `?profile=${encodeURIComponent(query)}` } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  const config = context.window.APP_CONFIG;
  assert.equal(config.accent.weekly, EXTRA_PROFILE_PALETTE[0].weekly);
  assert.equal(config.copy.zh.brand, "Codex · 工作");
  assert.equal(config.auth.label, "ChatGPT 帳號（工作）");

  const plain = { window: {}, URLSearchParams, location: { search: "" } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), plain, { filename: file });
  assert.equal(plain.window.APP_CONFIG.copy.zh.brand, "Codex 額度");
  assert.equal(plain.window.APP_CONFIG.accent.weekly, "#25985F");
}

verifyParseProfileArg();
verifyExpandHome();
verifyMissingOrBrokenFile();
verifyProfilesFile();
verifyPaletteUniqueness();
verifyAppConfigOverride();

console.log(
  "Verified Codex profiles: argv parsing, profiles.json loading, userData/auth paths, palette uniqueness, and app-config override."
);
