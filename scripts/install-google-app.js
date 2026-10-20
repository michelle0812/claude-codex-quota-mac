#!/usr/bin/env node
"use strict";

// Historical name retained for compatibility. Build and verify a new bundle
// in an isolated staging directory; never modify an installed application.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validateBundle } = require("../packages/shared/mac-updater");

async function stageGoogleApp({ repoRoot = path.resolve(__dirname, ".."), arch = process.arch,
  run = execFileSync, validate = validateBundle } = {}) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("不支援的建置架構");
  const appDir = path.join(repoRoot, "apps/google");
  const pkg = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));
  const outputRoot = path.join(appDir, "dist");
  await fs.mkdir(outputRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(outputRoot, "verified-build-"));
  run(process.execPath, [path.join(repoRoot, "scripts/sync-shared.js")], { cwd: repoRoot, stdio: "inherit" });
  run(process.execPath, [path.join(appDir, "node_modules/electron-builder/out/cli/cli.js"),
    "--mac", "--dir", `--${arch}`, `--config.directories.output=${stage}`], {
    cwd: appDir, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
  });
  const bundle = path.join(stage, arch === "arm64" ? "mac-arm64" : "mac", `${pkg.build.productName}.app`);
  await validate(bundle, { bundleId: pkg.build.appId, version: pkg.version, arch });
  return bundle;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--stage-only")) {
    console.error("此腳本只支援建置驗證（--stage-only）；不會安裝或替換 /Applications 的 App。");
    process.exitCode = 1;
  } else {
    stageGoogleApp().then((bundle) => console.log(`已建置並驗證：${bundle}\n現有 App 未變更。`))
      .catch((error) => { console.error(`建置驗證失敗，現有 App 未變更：${error.message}`); process.exitCode = 1; });
  }
}
module.exports = { stageGoogleApp };
