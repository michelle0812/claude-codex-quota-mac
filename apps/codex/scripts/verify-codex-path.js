const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCodexSpawnEnv, resolveCodexPath } = require("../src/main/quota-service");

function makeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 });
}

function withTempHome(callback) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-"));
  try {
    callback(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function verifyExplicitOverride() {
  const configuredPath = "/custom/codex";
  assert.equal(resolveCodexPath({ env: { CODEX_CLI_PATH: configuredPath, PATH: "" } }), configuredPath);
}

function verifyExistingPath() {
  withTempHome((homeDir) => {
    const binDir = path.join(homeDir, "bin");
    const codexPath = path.join(binDir, "codex");
    makeExecutable(codexPath);

    assert.equal(resolveCodexPath({ env: { PATH: binDir }, homeDir }), codexPath);
  });
}

function verifyNvmDiscoveryAndNodePath() {
  withTempHome((homeDir) => {
    const olderCodex = path.join(homeDir, ".nvm", "versions", "node", "v20.9.0", "bin", "codex");
    const latestCodex = path.join(homeDir, ".nvm", "versions", "node", "v24.15.0", "bin", "codex");
    makeExecutable(olderCodex);
    makeExecutable(latestCodex);

    const resolvedPath = resolveCodexPath({ env: { PATH: "/usr/bin:/bin" }, homeDir });
    assert.equal(resolvedPath, latestCodex);

    const childEnv = buildCodexSpawnEnv(resolvedPath, { PATH: "/usr/bin:/bin", TEST_VALUE: "preserved" });
    assert.equal(childEnv.PATH.split(path.delimiter)[0], path.dirname(latestCodex));
    assert.equal(childEnv.TEST_VALUE, "preserved");
  });
}

function verifyFallback() {
  withTempHome((homeDir) => {
    assert.equal(resolveCodexPath({ env: { PATH: "" }, homeDir }), "codex");
  });
}

verifyExplicitOverride();
verifyExistingPath();
verifyNvmDiscoveryAndNodePath();
verifyFallback();

console.log("Verified Codex CLI override, PATH lookup, NVM discovery, Node PATH propagation, and fallback behavior.");
