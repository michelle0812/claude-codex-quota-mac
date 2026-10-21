"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { selectUpdateAssets, checksumFor, downloadAsset, acquireUpdateLock, supportsArchitecture, prepareUpdate, translocationError } = require("../shared/mac-updater");
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

// 從瀏覽器下載的 App 被 macOS 搬到 AppTranslocation 執行：要回專屬錯誤與可複製的 xattr 指令。
async function verifyTranslocation(root) {
  const bundle = path.join(root, "AppTranslocation", "C072EDE1", "d", "Claude 額度.app");
  await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  const executable = path.join(bundle, "Contents", "MacOS", "Claude 額度");
  await fs.writeFile(executable, "");
  await assert.rejects(
    prepareUpdate({ release, currentVersion: "1.2.1", executable, options: { ...options, dataDir: root }, repo, arch: "arm64", applicationRoots: [path.join(root, "absent-Applications")] }),
    (error) => error.code === "APP_TRANSLOCATED"
      && error.command === 'xattr -dr com.apple.quarantine "/Applications/Claude 額度.app"'
      && error.message.includes(error.command)
  );
}

// 只讓檔案系統操作落在暫存目錄；下載、掛載、簽章與 xattr 都用可觀察的替身。
async function verifyTranslocationRecovery(root) {
  const filename = path.resolve(__dirname, "../shared/mac-updater.js");
  const source = await fs.readFile(filename, "utf8");
  const realRequire = createRequire(filename);
  for (const scenario of ["system", "home", "priority", "skip-invalid", "id", "version", "symlink", "missing", "file", "suffix", "plist", "xattr"]) {
    const base = await fs.mkdtemp(path.join(root, "recovery-"));
    const name = scenario === "suffix" ? "測試 額度.bundle" : "測試 額度.app";
    const bundle = path.join(base, "AppTranslocation", "UUID", "d", name);
    const executable = path.join(bundle, "Contents/MacOS/Test");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "running");
    const roots = [path.join(base, "Applications"), path.join(base, "home/Applications")];
    const candidates = roots.map((dir) => path.join(dir, name));
    const id = "test.quota.widget";
    const plists = new Map();
    async function makeBundle(location, version = "1.2.1", bundleId = id) {
      await fs.mkdir(path.join(location, "Contents/MacOS"), { recursive: true });
      const binary = Buffer.alloc(8);
      binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4);
      await fs.writeFile(path.join(location, "Contents/MacOS/Test"), binary);
      plists.set(location, { CFBundleIdentifier: bundleId, CFBundleShortVersionString: version, CFBundleExecutable: "Test" });
    }
    if (scenario === "missing") plists.set(candidates[0], { CFBundleIdentifier: id, CFBundleShortVersionString: "1.2.1" });
    if (scenario !== "missing") {
      const candidate = candidates[scenario === "home" ? 1 : 0];
      if (scenario === "file") {
        await fs.mkdir(path.dirname(candidate), { recursive: true });
        await fs.writeFile(candidate, "not a bundle");
        plists.set(candidate, { CFBundleIdentifier: id, CFBundleShortVersionString: "1.2.1" });
      } else if (scenario === "symlink") {
        const linked = path.join(base, "linked.app");
        await makeBundle(linked);
        await fs.mkdir(path.dirname(candidate), { recursive: true });
        await fs.symlink(linked, candidate);
        plists.set(candidate, plists.get(linked));
      } else {
        await makeBundle(candidate, scenario === "version" ? "0.0.1" : "1.2.1", ["id", "skip-invalid"].includes(scenario) ? "other.id" : id);
        if (scenario === "plist") plists.delete(candidate);
      }
    }
    if (["priority", "skip-invalid"].includes(scenario)) await makeBundle(candidates[1]);
    const xattrs = [];
    const hash = crypto.createHash("sha256").update("abc").digest("hex");
    const sums = `${hash}  CodexQuota-1.2.2-macOS-arm.dmg\n`;
    const testRelease = structuredClone(release);
    testRelease.assets.find((a) => a.name === "SHA256SUMS.txt").size = Buffer.byteLength(sums);
    let downloads = 0;
    const fakeRun = async (command, args) => {
      if (command === "/usr/libexec/PlistBuddy") {
        const location = path.dirname(path.dirname(args[2]));
        const key = args[1].replace("Print :", "");
        const value = plists.get(location)?.[key];
        if (value === undefined) throw new Error("invalid plist");
        return { stdout: value + "\n" };
      }
      if (command === "/usr/bin/xattr") {
        xattrs.push([...args]);
        if (scenario === "xattr") throw new Error("permission denied: test xattr");
      } else if (command === "/usr/bin/hdiutil") {
        if (args[0] === "attach") await makeBundle(path.join(args[4], "Test.app"), "1.2.2");
      } else if (command === "/usr/bin/ditto") {
        await fs.cp(args[0], args[1], { recursive: true });
        plists.set(args[1], plists.get(args[0]));
      } else if (command !== "/usr/bin/codesign") throw new Error(`unexpected command: ${command}`);
      return { stdout: "" };
    };
    const context = vm.createContext({
      module: { exports: {} }, process, console, __dirname: path.dirname(filename),
      setTimeout, clearTimeout, AbortController, URL,
      fetch: async (url) => {
        assert.equal(xattrs.length, 1, "下載前應已解除隔離");
        downloads += 1;
        return new Response(String(url).endsWith("SHA256SUMS.txt") ? sums : "abc");
      },
      require: (name) => name === "node:util" ? { promisify: () => fakeRun } : realRequire(name)
    });
    vm.runInContext(source, context, { filename });
    const promise = context.module.exports.prepareUpdate({
      release: testRelease, currentVersion: "1.2.1", executable,
      options: { ...options, bundleId: id, productName: "Test", dataDir: path.join(base, "data") },
      repo, arch: "arm64", applicationRoots: roots
    });
    if (["system", "home", "priority", "skip-invalid"].includes(scenario)) {
      const prepared = await promise;
      const target = candidates[["home", "skip-invalid"].includes(scenario) ? 1 : 0];
      assert.deepEqual(xattrs, [["-dr", "com.apple.quarantine", target]], scenario);
      assert.equal(downloads, 2);
      assert.equal(prepared.manifest.target, target);
      assert.equal(prepared.manifest.executable, await fs.realpath(executable));
      assert.equal(path.dirname(prepared.stageDir), path.dirname(target));
      assert.equal(path.dirname(path.dirname(prepared.manifest.staged)), path.dirname(target));
      assert.equal(path.dirname(prepared.manifest.backup), path.dirname(prepared.manifest.staged));
      assert.deepEqual(JSON.parse(await fs.readFile(prepared.manifestFile, "utf8")), JSON.parse(JSON.stringify(prepared.manifest)));
    } else {
      await assert.rejects(promise, (error) => error.code === "APP_TRANSLOCATED"
        && error.message.includes(error.command)
        && (scenario !== "xattr" || error.message.includes("permission denied: test xattr")), scenario);
      assert.equal(xattrs.length, scenario === "xattr" ? 1 : 0, scenario);
      assert.equal(downloads, 0, scenario);
    }
    console.log(`Verified translocation recovery: ${scenario}`);
  }
}

async function verifyTranslocationDialog() {
  const filename = path.resolve(__dirname, "../shared/main-core.js");
  const realRequire = createRequire(filename);
  const source = await fs.readFile(filename, "utf8");
  const error = translocationError("/private/var/folders/x/T/AppTranslocation/A/d/Codex 額度.app");
  const prompts = [];
  let copied = null;
  let opened = 0;
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
        app: { isPackaged: true, getVersion: () => "1.2.1", getName: () => "test", quit() {} },
        BrowserWindow: Window,
        shell: { openExternal: async () => { opened += 1; } },
        clipboard: { writeText: (text) => { copied = text; } },
        dialog: { showMessageBox: async (box) => { prompts.push(box); return { response: 0 }; } }
      };
      if (name === "./update-check") return { ...realRequire(name), fetchLatestRelease: async () => release };
      if (name === "./mac-updater") return {
        prepareUpdate: async () => { throw error; },
        launchInstaller: async () => { throw new Error("不應啟動安裝"); }
      };
      return realRequire(name);
    }
  });
  vm.runInContext(source, context, { filename });
  vm.runInContext('config = { updater: { isDefault: true }, rendererHtmlPath: "/tmp/renderer.html" };', context);
  await vm.runInContext('runUpdateCheck({ notify: true })', context);
  assert.equal(prompts.length, 2);
  assert.deepEqual([...prompts[1].buttons], ["複製指令", "好"]);
  assert.match(prompts[1].detail, /xattr -dr com\.apple\.quarantine "\/Applications\/Codex 額度\.app"/);
  assert.equal(copied, error.command);
  assert.equal(opened, 0, "隔離情況不該導去發行頁");
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quota-updater-test-"));
  try {
    await verifyAssetsAndDownload(root);
    for (const failure of [null, "busy", "rename", "launch"]) await verifyInstall(root, failure);
    await verifyConsent();
    await verifyTranslocation(root);
    await verifyTranslocationRecovery(root);
    await verifyTranslocationDialog();
    console.log("Verified updater: consent, translocation guidance, platform assets, download integrity, lock, install, rollback, and account preservation.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
