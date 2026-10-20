"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { readCredential, parseUsageDocument, readUsageJson, createQuotaService } = require("../src/main/quota-service");
const { createAccountService } = require("../src/main/agy-account-service");
const { stageGoogleApp } = require("../../../scripts/install-google-app");
const usage = require("./fixtures/usage.json");
const recorded = require("./fixtures/usage-recorded.json");
const NOW = Date.parse("2030-01-01T00:00:00Z");
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`OK ${name}`); }
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const stored = (id = "A", token = `access-${id}`) => ({ token: { access_token: token, refresh_token: `refresh-${id}`, expiry: "2030-01-01T01:00:00Z" }, id_token: jwt({ sub: id, email: `${id}@example.test` }) });
const credential = (id = "A") => ({ accountId: id.toLowerCase().repeat(64), accessToken: `access-${id}`, expiresAt: NOW - 1, email: `${id}@example.test` });
const service = options => createQuotaService({ readUsage: async () => usage, now: () => NOW, ...options });
function buckets(document) { return document.command.data.groups.flatMap(group => group.buckets); }
async function verifyCore() {
  await check("real CLI /usage quota IDs, values and reset times survive mapping to all three rows", () => {
    const result = parseUsageDocument(recorded, { now: Date.parse("2026-10-20T11:00:00Z") });
    assert.deepEqual(result.groups.map(g => g.name), ["Gemini Models", "Claude and GPT Models", "Gemini 4 Argon"]);
    const find = id => buckets(recorded).find(b => b.id === id);
    for (const [groupIndex, role, id] of [[0,"primary","gemini-5h"],[0,"secondary","gemini-weekly"],[1,"primary","3p-5h"],[1,"secondary","3p-weekly"],[2,"secondary","gemini-argon-wtu-weekly"]]) {
      const raw = find(id), normalized = result.groups[groupIndex][role];
      assert.equal(normalized.remainingPercent, Math.round(raw.remaining_fraction * 10000) / 100);
      assert.equal(normalized.resetsAt, new Date(raw.reset_time).toISOString());
      assert.equal(Math.round((normalized.remainingPercent + normalized.usedPercent) * 100) / 100, 100);
    }
    assert.equal(result.groups[2].primary, null); assert.equal(result.source, "agy-cli"); assert.equal(result.limitId, "google:all");
  });
  await check("rounds user-reported 98.46/94.59 correctly and preserves independent Argon weekly quota", () => {
    const d = structuredClone(usage); const bs = buckets(d);
    bs.find(b => b.id === "gemini-weekly").remaining_fraction = 0.9845516681671143;
    bs.find(b => b.id === "gemini-5h").remaining_fraction = 0.9459308385848999;
    bs.find(b => b.id === "gemini-argon-wtu-weekly").remaining_fraction = 0.5186359882354736;
    const groups = parseUsageDocument(d, { now: NOW }).groups;
    assert.equal(groups[0].secondary.remainingPercent, 98.46); assert.equal(groups[0].primary.remainingPercent, 94.59);
    assert.equal(groups[0].secondary.usedPercent, 1.54); assert.equal(groups[0].primary.usedPercent, 5.41);
    assert.equal(groups[2].secondary.remainingPercent, 51.86); assert.equal(groups[2].primary, null);
  });
  await check("missing windows/groups remain missing, never read as zero or borrowed from another group", () => {
    const d = structuredClone(usage); d.command.data.groups = [d.command.data.groups[1]];
    const groups = parseUsageDocument(d, { now: NOW }).groups;
    assert.equal(groups[0].primary, null); assert.equal(groups[0].secondary, null);
    assert.equal(groups[2].primary, null); assert.equal(groups[2].secondary, null);
    assert.ok(groups[1].primary);
  });
  await check("rejects old web API data, context usage, non-usage commands, agent turns and malformed fractions", () => {
    for (const d of [{ groups: [] }, { context_window: { used_percentage: 73 } }, { status: "ERROR" },
      { ...usage, num_turns: 1 }, { ...usage, command: { name: "model", data: {} } }]) assert.throws(() => parseUsageDocument(d));
    const mutations = [
      d => buckets(d)[0].remaining_fraction = NaN, d => buckets(d)[0].remaining_fraction = "0.5",
      d => buckets(d)[0].remaining_fraction = -0.1, d => buckets(d)[0].remaining_fraction = 1.1,
      d => buckets(d)[0].reset_time = "2020-01-01", d => delete buckets(d)[0].reset_time,
      d => buckets(d)[0].window = "5h", d => d.command.data.groups[0].buckets.push(buckets(d)[0])
    ];
    for (const mutate of mutations) { const d = structuredClone(usage); mutate(d); assert.throws(() => parseUsageDocument(d, { now: NOW })); }
  });
  await check("CLI runner invokes only the official read-only slash command, with bounded time and output", async () => {
    let call;
    const result = await readUsageJson({ executable: "/test/agy", runCommand: async (...args) => { call = args; return { stdout: JSON.stringify(usage) }; } });
    assert.equal(result.command.name, "usage"); assert.equal(call[0], "/test/agy");
    assert.deepEqual(call[1], ["-p", "/usage", "--output-format", "json"]);
    assert.equal(call[2].cwd, os.tmpdir()); assert.ok(call[2].timeout > 0); assert.ok(call[2].maxBuffer <= 2 * 1024 * 1024);
    await rejects(readUsageJson({ runCommand: async () => { throw Object.assign(Error("secret"), { code: "ENOENT" }); } }), "CLI_MISSING");
    await rejects(readUsageJson({ runCommand: async () => { throw Object.assign(Error("secret"), { killed: true }); } }), "TIMEOUT");
    await rejects(readUsageJson({ runCommand: async () => { throw Error("secret"); } }), "CLI_ERROR");
    await rejects(readUsageJson({ runCommand: async () => ({ stdout: "not-json" }) }), "INVALID_USAGE");
  });
  await check("Keychain is scoped to AGY, parses its envelope and does not disclose transport errors", async () => {
    let call;
    const result = await readCredential({ type: "keychain", account: "antigravity" }, { runCommand: async (...args) => { call = args; return { stdout: "go-keyring-base64:" + Buffer.from(JSON.stringify(stored())).toString("base64") }; } });
    assert.equal(result.email, "A@example.test");
    assert.deepEqual(call[1], ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
    await rejects(readCredential({ type: "keychain", account: "another" }), "INVALID_CREDENTIAL");
    await rejects(readCredential({ type: "keychain", account: "antigravity" }, { runCommand: async () => { throw Error("secret"); } }), "CREDENTIAL_MISSING");
  });
  await check("pinned identity checked before and after CLI execution; no other-account data can escape", async () => {
    let current = credential("A"), calls = 0;
    const s = service({ readCredential: async () => current, readUsage: async () => { calls++; return usage; } });
    const binding = { keychainAccount: "antigravity", accountId: current.accountId };
    assert.equal((await s.getQuota(binding)).groups.length, 3); assert.equal(calls, 1);
    // Expired access tokens are refreshed only by the official CLI; the panel never refreshes them.
    assert.equal(current.expiresAt, NOW - 1);
    current = credential("B"); await rejects(s.getQuota(binding), "ACCOUNT_CHANGED"); assert.equal(calls, 1);
    current = credential("A");
    const race = service({ readCredential: async () => current, readUsage: async () => { current = credential("B"); return usage; } });
    await rejects(race.getQuota(binding), "ACCOUNT_CHANGED");
    await rejects(s.getQuota({}), "NOT_CONNECTED");
  });
  await check("legacy file binding must match the local AGY account", async () => {
    const s = service({ readCredential: async source => typeof source === "string" ? credential("A") : credential("B") });
    await rejects(s.getQuota({ tokenFile: "/test/A", accountId: credential("A").accountId }), "ACCOUNT_CHANGED");
  });
}
async function verifyAccounts(root) {
  await check("panels are disconnected until explicitly linked, keep all groups, and never persist tokens", async () => {
    let selected = { type: "keychain" }, current = credential("A");
    const readToken = async () => current;
    const dir = path.join(root, "panel"); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "quota-cache.json"), JSON.stringify({ quota: { source: "google-api" } }));
    const panel = createAccountService({ selectSource: async () => selected, readToken, quotaService: service({ readCredential: readToken }) });
    await panel.configure(dir); await assert.rejects(fs.access(path.join(dir, "quota-cache.json")));
    await rejects(panel.getQuota(), "NOT_CONNECTED"); await panel.login();
    assert.equal((await panel.getQuota()).groups.length, 3); await panel.configure(dir); assert.equal(await panel.hasSession(), true);
    const text = await fs.readFile(path.join(dir, "agy-account.json"), "utf8");
    assert.ok(!text.includes("access_token") && !text.includes(current.accessToken));
    assert.equal((await fs.stat(path.join(dir, "agy-account.json"))).mode & 0o777, 0o600);
    selected = null; assert.deepEqual(await panel.login(), { cancelled: true }); assert.equal(await panel.hasSession(), true);
    current = credential("B"); assert.equal(await panel.hasSession(), false); await rejects(panel.getQuota(), "ACCOUNT_CHANGED");
    await panel.logout(); assert.equal(await panel.hasSession(), false); await rejects(panel.getQuota(), "NOT_CONNECTED");
  });
  await check("startup drops wrong-account and old-API caches, retains matching CLI cache", async () => {
    const dir = path.join(root, "cache-panel"), current = credential("A");
    const panel = createAccountService({ selectSource: async () => ({ type: "keychain" }), readToken: async () => current });
    await panel.configure(dir); await panel.login();
    const file = path.join(dir, "quota-cache.json");
    for (const quota of [{ account: { id: current.accountId }, source: "google-api", limitId: "google:gemini" },
      { account: { id: "other" }, source: "agy-cli", limitId: "google:all" }]) {
      await fs.writeFile(file, JSON.stringify({ quota })); await panel.configure(dir); await assert.rejects(fs.access(file));
    }
    await fs.writeFile(file, JSON.stringify({ quota: { account: { id: current.accountId }, source: "agy-cli", limitId: "google:all" } }));
    await panel.configure(dir); await fs.access(file);
  });
}
async function verifySharedAuth() {
  await check("IPC connect/disconnect clears all old quota and cancellation leaves data alone", async () => {
    const filename = path.resolve(__dirname, "../../../packages/shared/main-core.js"), requireReal = createRequire(filename), handlers = new Map();
    let resets = 0, refreshes = 0, connected = false, cancelled = false;
    const context = vm.createContext({ module: { exports: {} }, process, console, setTimeout, clearTimeout,
      require: name => name === "electron" ? { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: {} } : requireReal(name) });
    vm.runInContext(await fs.readFile(filename, "utf8"), context, { filename });
    context.windowConfig = { appIconPath: "/icon", preloadPath: "/preload", rendererHtmlPath: "/renderer", settingsHtmlPath: "/settings", readQuota: async () => ({}) };
    assert.equal(vm.runInContext("normalizeConfig(windowConfig).windowSize.width", context), 390);
    assert.equal(vm.runInContext("normalizeConfig(windowConfig).windowSize.height", context), 336);
    context.windowConfig.windowSize = { width: 570, height: 314 };
    assert.equal(vm.runInContext("normalizeConfig(windowConfig).windowSize.width", context), 570);
    context.auth = { hasSession: async () => connected, resetQuotaOnChange: true,
      login: async () => { if (cancelled) return { cancelled: true }; connected = true; return {}; }, logout: async () => { connected = false; },
      getOptions: async () => ({}), setOptions: async value => value };
    context.store = { resetAccount: async () => { resets++; }, refreshNow: async () => { refreshes++; } };
    vm.runInContext("config = {auth}; quotaStore = store; registerIpcHandlers();", context);
    await handlers.get("auth:login")(); assert.equal(resets, 1); assert.equal(refreshes, 1);
    await handlers.get("auth:logout")(); assert.equal(resets, 2); assert.equal(connected, false);
    cancelled = true; await handlers.get("auth:login")(); assert.equal(resets, 2);
  });
}
async function verifyStaging(root) {
  await check("failed builder/validation never touches installed Apps", async () => {
    const repo = path.join(root, "build-repo"), app = path.join(repo, "apps/google"); await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ version: "1.2.3", build: { productName: "Google 額度", appId: "com.google.usage.widget" } }));
    const calls = []; const run = (_exe, args) => calls.push(args);
    const result = await stageGoogleApp({ repoRoot: repo, run, arch: "arm64", validate: async (_bundle, opts) => { assert.equal(opts.bundleId, "com.google.usage.widget"); } });
    assert.ok(result.endsWith("mac-arm64/Google 額度.app")); assert.ok(calls[1].includes("--arm64"));
    assert.ok(calls.every(args => args.every(arg => !arg.startsWith("/Applications/"))));
    await assert.rejects(stageGoogleApp({ repoRoot: repo, run: () => { throw Error("failed"); } }), /failed/);
  });
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "google-quota-test-"));
  try { await verifyCore(); await verifyAccounts(root); await verifySharedAuth(); await verifyStaging(root); console.log(`Verified ${checks} Google three-group/CLI/account/IPC/staging regression groups.`); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
