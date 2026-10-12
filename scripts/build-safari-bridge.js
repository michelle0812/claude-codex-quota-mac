"use strict";
// Build a review artifact only; does not install or change Safari permissions.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-quota-safari-"));
  const name = "Codex Quota Browser Bridge";
  const bundle = "cn.codex.quota.browserbridge";
  execFileSync("/usr/bin/xcrun", ["safari-web-extension-converter", path.join(root, "browser-extension/chromium"),
    "--project-location", temp, "--app-name", name, "--bundle-identifier", bundle, "--macos-only", "--swift", "--copy-resources", "--no-open", "--no-prompt"], { stdio: "inherit" });
  const project = path.join(temp, name, `${name}.xcodeproj`);
  const pbx = path.join(project, "project.pbxproj");
  // Xcode 27's converter emitted a different host bundle ID; keep extension prefixed by its host.
  const text = await fs.readFile(pbx, "utf8");
  const fixed = text.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, (match) =>
    `PRODUCT_BUNDLE_IDENTIFIER = ${match.includes(".Extension") ? bundle + ".Extension" : bundle};`);
  await fs.writeFile(pbx, fixed);
  const derived = path.join(temp, "build");
  execFileSync("/usr/bin/xcodebuild", ["-quiet", "-project", project, "-scheme", name, "-configuration", "Release", "-derivedDataPath", derived,
    "-arch", "arm64", "-arch", "x86_64", "ONLY_ACTIVE_ARCH=NO", "MACOSX_DEPLOYMENT_TARGET=13.0",
    "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGNING_REQUIRED=NO", "DEVELOPMENT_TEAM=", "build"], { stdio: "inherit" });
  const target = path.join(root, "browser-extension/safari", `${name}.app`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(path.join(derived, "Build/Products/Release", `${name}.app`), target, { recursive: true });
  console.log(`Built ad-hoc Safari preview: ${target}. Not installed; Safari enablement/signing still requires review.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
