#!/usr/bin/env node
"use strict";

// 把 packages/shared/ 底下的共用模組複製到每個 app 的 src/shared-gen/。
//
// 為什麼要複製而不是用 npm workspaces 連結:
// electron-builder 的 files 解析對 workspace symlink 很容易出錯,
// 複製之後 electron-builder 看到的就只是 src/ 底下的一般檔案,打包零風險。
// src/shared-gen/ 已列入 .gitignore,唯一版本永遠是 packages/shared/。
//
// 用法: node scripts/sync-shared.js  (各 app 的 prebuild/prestart 會自動呼叫)

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const sharedDir = path.join(repoRoot, "packages", "shared");
const appsDir = path.join(repoRoot, "apps");

function fail(message) {
  console.error(`[sync-shared] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sharedDir)) {
  fail(`找不到共用模組目錄: ${sharedDir}`);
}

const sharedFiles = fs
  .readdirSync(sharedDir)
  .filter((name) => /\.(js|css|html)$/.test(name))
  .sort();

if (sharedFiles.length === 0) {
  fail(`${sharedDir} 裡沒有任何共用檔案（.js/.css/.html）`);
}

const apps = fs
  .readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (apps.length === 0) {
  fail(`${appsDir} 裡沒有任何 app`);
}

for (const app of apps) {
  const targetDir = path.join(appsDir, app, "src", "shared-gen");
  fs.mkdirSync(targetDir, { recursive: true });

  // 先清掉已經不存在於 packages/shared 的舊產物,避免留下孤兒模組。
  for (const stale of fs.readdirSync(targetDir)) {
    if (!sharedFiles.includes(stale)) {
      fs.rmSync(path.join(targetDir, stale), { recursive: true, force: true });
    }
  }

  for (const name of sharedFiles) {
    fs.copyFileSync(path.join(sharedDir, name), path.join(targetDir, name));
  }

  console.log(`[sync-shared] ${app}: ${sharedFiles.length} 個模組 -> src/shared-gen/`);
}
