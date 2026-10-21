const { execFileSync } = require("node:child_process");
const path = require("node:path");

const DEFAULT_IDENTITY = "Quota Widgets Code Signing";

// Only valid code-signing identities, with an exact CN or full SHA-1 match.
// Never let codesign's substring lookup select an unrelated Apple identity.
function resolveIdentity({ env = process.env, run = execFileSync, required = false, warn = console.warn } = {}) {
  const requested = env.QUOTA_SIGN_IDENTITY || DEFAULT_IDENTITY;
  let identities = [];
  try {
    const output = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    identities = [...output.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/gm)]
      .map((match) => ({ sha1: match[1].toUpperCase(), name: match[2] }));
  } catch (error) {
    if (required) throw new Error(`無法查詢程式碼簽章身分：${error.message}`);
  }
  const matches = identities.filter(({ sha1, name }) => name === requested || sha1 === requested.toUpperCase());
  if (matches.length > 1) throw new Error(`簽章身分不唯一：${requested}；請用 QUOTA_SIGN_IDENTITY 指定 SHA-1`);
  if (matches.length === 1) return matches[0].sha1;
  const message = `找不到有效簽章身分「${requested}」。請先執行 scripts/create-signing-identity.sh`;
  if (required) throw new Error(message);
  warn(`\n⚠️  WARNING: ${message}\n⚠️  本次退回 ad-hoc 簽章；更新後可能再次要求鑰匙圈密碼，禁止發布。\n`);
  return "-";
}

function verifyBundle(appPath, identity, { run = execFileSync, log = console.log } = {}) {
  const args = ["--verify", "--deep", "--strict"];
  if (identity !== "-") args.push("-R", `=certificate leaf = H"${identity}"`);
  run("/usr/bin/codesign", [...args, appPath], { stdio: "inherit" });
  // The DR is on stdout; codesign writes the executable diagnostic to stderr.
  const output = run("/usr/bin/codesign", ["-d", "-r-", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const dr = String(output);
  log(dr.trim());
  if (identity !== "-" && (!/(?:certificate (?:leaf|root|\d+) =|anchor) H"[a-f0-9]{40}"/i.test(dr) || /\bcdhash\b/i.test(dr))) {
    throw new Error(`簽章 DR 未綁定固定憑證：${appPath}`);
  }
}

async function afterPack(context, deps = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const env = deps.env || process.env;
  const run = deps.run || execFileSync;
  const identity = resolveIdentity({ ...deps, env, run, required: env.QUOTA_REQUIRE_SIGNING === "1" });
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, "--timestamp=none", appPath], { stdio: "inherit" });
  verifyBundle(appPath, identity, { ...deps, run });
}

module.exports = afterPack;
module.exports.resolveIdentity = resolveIdentity;
module.exports.verifyBundle = verifyBundle;
