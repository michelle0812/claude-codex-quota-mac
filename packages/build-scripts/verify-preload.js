// preload 只能 require("electron")。
//
// 為什麼要特別測：Electron 的 preload 跑在 sandbox 裡，require() 只支援 electron
// 與少數內建模組。載入自己寫的相對路徑檔案（例如 require("../shared-gen/xxx")）
// 會讓整份 preload 不執行，而且不會讓 App 崩潰 —— 畫面照樣畫得出來，但
// window.quotaBridge 是 undefined，renderer 一開就 throw，拖拉／縮放／所有按鈕
// 全部沒反應。純靠靜態檢查或單元測試抓不到，只有真的開 App 才會現形。
// 2026-08-29 就是這樣中招的，所以立一支測試守住。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED = new Set(["electron"]);
const preloadPath = path.resolve(__dirname, "..", "shared", "preload.js");
const source = fs.readFileSync(preloadPath, "utf8");

const required = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
assert.ok(required.length > 0, "preload.js 應該至少 require electron");

const illegal = required.filter((name) => !ALLOWED.has(name));
assert.deepEqual(
  illegal,
  [],
  `preload.js 只能 require ${[...ALLOWED].join(" / ")}，但它 require 了：${illegal.join(", ")}\n` +
    "（sandbox 下這會讓整份 preload 靜靜地不執行，App 開得起來但完全不能互動）"
);

// 兩個 app 的 main.js 都必須把 preload 指到這一份共用檔，不可以各自再包一層。
const appsDir = path.resolve(__dirname, "..", "..", "apps");
for (const app of fs.readdirSync(appsDir).filter((n) => fs.statSync(path.join(appsDir, n)).isDirectory())) {
  const mainFile = path.join(appsDir, app, "src", "main", "main.js");
  const mainSource = fs.readFileSync(mainFile, "utf8");
  assert.match(
    mainSource,
    /preloadPath:\s*path\.join\(__dirname,\s*"\.\.\/shared-gen\/preload\.js"\)/,
    `${app}: main.js 的 preloadPath 必須指向 ../shared-gen/preload.js`
  );
  assert.ok(
    !fs.existsSync(path.join(appsDir, app, "src", "main", "preload.js")),
    `${app}: src/main/preload.js 不該存在，preload 只有共用那一份`
  );
}

console.log(`Verified preload is self-contained (requires only ${[...ALLOWED].join(", ")}) and wired from every app.`);
