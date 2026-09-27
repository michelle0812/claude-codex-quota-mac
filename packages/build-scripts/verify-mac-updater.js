"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { selectUpdateAssets, checksumFor, downloadAsset, acquireUpdateLock, supportsArchitecture } = require("../shared/mac-updater");
const { installUpdate } = require("../shared/update-installer");

const repo = "michelle0812/claude-codex-quota-mac";
const asset = (name) => ({ name, size: 3, url: `https://github.com/${repo}/releases/download/v1.2.2/${name}` });
const release = { version: "1.2.2", tag: "v1.2.2", assets: [
  asset("CodexQuota-1.2.2-macOS-arm.dmg"), asset("CodexQuota-1.2.2-macOS-intel.dmg"), asset("SHA256SUMS.txt")
] };
const options = { assetPrefix: "CodexQuota", arch: "arm64", repo };

async function verifyAssetsAndDownload(root) {
  const thin = Buffer.alloc(8);
  thin.writeUInt32LE(0xfeedfacf, 0);
  thin.writeUInt32LE(0x01000007, 4);
  assert.equal(supportsArchitecture(thin, "x64"), true);
  assert.equal(supportsArchitecture(thin, "arm64"), false);
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.equal(supportsArchitecture(fat, "x64"), true);
  assert.equal(supportsArchitecture(fat, "arm64"), true);
  assert.equal(supportsArchitecture(fat.subarray(0, 20), "arm64"), false);
  assert.equal(supportsArchitecture(Buffer.from("invalid"), "x64"), false);
  assert.equal(selectUpdateAssets(release, options).image.name, "CodexQuota-1.2.2-macOS-arm.dmg");
  assert.equal(selectUpdateAssets(release, { ...options, arch: "x64" }).image.name, "CodexQuota-1.2.2-macOS-intel.dmg");
  assert.throws(() => selectUpdateAssets(release, { ...options, assetPrefix: "ClaudeQuota" }), /缺少/);
  assert.throws(() => selectUpdateAssets({ ...release, assets: [] }, options), /缺少/);
  const malicious = structuredClone(release);
  malicious.assets[0].url = "https://github.com/other/repo/releases/download/v1.2.2/file.dmg";
  assert.throws(() => selectUpdateAssets(malicious, options), /不屬於/);
  const hash = crypto.createHash("sha256").update("abc").digest("hex");
  assert.equal(checksumFor(`${hash}  update.dmg\n`, "update.dmg"), hash);
  assert.throws(() => checksumFor(`${hash}  other.dmg\n`, "update.dmg"), /唯一/);
  assert.throws(() => checksumFor(`${hash}  update.dmg\n${hash}  update.dmg`, "update.dmg"), /唯一/);
  const good = await downloadAsset(release.assets[0], path.join(root, "download"), { fetchImpl: async () => new Response("abc") });
  assert.equal(good, hash);
  assert.equal(await fs.readFile(path.join(root, "download"), "utf8"), "abc");
  await assert.rejects(downloadAsset(release.assets[0], path.join(root, "partial"), {
    fetchImpl: async () => new Response("ab")
  }), /不完整/);
  await assert.rejects(downloadAsset(release.assets[0], path.join(root, "large"), {
    fetchImpl: async () => new Response("abcd")
  }), /超過/);
  await assert.rejects(downloadAsset(release.assets[0], path.join(root, "redirect"), {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://example.com/update" } })
  }), /不受信任/);
  await assert.rejects(downloadAsset(release.assets[0], path.join(root, "offline"), {
    fetchImpl: async () => { throw new Error("offline"); }
  }), /offline/);
  const lockFile = path.join(root, "lock");
  await acquireUpdateLock(lockFile);
  await assert.rejects(acquireUpdateLock(lockFile), /另一個面板/);
  await fs.unlink(lockFile);
}

async function verifyInstall(root, failure) {
  const base = await fs.mkdtemp(path.join(root, "install-"));
  const target = path.join(base, "現有 App.app");
  const staged = path.join(base, "new.app");
  const backup = path.join(base, "previous.app");
  await fs.mkdir(target); await fs.mkdir(staged);
  await fs.writeFile(path.join(target, "version"), "old");
  await fs.writeFile(path.join(staged, "version"), "new");
  const data = path.join(base, "account.json");
  await fs.writeFile(data, "keep-account");
  let result;
  let launches = 0;
  const promise = installUpdate({ target, staged, backup, lockFile: path.join(base, "lock"), version: "1.2.2" }, {
    stopInstances: async () => { if (failure === "busy") throw new Error("busy"); },
    rename: async (from, to) => {
      if (failure === "rename" && from === staged) throw new Error("disk failure");
      return fs.rename(from, to);
    },
    launch: async () => { launches += 1; if (failure === "launch" && launches === 1) throw new Error("launch failure"); },
    report: async (value) => { result = value; }
  });
  if (failure) await assert.rejects(promise);
  else await promise;
  assert.equal(result.ok, !failure);
  assert.equal(await fs.readFile(path.join(target, "version"), "utf8"), failure ? "old" : "new");
  assert.equal(await fs.readFile(data, "utf8"), "keep-account");
  if (!failure) assert.equal(await fs.readFile(path.join(backup, "version"), "utf8"), "old");
}

async function verifyConsent() {
  const filename = path.resolve(__dirname, "../shared/main-core.js");
  const realRequire = createRequire(filename);
  const source = await fs.readFile(filename, "utf8");
  for (const response of [1, 0]) {
    let downloads = 0;
    let installs = 0;
    let quits = 0;
    let prompts = 0;
    class Window {
      constructor() { this.webContents = { on() {}, send() {} }; }
      loadFile() { return Promise.resolve(); }
      isDestroyed() { return false; }
      destroy() {}
    }
    const context = vm.createContext({
      module: { exports: {} }, process, console, setTimeout, clearTimeout,
      require(name) {
        if (name === "electron") return {
          app: { isPackaged: true, getVersion: () => "1.2.1", getName: () => "test", quit: () => { quits += 1; } },
          BrowserWindow: Window,
          dialog: { showMessageBox: async () => { prompts += 1; return { response }; } }
        };
        if (name === "./update-check") return { ...realRequire(name), fetchLatestRelease: async () => release };
        if (name === "./mac-updater") return {
          prepareUpdate: async () => { downloads += 1; return {}; },
          launchInstaller: async () => { installs += 1; }
        };
        return realRequire(name);
      }
    });
    vm.runInContext(source, context, { filename });
    vm.runInContext('config = { updater: { isDefault: true }, rendererHtmlPath: "/tmp/renderer.html" };', context);
    await vm.runInContext('runUpdateCheck({ notify: true })', context);
    assert.equal(prompts, 1);
    assert.equal(downloads, response === 0 ? 1 : 0, "未同意不可下載");
    assert.equal(installs, downloads);
    assert.equal(quits, downloads);
    await vm.runInContext('runUpdateCheck({ notify: true })', context);
    assert.equal(prompts, 1, "同一版本不重複彈窗");
    if (response === 1) {
      await vm.runInContext('runUpdateCheck({ notify: true, manual: true })', context);
      assert.equal(prompts, 2, "稍後仍可手動重試");
    }
  }
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quota-updater-test-"));
  try {
    await verifyAssetsAndDownload(root);
    for (const failure of [null, "busy", "rename", "launch"]) await verifyInstall(root, failure);
    await verifyConsent();
    console.log("Verified updater: consent, platform assets, download integrity, lock, install, rollback, and account preservation.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
