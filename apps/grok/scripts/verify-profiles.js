// Grok 多帳號 profile：userData 分開、調色盤不撞色、app-config 覆寫。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DEFAULT_PROFILE_ID, EXTRA_PROFILE_PALETTE, resolveProfile, listExtraProfileIds } = require("../src/main/profile");

const ACCENT_KEYS = ["weekly", "weeklyStrong", "short", "shortStrong"];
const repoApps = path.resolve(__dirname, "..", "..");

function verifyResolve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-quota-userdata-"));
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

function verifyPalette() {
  assert.equal(EXTRA_PROFILE_PALETTE.length >= 3, true);
  for (const entry of EXTRA_PROFILE_PALETTE) {
    for (const key of ACCENT_KEYS) {
      assert.match(entry[key], /^#[0-9a-fA-F]{6}$/);
    }
  }
}

verifyResolve();
verifyPalette();
console.log("[verify-profiles] OK");
