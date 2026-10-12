"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createBrowserUsage, sanitizeSnapshot, quotaWindows, MAX_AGE_MS } = require("../src/main/browser-usage-service");
const { QuotaStore } = require("../src/shared-gen/quota-store");
const fixture = { email: "account@example.com", accountId: "account-example", planType: "plus",
  rateLimit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1791840000 },
    secondary_window: { used_percent: 34, limit_window_seconds: 604800, reset_at: 1792444800 } } };

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-browser-test-"));
  let opened;
  const a = createBrowserUsage({ userDataPath: path.join(dir, "main"), profileId: "default", openBrowser: async (browser, url) => { opened = { browser, url: new URL(url) }; } });
  const b = createBrowserUsage({ userDataPath: path.join(dir, "add-1"), profileId: "add-1", openBrowser: async () => {} });
  try {
    assert.equal((await a.getOptions()).source, "codex");
    await a.setOptions({ source: "browser", browser: "safari" });
    await b.setOptions({ source: "browser", browser: "chrome" });
    assert.equal((await a.getOptions()).browser, "safari"); assert.equal((await b.getOptions()).browser, "chrome");
    await assert.rejects(a.setOptions({ source: "browser", browser: "arbitrary-app" }));
    const stored = createBrowserUsage({ userDataPath: path.join(dir, "add-1"), profileId: "add-1" });
    assert.equal((await stored.getOptions()).browser, "chrome"); stored.destroy();
    await assert.rejects(a.readQuota(), /尚未連線/);
    const login = a.login();
    while (!opened) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(opened.browser.bundleId, "com.apple.Safari");
    const secret = new URLSearchParams(opened.url.hash.slice(1)).get("secret");
    const post = (value, headers = {}) => fetch(`${opened.url.origin}/snapshot`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Quota-Secret": secret, ...headers }, body: JSON.stringify(value) });
    assert.equal((await post(fixture, { "X-Quota-Secret": "0".repeat(64) })).status, 403);
    assert.equal((await post(fixture, { Origin: "https://chatgpt.com" })).status, 403);
    assert.equal((await post({ ...fixture, rateLimit: {} })).status, 400);
    assert.equal((await post({ ...fixture, tokens: { access_token: "do-not-store" }, cookie: "do-not-store" })).status, 204);
    assert.equal((await login).email, fixture.email);
    assert.equal(await a.hasSession(), true);
    const quota = await a.readQuota();
    assert.equal(quota.primary.usedPercent, 12); assert.equal(quota.secondary.remainingPercent, 66);
    assert.equal(quota.account.email, fixture.email);
    const disk = await fs.readFile(path.join(dir, "main/browser-usage-settings.json"), "utf8");
    assert.ok(!disk.includes(secret)); assert.ok(!disk.includes("do-not-store"));
    const realNow = Date.now;
    try { Date.now = () => realNow() + MAX_AGE_MS + 1; await assert.rejects(a.readQuota(), /過期/); assert.equal(await a.hasSession(), false); }
    finally { Date.now = realNow; }
    assert.equal((await post({ ...fixture, email: "different@example.com", accountId: "other" })).status, 409);
    await assert.rejects(a.readQuota(), /帳號已變更/);
    await a.logout(); assert.equal(await a.hasSession(), false);
    assert.equal((await a.getOptions()).email, null);

    const clean = sanitizeSnapshot({ ...fixture, accessToken: "hidden" });
    const weeklyOnly = quotaWindows({ primary_window: fixture.rateLimit.secondary_window, secondary_window: null });
    assert.equal(weeklyOnly.primary, null);
    assert.equal(weeklyOnly.secondary.windowDurationMins, 10080);
    assert.equal(weeklyOnly.secondary.usedPercent, 34);
    const swapped = quotaWindows({ primary_window: fixture.rateLimit.secondary_window, secondary_window: fixture.rateLimit.primary_window });
    assert.equal(swapped.primary.windowDurationMins, 300); assert.equal(swapped.secondary.windowDurationMins, 10080);
    assert.ok(!JSON.stringify(clean).includes("hidden"));
    assert.throws(() => sanitizeSnapshot({ ...fixture, rateLimit: { primary_window: { ...fixture.rateLimit.primary_window, used_percent: null } } }));

    const store = new QuotaStore({ userDataPath: path.join(dir, "store"), readQuota: async () => quota, autoSchedule: false });
    await store.refreshNow(); await store.resetAccount();
    assert.equal(store.getState().quota, null); assert.deepEqual(store.history, []);
    await assert.rejects(fs.access(store.cachePath)); store.destroy();

    // Real content-script code, mocked endpoint responses: credentials must never leave the browser.
    let listener, messages = [], calls = [];
    const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: fixture.accountId } })).toString("base64url")}.secret`;
    const context = { chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: (message) => messages.push(message) } },
      atob: (value) => Buffer.from(value, "base64").toString("binary"), fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => url.endsWith("/session")
          ? { accessToken: token, user: { email: fixture.email }, cookie: "private" }
          : { plan_type: "plus", rate_limit: fixture.rateLimit, tokens: "private" } };
      } };
    const source = await fs.readFile(path.resolve(__dirname, "../../..", "browser-extension/chromium/usage.js"), "utf8");
    vm.runInNewContext(source, context);
    const result = await new Promise((resolve) => listener({ type: "collect-usage" }, {}, resolve));
    assert.equal(result.snapshot.email, fixture.email); assert.equal(result.snapshot.rateLimit.secondary_window.used_percent, 34);
    assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes("private"));
    assert.deepEqual(calls.map((call) => new URL(call.url).host), ["chatgpt.com", "chatgpt.com"]);
    assert.ok(!JSON.stringify(messages).includes(token));
    context.fetch = async () => ({ ok: false });
    const failure = await new Promise((resolve) => listener({ type: "collect-usage" }, {}, resolve));
    assert.equal(failure.error, "usage-unavailable");
    console.log("Verified browser choices are per-panel, persistence, loopback authentication, rejected web origins, account pinning, expiry, cache clearing, and credential-free extension snapshots.");
  } finally { a.destroy(); b.destroy(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
