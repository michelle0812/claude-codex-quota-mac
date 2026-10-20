"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { DEFAULT_TOKEN_FILE, readCredential, parseQuotaSummary, requestJson, createQuotaService } = require("../src/main/quota-service");
const { createAccountService } = require("../src/main/agy-account-service");
const { stageGoogleApp } = require("../../../scripts/install-google-app");
const summary = require("./fixtures/quota-summary.json");
const NOW = Date.parse("2030-01-01T00:00:00Z");
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`OK ${name}`); }
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const credential = (id = "A", token = `access-${id}`) => ({ accountId: id, accessToken: token, expiresAt: NOW + 3600000, email: `${id}@example.test` });
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const stored = (id = "A", token = `access-${id}`) => ({ token: { access_token: token, refresh_token: `refresh-${id}`, expiry: "2030-01-01T01:00:00Z" }, id_token: jwt({ sub: id, email: `${id}@example.test` }) });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
function server() {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(url, /^https:\/\/cloudcode-pa\.googleapis\.com\/v1internal:/);
    const who = options.headers.Authorization.replace("Bearer access-", "");
    return response(url.endsWith(":loadCodeAssist") ? { cloudaicompanionProject: `project-${who}`, paidTier: { name: "Test plan" } } : summary);
  } };
}
async function verifyCore() {
  await check("measured API shape keeps Gemini and Claude/GPT quotas separate", () => {
    const a = parseQuotaSummary(summary, { now: NOW });
    const b = parseQuotaSummary(summary, { group: "third-party", now: NOW });
    assert.equal(a.primary.usedPercent, 10); assert.equal(a.secondary.usedPercent, 30);
    assert.equal(b.primary.usedPercent, 60); assert.equal(b.secondary.usedPercent, 80);
    assert.equal(a.primary.windowDurationMins, 300); assert.equal(a.secondary.windowDurationMins, 10080);
    assert.equal(a.fetchedAt, new Date(NOW).toISOString());
    assert.equal(b.limitId, "google:third-party");
  });
  await check("context usage, statusLine percentages and missing/wrong groups are rejected", () => {
    for (const data of [{ context_window: { used_percentage: 73 } }, { rate_limits: { five_hour: { used_percentage: 12 } } },
      {}, { groups: [summary.groups[1]] }]) assert.throws(() => parseQuotaSummary(data, { now: NOW }));
    assert.throws(() => parseQuotaSummary(summary, { group: "anything", now: NOW }));
  });
  await check("rejects duplicate, disabled, stale, missing reset and invalid quota values", () => {
    const mutate = [
      d => d.groups[0].buckets.push(d.groups[0].buckets[0]),
      d => { d.groups[0].buckets[0].disabled = true; },
      d => { d.groups[0].buckets[0].resetTime = "2020-01-01T00:00:00Z"; },
      d => { delete d.groups[0].buckets[0].resetTime; },
      d => { d.groups[0].buckets[0].window = "5h"; },
      ...[NaN, Infinity, -0.01, 1.01, null, "0.5"].map(value => d => { d.groups[0].buckets[0].remainingFraction = value; })
    ];
    for (const change of mutate) { const data = structuredClone(summary); change(data); assert.throws(() => parseQuotaSummary(data, { now: NOW })); }
    const data = structuredClone(summary); data.groups[0].buckets[1].remainingFraction = 0;
    assert.equal(parseQuotaSummary(data, { now: NOW }).reachedType, "rate_limit_reached");
  });
  await check("credential filename matches AGY; malformed/anonymous credentials rejected without leaking tokens", async () => {
    assert.equal(path.basename(DEFAULT_TOKEN_FILE), "antigravity-oauth-token");
    const read = data => readCredential("/mock/token", { readFile: async () => JSON.stringify(data) });
    const a = await read(stored()); const next = await read(stored("A", "rotated")); const b = await read(stored("B"));
    assert.equal(a.accountId, next.accountId); assert.notEqual(a.accountId, b.accountId);
    assert.equal(a.email, "A@example.test");
    for (const data of [null, [], {}, { token: { access_token: "secret" } }, { ...stored(), token: { ...stored().token, expiry: "bad" } }]) {
      await rejects(read(data), "INVALID_CREDENTIAL");
    }
    await rejects(readCredential("/mock", { readFile: async () => { throw Error("secret"); } }), "CREDENTIAL_MISSING");
    const plain = await read({ access_token: "access", refresh_token: "refresh", expiry: "2030-01-01T01:00:00Z" });
    assert.match(plain.accountId, /^[a-f0-9]{64}$/);
  });
  await check("Keychain reads only the exact AGY entry, decodes go-keyring envelope and redacts failures", async () => {
    const calls = [];
    const source = { type: "keychain", account: "antigravity" };
    const raw = JSON.stringify(stored());
    const a = await readCredential(source, { runCommand: async (...args) => { calls.push(args); return { stdout: "go-keyring-base64:" + Buffer.from(raw).toString("base64") }; } });
    assert.equal(a.email, "A@example.test");
    assert.equal(calls[0][0], "/usr/bin/security");
    assert.deepEqual(calls[0][1], ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
    assert.ok(calls[0][2].timeout > 0);
    await rejects(readCredential({ type: "keychain", account: "another" }), "INVALID_CREDENTIAL");
    await rejects(readCredential(source, { runCommand: async () => { throw Error("secret-must-not-leak"); } }), "CREDENTIAL_MISSING");
    await rejects(readCredential(source, { runCommand: async () => ({ stdout: "not JSON" }) }), "INVALID_CREDENTIAL");
  });
  await check("rotation, account switch and project lookup never reuse another token/account", async () => {
    let current = credential(); const api = server();
    const service = createQuotaService({ readCredential: async () => current, fetchImpl: api.fetch, now: () => NOW });
    const binding = { tokenFile: "/A", accountId: "A" };
    await service.getQuota(binding); await service.getQuota(binding);
    assert.equal(api.calls.filter(c => c.url.endsWith(":loadCodeAssist")).length, 1);
    current = credential("A", "access-A2"); await service.getQuota(binding);
    assert.equal(api.calls.filter(c => c.url.endsWith(":loadCodeAssist")).length, 2);
    current = credential("B"); const before = api.calls.length;
    await rejects(service.getQuota(binding), "ACCOUNT_CHANGED"); assert.equal(api.calls.length, before);
    await service.getQuota({ tokenFile: "/B", accountId: "B", group: "third-party" });
    const call = api.calls.at(-1); assert.equal(call.headers.Authorization, "Bearer access-B");
    assert.equal(JSON.parse(call.body).project, "project-B");
    assert.ok(api.calls.every(call => !call.url.includes("oauth2")));
  });
  await check("unconnected and expired credentials make no network requests", async () => {
    const api = server();
    const service = createQuotaService({ readCredential: async () => ({ ...credential(), expiresAt: NOW }), fetchImpl: api.fetch, now: () => NOW });
    await rejects(service.getQuota({}), "NOT_CONNECTED");
    await rejects(service.getQuota({ tokenFile: "/A", accountId: "A" }), "AUTH_EXPIRED");
    assert.equal(api.calls.length, 0);
  });
  await check("failed Google API does not fall back to local or a different account", async () => {
    for (const [status, code] of [[401, "AUTH_EXPIRED"], [403, "AUTH_DENIED"], [429, "HTTP_ERROR"], [500, "HTTP_ERROR"]]) {
      await rejects(requestJson("loadCodeAssist", {}, credential(), { fetchImpl: async () => response({ secret: "do-not-print" }, status) }), code);
    }
    await rejects(requestJson("loadCodeAssist", {}, credential(), { fetchImpl: async () => new Response("<html>secret</html>") }), "INVALID_RESPONSE");
    await rejects(requestJson("loadCodeAssist", {}, credential(), { fetchImpl: async () => { throw Error("access-A must not leak"); } }), "NETWORK_ERROR");
    const service = createQuotaService({ readCredential: async () => credential(), now: () => NOW,
      fetchImpl: async () => response({}) });
    await rejects(service.getQuota({ tokenFile: "/A", accountId: "A" }), "INVALID_RESPONSE");
  });
  await check("request and response-body timeouts both abort", async () => {
    const hang = signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("abort")), { once: true }));
    await rejects(requestJson("loadCodeAssist", {}, credential(), { timeoutMs: 10, fetchImpl: async (_, opts) => hang(opts.signal) }), "TIMEOUT");
    await rejects(requestJson("loadCodeAssist", {}, credential(), { timeoutMs: 10,
      fetchImpl: async (_, opts) => ({ ok: true, status: 200, text: () => hang(opts.signal) }) }), "TIMEOUT");
  });
}
async function verifyAccounts(root) {
  await check("panels require explicit binding, preserve AGY token bytes and disconnect independently", async () => {
    const aFile = path.join(root, "a-token"), bFile = path.join(root, "b-token");
    const aBytes = JSON.stringify(stored()), bBytes = JSON.stringify(stored("B"));
    await fs.writeFile(aFile, aBytes, { mode: 0o600 }); await fs.writeFile(bFile, bBytes, { mode: 0o600 });
    const aDir = path.join(root, "panel-A"), bDir = path.join(root, "panel-B");
    await fs.mkdir(aDir);
    for (const name of ["quota-cache.json", "quota-history.json"]) await fs.writeFile(path.join(aDir, name), "legacy fake quota");
    const api = server(), service = () => createQuotaService({ fetchImpl: api.fetch, now: () => NOW });
    let selectA = aFile;
    const a = createAccountService({ selectFile: async () => selectA, quotaService: service() });
    const b = createAccountService({ selectFile: async () => bFile, quotaService: service() });
    await a.configure(aDir); await b.configure(bDir);
    await assert.rejects(fs.access(path.join(aDir, "quota-cache.json")));
    await rejects(a.getQuota(), "NOT_CONNECTED"); await rejects(b.getQuota(), "NOT_CONNECTED");
    await a.login(); await b.login(); await b.setOptions({ group: "third-party" });
    assert.equal((await a.getQuota()).primary.usedPercent, 10);
    assert.equal((await b.getQuota()).primary.usedPercent, 60);
    const disk = await fs.readFile(path.join(aDir, "agy-account.json"), "utf8");
    assert.ok(!disk.includes("access_token") && !disk.includes("refresh_token"));
    assert.equal((await fs.stat(path.join(aDir, "agy-account.json"))).mode & 0o777, 0o600);
    selectA = null; assert.deepEqual(await a.login(), { cancelled: true }); assert.equal(await a.hasSession(), true);
    await a.logout(); assert.equal(await a.hasSession(), false); assert.equal(await b.hasSession(), true);
    assert.equal(await fs.readFile(aFile, "utf8"), aBytes); assert.equal(await fs.readFile(bFile, "utf8"), bBytes);
    const again = createAccountService({ selectFile: async () => bFile, quotaService: service() });
    await again.configure(bDir); assert.equal((await again.getOptions()).group, "third-party");
    await fs.writeFile(bFile, aBytes); assert.equal(await b.hasSession(), false); await rejects(b.getQuota(), "ACCOUNT_CHANGED");
    await assert.rejects(b.setOptions({ group: "bad" }));
    await assert.rejects(b.setOptions({ tokenFile: aFile }));
  });
  await check("Keychain-backed panels persist identity only and stop when AGY changes accounts", async () => {
    const dir = path.join(root, "keychain-panel");
    let current = { ...credential("A"), accountId: "a".repeat(64) }, selection = { type: "keychain" };
    const seen = [];
    const readToken = async source => { seen.push(source); return current; };
    const api = server();
    const quotaService = createQuotaService({ readCredential: readToken, fetchImpl: api.fetch, now: () => NOW });
    const panel = createAccountService({ selectSource: async () => selection, readToken, quotaService });
    await panel.configure(dir); await panel.login();
    // Use a real-format identity pin to exercise persisted Keychain bindings.
    const saved = JSON.parse(await fs.readFile(path.join(dir, "agy-account.json"), "utf8"));
    assert.equal(saved.keychainAccount, "antigravity"); assert.equal(saved.tokenFile, null);
    assert.ok(!JSON.stringify(saved).includes(current.accessToken));
    assert.equal((await panel.getQuota()).primary.usedPercent, 10);
    await panel.configure(dir); assert.equal(await panel.hasSession(), true);
    assert.ok(seen.every(source => source.type === "keychain" && source.account === "antigravity"));
    current = credential("B"); assert.equal(await panel.hasSession(), false);
    await rejects(panel.getQuota(), "ACCOUNT_CHANGED");
    selection = null; assert.deepEqual(await panel.login(), { cancelled: true });
    await panel.logout(); assert.equal(await panel.hasSession(), false);
    await rejects(panel.getQuota(), "NOT_CONNECTED");
  });
  await check("startup drops cache from an old account/group and retains only matching cache", async () => {
    const dir = path.join(root, "cache-panel"), tokenFile = path.join(root, "cache-token");
    await fs.writeFile(tokenFile, JSON.stringify(stored()));
    const a = createAccountService({ selectFile: async () => tokenFile });
    await a.configure(dir); await a.login();
    const identity = (await readCredential(tokenFile)).accountId;
    const cacheFile = path.join(dir, "quota-cache.json");
    const setup = async quota => { await fs.writeFile(cacheFile, JSON.stringify({ quota })); await fs.writeFile(path.join(dir, "quota-history.json"), "[]"); };
    await setup({ account: { id: "another" }, limitId: "google:gemini" }); await a.configure(dir); await assert.rejects(fs.access(cacheFile));
    await setup({ account: { id: identity }, limitId: "google:third-party" }); await a.configure(dir); await assert.rejects(fs.access(cacheFile));
    await setup({ account: { id: identity }, limitId: "google:gemini" }); await a.configure(dir); await fs.access(cacheFile);
  });
}
async function verifySharedAuth() {
  await check("real IPC auth handlers clear old quota/history on connect, disconnect and group change", async () => {
    const filename = path.resolve(__dirname, "../../../packages/shared/main-core.js");
    const requireReal = createRequire(filename), handlers = new Map(); let resets = 0, refreshes = 0, group = "gemini", connected = false, cancelled = false;
    const context = vm.createContext({ module: { exports: {} }, process, console, setTimeout, clearTimeout,
      require: name => name === "electron" ? { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, app: {} } : requireReal(name) });
    vm.runInContext(await fs.readFile(filename, "utf8"), context, { filename });
    context.auth = { hasSession: async () => connected, resetQuotaOnChange: true,
      login: async () => { if (cancelled) return { cancelled: true }; connected = true; return {}; }, logout: async () => { connected = false; },
      getOptions: async () => ({ group }), setOptions: async value => { group = value.group; return { group }; } };
    context.store = { resetAccount: async () => { resets++; }, refreshNow: async () => { refreshes++; } };
    vm.runInContext("config = {auth}; quotaStore = store; registerIpcHandlers();", context);
    assert.ok(handlers.has("auth:login")); assert.ok(handlers.has("auth:options:set"));
    await handlers.get("auth:login")(); assert.equal(resets, 1); assert.equal(refreshes, 1);
    await handlers.get("auth:options:set")(null, { group: "third-party" }); assert.equal(resets, 2);
    await handlers.get("auth:options:set")(null, { group: "third-party" }); assert.equal(resets, 2);
    await handlers.get("auth:logout")(); assert.equal(resets, 3); assert.equal(connected, false);
    cancelled = true; await handlers.get("auth:login")(); assert.equal(resets, 3);
  });
}
async function verifyStaging(root) {
  await check("builder failure and bundle validation never touch an installed App", async () => {
    const repo = path.join(root, "build-repo"), app = path.join(repo, "apps/google");
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ version: "1.2.3", build: { productName: "Google 額度", appId: "com.google.usage.widget" } }));
    const calls = []; let validated = 0;
    const run = (_exe, args) => { calls.push(args); };
    const result = await stageGoogleApp({ repoRoot: repo, run, arch: "arm64", validate: async (bundle, opts) => {
      validated++; assert.equal(opts.bundleId, "com.google.usage.widget"); assert.equal(opts.arch, "arm64");
      assert.ok(bundle.startsWith(path.join(app, "dist")));
    } });
    assert.ok(result.endsWith("mac-arm64/Google 額度.app")); assert.equal(validated, 1);
    assert.ok(calls[1].includes("--arm64")); assert.ok(calls.every(args => args.every(arg => !arg.startsWith("/Applications/"))));
    await assert.rejects(stageGoogleApp({ repoRoot: repo, arch: "arm64", run: () => { throw Error("build failed"); } }), /build failed/);
    await assert.rejects(stageGoogleApp({ repoRoot: repo, arch: "x64", run, validate: async () => { throw Error("invalid bundle"); } }), /invalid bundle/);
  });
}
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "google-quota-test-"));
  try { await verifyCore(); await verifyAccounts(root); await verifySharedAuth(); await verifyStaging(root);
    console.log(`Verified ${checks} Google quota/account/IPC/staging regression groups.`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
