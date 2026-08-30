#!/usr/bin/env node
"use strict";

// 打包一次發佈用的全部檔案，集中到 repo 根的 dist-release/。
//
// 產出：
//   ClaudeQuota-<版本>-macOS-arm.dmg      / -intel.dmg
//   CodexQuota-<版本>-macOS-arm.dmg       / -intel.dmg
//   合併下載版.arm.zip    （Claude 額度.app + Codex 額度.app，Apple Silicon）
//   合併下載版.intel.zip  （同上，Intel）
//
// dmg 由各 app 的 electron-builder 產出、afterAllArtifactBuild 事後把 arm64->arm、
// x64->intel 改名。這支只負責跑 build、組合併 zip、把東西收進 dist-release/。
//
// 用法：npm run build-release          （會先 npm run build:all，約數分鐘）
//       npm run build-release -- --skip-build   （dist/ 已經有東西時只做組裝）

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(repoRoot, "dist-release");
const TAG = "[build-release]";

const APPS = [
  { dir: "apps/claude", product: "Claude 額度" },
  { dir: "apps/codex", product: "Codex 額度" }
];

// electron-builder 的 mac 輸出目錄：arm64 在 mac-arm64/，x64 在 mac/。
const ARCHES = [
  { key: "arm", outDir: "mac-arm64", zip: "合併下載版.arm.zip" },
  { key: "intel", outDir: "mac", zip: "合併下載版.intel.zip" }
];

function sh(cmd, args, opts = {}) {
  console.log(`${TAG} $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
}

function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  for (const app of APPS) {
    const appPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, app.dir, "package.json"), "utf8"));
    if (appPkg.version !== pkg.version) {
      throw new Error(`版本不一致：根 ${pkg.version} vs ${app.dir} ${appPkg.version}`);
    }
  }
  return pkg.version;
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");
  const v = version();
  console.log(`${TAG} 版本 ${v}${skipBuild ? "（--skip-build）" : ""}`);

  if (!skipBuild) {
    sh("npm", ["run", "build:all"]);
  }

  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  // 1. 收 dmg
  const dmgs = [];
  for (const app of APPS) {
    const distDir = path.join(repoRoot, app.dir, "dist");
    for (const name of fs.readdirSync(distDir)) {
      if (name.endsWith(".dmg")) {
        fs.copyFileSync(path.join(distDir, name), path.join(releaseDir, name));
        dmgs.push(name);
      }
    }
  }
  if (dmgs.length !== 4) {
    throw new Error(`預期 4 個 dmg，實際 ${dmgs.length}：${dmgs.join(", ")}`);
  }

  // 2. 合併 zip：每個架構把兩個 app 的 .app 複製進暫存夾，再 ditto 壓成一包
  for (const arch of ARCHES) {
    const stage = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `merge-${arch.key}-`));
    for (const app of APPS) {
      const appBundle = path.join(repoRoot, app.dir, "dist", arch.outDir, `${app.product}.app`);
      if (!fs.existsSync(appBundle)) {
        throw new Error(`找不到 ${appBundle}`);
      }
      // ditto 保留簽章與 xattr
      sh("ditto", [appBundle, path.join(stage, `${app.product}.app`)]);
    }
    // 不帶 --keepParent：壓縮檔內就是兩個 .app 平放在最上層。
    // 不用 --sequesterRsrc：那會生出一堆 __MACOSX/._ 檔；不帶它時 ditto 會把
    // xattr（含程式簽章）存進 zip 的 extra field，macOS 解壓後簽章仍完整。
    const zipPath = path.join(releaseDir, arch.zip);
    sh("ditto", ["-c", "-k", stage, zipPath]);
    fs.rmSync(stage, { recursive: true, force: true });
  }

  console.log(`\n${TAG} 完成，dist-release/ 內容：`);
  for (const name of fs.readdirSync(releaseDir).sort()) {
    const size = (fs.statSync(path.join(releaseDir, name)).size / 1e6).toFixed(1);
    console.log(`  ${name}  (${size} MB)`);
  }
  console.log(`\n${TAG} 發佈：`);
  console.log(`  gh release create v${v} dist-release/* --title "v${v}" --notes "..."`);
}

main();
