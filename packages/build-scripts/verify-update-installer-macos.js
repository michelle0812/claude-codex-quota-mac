"use strict";

// macOS 整合測試：複製 Electron 到暫存目錄，啟動兩個舊版程序，
// 真正執行 detached installer、替換 bundle，再由 LaunchServices 啟動新版。
// 不碰已安裝 App、真實帳號或設定。用法：node 此檔 /path/to/Electron.app
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

async function waitFor(check) {
  for (let i = 0; i < 120; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Integration test timed out");
}

(async () => {
  assert.equal(process.platform, "darwin");
  const electron = path.resolve(process.argv[2]);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quota-updater-smoke-")));
  let parent;
  let extra;
  let succeeded = false;
  try {
    const target = path.join(root, "測試 App.app");
    const stageDir = path.join(root, ".quota-update-test");
    await fs.mkdir(stageDir);
    const staged = path.join(stageDir, "new.app");
    await run("/usr/bin/ditto", [electron, target]);
    await run("/usr/bin/ditto", [electron, staged]);
    const bundleId = `test.quota.updater.${process.pid}`;
    const executableName = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", path.join(target, "Contents/Info.plist")])).stdout.trim();
    const executable = path.join(target, "Contents/MacOS", executableName);
    const marker = path.join(root, "restarted.json");
    const stopped = path.join(root, "extra-stopped");
    for (const bundle of [target, staged]) {
      await run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${bundleId}`, path.join(bundle, "Contents/Info.plist")]);
      const appDir = path.join(bundle, "Contents/Resources/app");
      await fs.mkdir(appDir, { recursive: true });
      await fs.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "quota-updater-test", version: "1.2.1", main: "main.js" }));
      await fs.writeFile(path.join(appDir, "main.js"), `const {app}=require("electron"); app.whenReady().then(()=>{require("fs").writeFileSync(${JSON.stringify(marker)},JSON.stringify({nodeMode:process.env.ELECTRON_RUN_AS_NODE||null,args:process.argv}));app.quit();});`);
      await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { timeout: 60000 });
    }
    const helperFile = path.join(stageDir, "installer.js");
    await fs.copyFile(path.resolve(__dirname, "../shared/update-installer.js"), helperFile);
    const manifestFile = path.join(stageDir, "install.json");
    const manifest = {
      target, staged, executable, version: "1.2.1", backup: path.join(stageDir, "previous.app"),
      lockFile: path.join(root, "lock"), readyFile: path.join(stageDir, "ready"),
      resultFile: path.join(root, "result.json"), launchArgs: [`--user-data-dir=${path.join(root, "data")}`]
    };
    await fs.writeFile(path.join(root, "account.json"), "untouched");
    const extraScript = path.join(root, "extra.js");
    await fs.writeFile(extraScript, `process.on("SIGTERM",()=>{require("fs").writeFileSync(${JSON.stringify(stopped)},"yes");process.exit(0);});setInterval(()=>{},1000);`);
    extra = spawn(executable, [extraScript], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" });
    const parentScript = path.join(root, "parent.js");
    await fs.writeFile(parentScript, `
const fs = require("fs");
const manifest = ${JSON.stringify(manifest)};
manifest.parentPid = process.pid;
fs.writeFileSync(${JSON.stringify(manifestFile)}, JSON.stringify(manifest));
fs.writeFileSync(manifest.lockFile, String(process.pid));
require(${JSON.stringify(path.resolve(__dirname, "../shared/mac-updater.js"))}).launchInstaller({
  manifest, manifestFile: ${JSON.stringify(manifestFile)}, helperFile: ${JSON.stringify(helperFile)}, stageDir: ${JSON.stringify(stageDir)}
}).then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
`);
    parent = spawn(executable, [parentScript], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
    await waitFor(async () => fs.access(manifest.resultFile).then(() => true, () => false));
    const result = JSON.parse(await fs.readFile(manifest.resultFile, "utf8"));
    assert.equal(result.ok, true, JSON.stringify(result));
    await waitFor(async () => fs.access(marker).then(() => true, () => false));
    const restarted = JSON.parse(await fs.readFile(marker, "utf8"));
    assert.equal(restarted.nodeMode, null, "重啟必須使用 GUI 模式");
    assert.ok(restarted.args.includes(manifest.launchArgs[0]));
    assert.equal(await fs.readFile(stopped, "utf8"), "yes", "額外面板必須結束");
    assert.equal(await fs.readFile(path.join(root, "account.json"), "utf8"), "untouched");
    await fs.access(manifest.backup);
    assert.equal(parent.exitCode, 0);
    succeeded = true;
    console.log("Verified macOS integration: detached Electron installer, all panels stopped, bundle replaced, GUI restarted, backup and account preserved.");
  } finally {
    if (parent && parent.exitCode === null) parent.kill();
    if (extra && extra.exitCode === null) extra.kill();
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
    else console.error(`Integration artifacts retained: ${root}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
