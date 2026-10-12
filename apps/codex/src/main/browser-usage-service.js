"use strict";

// External browsers retain their credentials. Only quota snapshots cross loopback.
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { normalizeSnapshot, prettyPlan, whamWindow } = require("./quota-service");
const run = promisify(execFile);
const BROWSERS = Object.freeze([
  { id: "safari", name: "Safari", bundleId: "com.apple.Safari", appPath: "/Applications/Safari.app" },
  { id: "chrome", name: "Chrome", bundleId: "com.google.Chrome", appPath: "/Applications/Google Chrome.app" },
  { id: "firefox", name: "Firefox", bundleId: "org.mozilla.firefox", appPath: "/Applications/Firefox.app" },
  { id: "zen", name: "Zen", bundleId: "app.zen-browser.zen", appPath: "/Applications/Zen.app" }
]);
const MAX_AGE_MS = 10 * 60 * 1000;

function validateOptions(value) {
  if (!value || !["codex", "browser"].includes(value.source)) throw new Error("請選擇有效的用量來源");
  if (!BROWSERS.some((b) => b.id === value.browser)) throw new Error("請選擇 Safari、Chrome、Firefox 或 Zen");
  return { source: value.source, browser: value.browser };
}

function sanitizeSnapshot(value) {
  if (!value || typeof value.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || value.email.length > 254) {
    throw new Error("瀏覽器沒有提供有效的帳號電子郵件");
  }
  if (typeof value.accountId !== "string" || !value.accountId || value.accountId.length > 256) throw new Error("瀏覽器沒有提供帳號識別碼");
  const window = (w) => {
    if (w == null) return null;
    if (typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100 ||
        !Number.isFinite(w.limit_window_seconds) || w.limit_window_seconds <= 0 || w.limit_window_seconds > 366 * 86400 ||
        !Number.isFinite(w.reset_at) || w.reset_at <= 0 || w.reset_at > 8640000000000) {
      throw new Error("瀏覽器用量資料格式不正確");
    }
    return { used_percent: w.used_percent, limit_window_seconds: w.limit_window_seconds, reset_at: w.reset_at };
  };
  const primary = window(value.rateLimit?.primary_window);
  const secondary = window(value.rateLimit?.secondary_window);
  if (!primary && !secondary) throw new Error("瀏覽器回應沒有可用的用量視窗");
  return {
    email: value.email.trim().toLowerCase(), accountId: value.accountId,
    planType: typeof value.planType === "string" ? value.planType.slice(0, 80) : null,
    rateLimit: { primary_window: primary, secondary_window: secondary }
  };
}

function quotaWindows(rateLimit) {
  let primary = null, secondary = null;
  for (const value of [rateLimit.primary_window, rateLimit.secondary_window]) {
    if (!value) continue;
    // New web accounts may return the weekly limit as primary_window alone.
    if (value.limit_window_seconds > 86400) {
      if (secondary) throw new Error("瀏覽器回應含多個長期用量視窗，無法辨識每週額度");
      secondary = whamWindow(value, 10080);
    } else {
      if (primary) throw new Error("瀏覽器回應含多個短期用量視窗，無法辨識短期額度");
      primary = whamWindow(value, 300);
    }
  }
  return { primary, secondary };
}

function createBrowserUsage({ userDataPath, profileId, openBrowser = async (browser, url) => {
  await run("/usr/bin/open", ["-b", browser.bundleId, url]);
}, loginTimeoutMs = 120000 }) {
  const settingsFile = path.join(userDataPath, "browser-usage-settings.json");
  let options, pinned, server, endpoint, secret, latest, lastError;
  let starting, pendingLogin, changing = Promise.resolve();
  async function load() {
    if (options) return;
    try {
      const value = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      options = validateOptions(value);
      pinned = value.account && typeof value.account.email === "string" && typeof value.account.accountId === "string" ? value.account : null;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("瀏覽器用量設定無法讀取，請檢查設定檔");
      options = { source: "codex", browser: "safari" };
    }
  }
  async function save() {
    await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
    const temp = `${settingsFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ ...options, account: pinned }, null, 2), { mode: 0o600 });
    await fs.rename(temp, settingsFile);
  }
  function stop() {
    pendingLogin?.reject(new Error("瀏覽器連線已取消"));
    server?.close(); server?.closeAllConnections();
    server = endpoint = secret = null;
    latest = null; lastError = null;
  }
  async function start() {
    if (server) return;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      secret = crypto.randomBytes(32).toString("hex");
      const instance = http.createServer((request, response) => {
        handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(400);
          response.end("Invalid quota snapshot");
        });
      });
      instance.on("error", () => reject(new Error("無法啟動瀏覽器用量橋接")));
      instance.listen(0, "127.0.0.1", () => {
        server = instance;
        endpoint = `http://127.0.0.1:${instance.address().port}`;
        resolve();
      });
    }).finally(() => { starting = null; });
    return starting;
  }
  async function handle(request, response) {
    // No DNS rebinding, arbitrary CORS, cookies, or authentication tokens.
    if (request.headers.host !== new URL(endpoint).host) { response.writeHead(403); response.end(); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = request.headers.origin;
    if (origin && !/^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-zA-Z0-9-]+$/.test(origin)) {
      response.writeHead(403); response.end(); return;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS" && request.url === "/snapshot") {
      response.setHeader("Access-Control-Allow-Methods", "POST");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Quota-Secret");
      response.writeHead(204); response.end(); return;
    }
    if (request.method === "GET" && request.url === "/pair") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      response.end('<!doctype html><html lang="zh-TW"><meta charset="utf-8"><title>Codex 額度瀏覽器連線</title><h1>連接此瀏覽器</h1><p id="quota-pair-status">請先安裝 Codex 額度橋接擴充套件。安裝後重新按面板齒輪內的「登入 ChatGPT」。</p></html>');
      return;
    }
    const supplied = request.headers["x-quota-secret"];
    if (request.method !== "POST" || request.url !== "/snapshot" || typeof supplied !== "string" ||
        supplied.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
      response.writeHead(403); response.end(); return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > 8192) { response.writeHead(413); response.end(); return; }
    }
    const value = JSON.parse(body);
    if (value.error) {
      latest = null;
      lastError = "瀏覽器無法讀取用量，請確認已登入 ChatGPT，並重新連線";
      pendingLogin?.reject(new Error(lastError));
      response.writeHead(422); response.end(); return;
    }
    const snapshot = sanitizeSnapshot(value);
    if (pinned && (pinned.email !== snapshot.email || pinned.accountId !== snapshot.accountId)) {
      latest = null;
      lastError = `瀏覽器帳號已變更；此面板綁定 ${pinned.email}，請重新連線確認帳號`;
      response.writeHead(409); response.end(); return;
    }
    if (!pinned) {
      pinned = { email: snapshot.email, accountId: snapshot.accountId };
      await save();
    }
    latest = { ...snapshot, receivedAt: Date.now() }; lastError = null;
    pendingLogin?.resolve({ email: pinned.email });
    response.writeHead(204); response.end();
  }
  async function getOptions() {
    await load();
    const browsers = await Promise.all(BROWSERS.map(async (b) => ({ id: b.id, name: b.name,
      installed: await fs.access(b.appPath).then(() => true, () => false) })));
    return { ...options, browsers, email: pinned?.email || null };
  }
  function setOptions(value) {
    changing = changing.catch(() => {}).then(async () => {
      await load(); const next = validateOptions(value);
      if (next.source !== options.source || next.browser !== options.browser) {
        stop(); pinned = null; options = next; await save();
      }
      return getOptions();
    });
    return changing;
  }
  async function isBrowser() { await load(); return options.source === "browser"; }
  async function hasSession() {
    await load();
    if (options.source !== "browser") return false;
    return Boolean(latest && !lastError && Date.now() - latest.receivedAt < MAX_AGE_MS);
  }
  async function login() {
    await load();
    if (pendingLogin) throw new Error("此面板正在等待瀏覽器連線");
    await start();
    const browser = BROWSERS.find((b) => b.id === options.browser);
    // Explicit reconnect releases the old account pin. Normal polling never switches accounts.
    pinned = null; latest = null; lastError = null; await save();
    secret = crypto.randomBytes(32).toString("hex");
    const fragment = new URLSearchParams({ secret, profile: profileId, browser: options.browser });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("等待瀏覽器用量逾時；請安裝橋接擴充套件、登入 ChatGPT，再重新連線")), loginTimeoutMs);
      function finish(error, value) {
        clearTimeout(timer); pendingLogin = null;
        if (error) reject(error); else resolve(value);
      }
      pendingLogin = { resolve: (value) => finish(null, value), reject: (error) => finish(error) };
      Promise.resolve(openBrowser(browser, `${endpoint}/pair#${fragment}`)).catch(() => finish(new Error(`無法開啟 ${browser.name}，請確認已安裝`)));
    });
  }
  async function logout() { await load(); stop(); pinned = null; await save(); }
  async function readQuota() {
    await load();
    // The pair URL changes each app launch; no old browser session can authenticate silently.
    if (lastError) throw new Error(lastError);
    if (!latest || Date.now() - latest.receivedAt >= MAX_AGE_MS) throw new Error("瀏覽器用量尚未連線或已過期；請在齒輪按登入 ChatGPT，並保持瀏覽器開啟");
    const normalized = normalizeSnapshot({ limitId: "codex", limitName: "Codex", planType: prettyPlan(latest.planType) || "Codex",
      ...quotaWindows(latest.rateLimit) });
    return { ...normalized, source: "codex", fetchedAt: new Date(latest.receivedAt).toISOString(),
      account: { email: latest.email, label: null, source: "codex" } };
  }
  return { getOptions, setOptions, isBrowser, hasSession, login, logout, readQuota, destroy: stop };
}
module.exports = { BROWSERS, MAX_AGE_MS, validateOptions, sanitizeSnapshot, quotaWindows, createBrowserUsage };
