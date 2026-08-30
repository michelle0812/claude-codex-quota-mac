#!/usr/bin/env node
"use strict";

// macOS 專用：把每個 app 的 node_modules/electron/dist/Electron.app 修到「開得起來」。
//
// 為什麼需要這支：
//  1. 某些 npm 設定（ignore-scripts / allowScripts）會讓 electron 的 postinstall 沒解壓，
//     只留一個空殼 dist/（沒有 Electron.app）。
//  2. 沒簽章的 Electron.app 在部分 Mac 上會被 Gatekeeper / XProtect 判成惡意軟體，
//     首次啟動直接 SIGKILL 甚至被丟進垃圾桶。
//
// 修法：缺 Electron.app 就跑 electron 自己的 install.js 補；接著清 quarantine 屬性，
//       驗簽，簽章壞了就 ad-hoc 重簽。全部 best-effort，失敗只警告不中斷。
//
// 用法：node scripts/heal-electron.js            （修所有 apps/*）
//       node scripts/heal-electron.js apps/claude （只修單一 app，路徑相對 repo 根）

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const appsDir = path.join(repoRoot, "apps");
const TAG = "[heal-electron]";

if (process.platform !== "darwin") {
  console.log(`${TAG} 非 macOS，略過。`);
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts });
}

function tryRun(cmd, args, opts) {
  try {
    run(cmd, args, opts);
    return true;
  } catch (error) {
    return { error };
  }
}

function targetApps() {
  const arg = process.argv[2];
  if (arg) return [path.resolve(repoRoot, arg)];
  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name));
}

function healOne(appDir) {
  const name = path.basename(appDir);
  const electronDir = path.join(appDir, "node_modules", "electron");
  if (!fs.existsSync(electronDir)) {
    console.log(`${TAG} ${name}: 沒裝 electron，略過（跑 npm install 後再試）。`);
    return;
  }

  const appBundle = path.join(electronDir, "dist", "Electron.app");

  if (!fs.existsSync(appBundle)) {
    console.log(`${TAG} ${name}: 缺 Electron.app，跑 electron/install.js 補…`);
    const res = tryRun(process.execPath, [path.join(electronDir, "install.js")], { cwd: electronDir });
    if (res !== true) {
      console.warn(`${TAG} ${name}: install.js 失敗：${res.error.message.split("\n")[0]}`);
      return;
    }
  }

  if (!fs.existsSync(appBundle)) {
    console.warn(`${TAG} ${name}: 補完還是找不到 Electron.app（可能被 Gatekeeper 移除），請手動 npm install electron。`);
    return;
  }

  // quarantine 屬性：有就清掉，沒有 xattr 會回非 0，不當錯。
  tryRun("xattr", ["-dr", "com.apple.quarantine", appBundle]);

  // 驗簽，壞了才 ad-hoc 重簽（重簽很慢，能省則省）。
  const verified = tryRun("codesign", ["--verify", "--deep", "--strict", appBundle]) === true;
  if (verified) {
    console.log(`${TAG} ${name}: OK（簽章有效、quarantine 已清）。`);
    return;
  }

  console.log(`${TAG} ${name}: 簽章無效，ad-hoc 重簽…`);
  const signed = tryRun("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
  if (signed === true) {
    console.log(`${TAG} ${name}: 重簽完成。`);
  } else {
    console.warn(`${TAG} ${name}: 重簽失敗：${signed.error.message.split("\n")[0]}`);
  }
}

for (const appDir of targetApps()) {
  try {
    healOne(appDir);
  } catch (error) {
    console.warn(`${TAG} ${path.basename(appDir)}: 非預期錯誤：${error.message.split("\n")[0]}`);
  }
}
