"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { isNewerVersion } = require("./update-check");

const DOWNLOAD_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);

function selectUpdateAssets(release, { assetPrefix, arch, repo }) {
  if (!/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error("更新版本格式不正確");
  const suffix = { arm64: "arm", x64: "intel" }[arch];
  if (!suffix) throw new Error("此處理器架構尚不支援自動更新");
  const name = `${assetPrefix}-${release.version}-macOS-${suffix}.dmg`;
  const find = (filename) => {
    const matches = (release.assets || []).filter((asset) => asset.name === filename);
    if (matches.length !== 1) throw new Error(`此版本缺少更新檔：${filename}，請至發行頁手動下載`);
    const asset = matches[0];
    const url = new URL(asset.url);
    const expectedPath = `/${repo}/releases/download/${encodeURIComponent(release.tag)}/${filename}`;
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath || url.username || url.password || url.port) {
      throw new Error("更新下載網址不屬於此專案的版本資產");
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024) throw new Error("更新檔大小不正確");
    return asset;
  };
  return { image: find(name), checksums: find("SHA256SUMS.txt") };
}

function checksumFor(text, filename) {
  const matches = text.split(/\r?\n/).map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
    .filter((match) => match && match[2] === filename);
  if (matches.length !== 1) throw new Error("校驗檔沒有此更新檔的唯一 SHA-256 紀錄");
  return matches[0][1].toLowerCase();
}

async function downloadAsset(asset, destination, { maxBytes = 512 * 1024 * 1024, onProgress = () => {}, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  let file;
  try {
    let url = new URL(asset.url);
    let response;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
        throw new Error("更新下載重新導向不受信任的網址");
      }
      response = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 5 || !response.headers.get("location")) throw new Error("更新下載重新導向過多");
        url = new URL(response.headers.get("location"), url);
        continue;
      }
      break;
    }
    if (!response.ok || !response.body) throw new Error(`更新下載失敗：HTTP ${response.status}`);
    file = await fs.open(destination, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let received = 0;
    let lastPercent = -1;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes || received > asset.size) throw new Error("下載檔案超過預期大小");
      await file.writeFile(chunk);
      hash.update(chunk);
      const percent = Math.floor(received * 100 / asset.size);
      if (percent !== lastPercent) { lastPercent = percent; onProgress(percent); }
    }
    if (received !== asset.size) throw new Error("更新檔下載不完整，舊版未變更");
    return hash.digest("hex");
  } finally {
    clearTimeout(timer);
    controller.abort();
    await file?.close();
  }
}

async function acquireUpdateLock(lockFile) {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await fs.readFile(lockFile, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("更新鎖定檔異常，請重新啟動 App 後再試");
      try { process.kill(pid, 0); } catch (failure) {
        if (failure.code === "ESRCH") { await fs.unlink(lockFile); continue; }
        throw failure;
      }
      throw new Error("另一個面板正在處理更新，請稍候");
    }
  }
  throw new Error("無法取得更新鎖定");
}

async function plistValue(bundle, key) {
  const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(bundle, "Contents/Info.plist")], { timeout: 10000 });
  return stdout.trim();
}

function supportsArchitecture(binary, arch) {
  if (binary.length < 8) return false;
  const cpu = { x64: 0x01000007, arm64: 0x0100000c }[arch];
  if (!cpu) return false;
  const magic = binary.readUInt32BE(0);
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) return binary.readUInt32LE(4) === cpu;
  if (magic === 0xfeedfacf || magic === 0xfeedface) return binary.readUInt32BE(4) === cpu;
  // Universal Mach-O：fat_arch 與 fat_arch_64 都以 cputype 開頭。
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) return false;
  const read = (offset) => little ? binary.readUInt32LE(offset) : binary.readUInt32BE(offset);
  const count = read(4);
  const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
  if (count > 64 || binary.length < 8 + count * stride) return false;
  for (let i = 0; i < count; i += 1) if (read(8 + i * stride) === cpu) return true;
  return false;
}

async function validateBundle(bundle, { bundleId, version, arch }) {
  if ((await fs.lstat(bundle)).isSymbolicLink()) throw new Error("更新 App 不可為符號連結");
  if (await plistValue(bundle, "CFBundleIdentifier") !== bundleId) throw new Error("更新 App 身分不符");
  if (await plistValue(bundle, "CFBundleShortVersionString") !== version) throw new Error("更新 App 版本不符");
  const executable = await plistValue(bundle, "CFBundleExecutable");
  if (!executable || executable.includes("/") || executable === "..") throw new Error("更新 App 執行檔無效");
  if (!supportsArchitecture(await fs.readFile(path.join(bundle, "Contents/MacOS", executable)), arch)) {
    throw new Error("更新 App 的處理器架構不符");
  }
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { timeout: 60000 });
}

async function prepareUpdate({ release, currentVersion, executable, options, repo, arch, onProgress = () => {} }) {
  if (process.platform !== "darwin") throw new Error("自動安裝僅支援 macOS");
  if (!isNewerVersion(release.version, currentVersion)) throw new Error("此版本不是較新的版本");
  const target = await fs.realpath(path.resolve(path.dirname(executable), "../.."));
  if (!target.endsWith(".app") || target.startsWith("/Volumes/") || target.includes("/AppTranslocation/")) {
    throw new Error("請先把 App 移到 Applications 或可寫入的資料夾，再執行更新");
  }
  if (await plistValue(target, "CFBundleIdentifier") !== options.bundleId) throw new Error("目前 App 身分不符，無法自動替換");
  const assets = selectUpdateAssets(release, { ...options, arch, repo });
  const lockFile = path.join(options.dataDir, "update-install.lock");
  await acquireUpdateLock(lockFile);
  let stageDir;
  let mounted = false;
  let mount;
  try {
    try { stageDir = await fs.mkdtemp(path.join(path.dirname(target), ".quota-update-")); }
    catch { throw new Error("App 所在資料夾無法寫入，請移至你有寫入權限的位置後重試"); }
    await fs.chmod(stageDir, 0o700);
    const sums = path.join(stageDir, "SHA256SUMS.txt");
    const dmg = path.join(stageDir, "update.dmg");
    onProgress("正在下載校驗檔…");
    await downloadAsset(assets.checksums, sums, { maxBytes: 1024 * 1024 });
    const expected = checksumFor(await fs.readFile(sums, "utf8"), assets.image.name);
    const actual = await downloadAsset(assets.image, dmg, { onProgress: (percent) => onProgress(`正在下載更新：${percent}%`) });
    if (expected !== actual) throw new Error("更新檔 SHA-256 校驗失敗，舊版未變更");
    onProgress("正在驗證並準備安裝…");
    mount = path.join(stageDir, "volume");
    await fs.mkdir(mount);
    await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg], { timeout: 60000 });
    mounted = true;
    const source = path.join(mount, `${options.productName}.app`);
    await validateBundle(source, { ...options, version: release.version, arch });
    const staged = path.join(stageDir, "new.app");
    await run("/usr/bin/ditto", [source, staged], { timeout: 120000 });
    await validateBundle(staged, { ...options, version: release.version, arch });
    await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 });
    mounted = false;
    await fs.unlink(dmg);
    const manifest = {
      target, staged, executable: await fs.realpath(executable), parentPid: process.pid,
      version: release.version, backup: path.join(stageDir, "previous.app"), lockFile,
      launchArgs: [`--user-data-dir=${options.dataDir}`],
      readyFile: path.join(stageDir, "ready"), resultFile: path.join(options.dataDir, "update-result.json")
    };
    const manifestFile = path.join(stageDir, "install.json");
    const helperFile = path.join(stageDir, "installer.js");
    await fs.writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    await fs.copyFile(path.join(__dirname, "update-installer.js"), helperFile);
    return { manifest, manifestFile, helperFile, stageDir };
  } catch (error) {
    if (mounted) {
      await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 }).then(() => { mounted = false; }).catch(() => {});
    }
    // 卸載失敗時不遞迴刪除掛載點。
    if (stageDir && !mounted) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
    throw error;
  }
}

async function launchInstaller(prepared) {
  const log = await fs.open(path.join(prepared.stageDir, "install.log"), "a", 0o600);
  let child;
  let startupError;
  try {
    child = spawn(process.execPath, [prepared.helperFile, prepared.manifestFile], {
      detached: true,
      cwd: prepared.stageDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", log.fd, log.fd]
    });
    child.on("error", (error) => { startupError = error; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (startupError || child.exitCode !== null) throw startupError || new Error("更新安裝程序無法啟動");
      if (await fs.readFile(prepared.manifest.readyFile, "utf8").catch(() => "") === "ready") {
        child.unref();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("更新安裝程序啟動逾時");
  } catch (error) {
    child?.kill();
    await fs.unlink(prepared.manifest.lockFile).catch(() => {});
    throw error;
  } finally {
    await log.close();
  }
}

module.exports = { selectUpdateAssets, checksumFor, downloadAsset, acquireUpdateLock, supportsArchitecture, validateBundle, prepareUpdate, launchInstaller };
