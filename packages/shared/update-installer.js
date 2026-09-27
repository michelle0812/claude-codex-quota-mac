"use strict";

// 下載與驗證完成後，複製到 App 外執行。只替換 bundle，不碰帳號或設定。
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function matchingProcesses(executable) {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,comm="], { timeout: 10000 });
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2] === executable && Number(match[1]) !== process.pid ? [Number(match[1])] : [];
  });
}

async function stopInstances(manifest) {
  // 主程序收到 ready 後會自行退出；不替它強制結束尚未完成的工作。
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pids = await matchingProcesses(manifest.executable);
    if (!pids.includes(manifest.parentPid)) break;
    if (attempt === 59) throw new Error("App 未能結束，已取消更新；舊版未變更。");
    await delay(500);
  }
  for (const pid of await matchingProcesses(manifest.executable)) {
    // 發送前再核對執行檔，不以 App 名稱或模糊字串終止其他程式。
    if ((await matchingProcesses(manifest.executable)).includes(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await matchingProcesses(manifest.executable)).length === 0) return;
    await delay(500);
  }
  throw new Error("其他面板尚未結束，已取消更新；舊版未變更。");
}

async function installUpdate(manifest, dependencies = {}) {
  const rename = dependencies.rename || fs.rename;
  const stop = dependencies.stopInstances || stopInstances;
  const launch = dependencies.launch || ((target) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return run("/usr/bin/open", ["-n", target, "--args", ...(manifest.launchArgs || [])], { timeout: 15000, env });
  });
  const report = dependencies.report || (async (result) => {
    await fs.writeFile(manifest.resultFile, JSON.stringify({ ...result, backup: manifest.backup }), { mode: 0o600 });
  });
  let backedUp = false;
  let installed = false;
  try {
    await stop(manifest);
    await rename(manifest.target, manifest.backup);
    backedUp = true;
    await rename(manifest.staged, manifest.target);
    installed = true;
    await launch(manifest.target);
    // 記錄失敗不應把已成功啟動的新版換回去。
    await report({ ok: true, version: manifest.version }).catch(() => {});
  } catch (error) {
    let recoveryError = null;
    try {
      if (installed) await rename(manifest.target, manifest.staged);
      if (backedUp) await rename(manifest.backup, manifest.target);
    } catch (failure) {
      recoveryError = failure;
    }
    await report({ ok: false, error: `${error.message}${recoveryError ? `；還原失敗：${recoveryError.message}` : ""}` });
    if (!recoveryError) await launch(manifest.target).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(manifest.lockFile).catch(() => {});
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  // manifest 只由主程序建立；仍要求 staged / backup 與 target 在同一個父目錄下。
  const parent = path.dirname(manifest.target);
  if (path.dirname(path.dirname(manifest.staged)) !== parent ||
      path.dirname(manifest.backup) !== path.dirname(manifest.staged) ||
      !manifest.target.endsWith(".app")) throw new Error("無效的更新路徑");
  await fs.writeFile(manifest.lockFile, String(process.pid), { mode: 0o600 });
  await fs.writeFile(manifest.readyFile, "ready", { mode: 0o600 });
  await installUpdate(manifest);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { installUpdate, matchingProcesses };
