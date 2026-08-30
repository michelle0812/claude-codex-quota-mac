"use strict";

// electron-builder 打完所有 artifact 後呼叫一次。
// 把 dmg 檔名裡的架構標籤換成人看得懂的：arm64 -> arm、x64 -> intel。
// （electron-builder 的 ${arch} 巨集只能給 arm64 / x64，沒有別名，只能事後改名。）

const fs = require("node:fs");

const RENAMES = [
  ["-arm64.dmg", "-arm.dmg"],
  ["-x64.dmg", "-intel.dmg"]
];

module.exports = async function afterAllArtifactBuild(buildResult) {
  const out = [];
  for (const filePath of buildResult.artifactPaths) {
    const rule = RENAMES.find(([from]) => filePath.endsWith(from));
    if (!rule) {
      out.push(filePath);
      continue;
    }
    const next = filePath.slice(0, -rule[0].length) + rule[1];
    fs.renameSync(filePath, next);
    // blockmap 跟著改
    if (fs.existsSync(`${filePath}.blockmap`)) {
      fs.renameSync(`${filePath}.blockmap`, `${next}.blockmap`);
    }
    console.log(`[after-all-artifact-build] ${filePath.split("/").pop()} -> ${next.split("/").pop()}`);
    out.push(next);
  }
  return out;
};
