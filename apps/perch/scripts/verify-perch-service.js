"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readCredential, normalizeAccount, createQuotaService, OFFICIAL_ORIGIN } = require("../src/main/quota-service");
const { createAccountService } = require("../src/main/perch-account-service");
const { windowLabels } = require("../src/shared-gen/window-labels");
const fixture = require("./fixtures/account.json");
const session = { version: 1, appUrl: OFFICIAL_ORIGIN, accessToken: "synthetic-access", refreshToken: "never-use-this", userId: "synthetic-user", email: "test@example.test", expiresAt: Date.now() / 1000 + 3600 };
async function credential(value = session) {
  return readCredential({ platform: "darwin", authDir: "", execute: async (cmd, args) => {
    assert.equal(cmd, "/usr/bin/security");
    assert.deepEqual(args, ["find-generic-password", "-s", "app.perchai.cli-auth", "-a", "default", "-w"]);
    return { stdout: JSON.stringify(value) };
  } });
}
(async () => {
  const token = await credential();
  assert.equal(token.refreshToken, undefined);
  assert.equal(token.accountId.length, 64);
  for (const appUrl of ["http://app.perchai.app", "https://evil.example", "https://app.perchai.app.evil.example", "https://user:secret@app.perchai.app", `${OFFICIAL_ORIGIN}/proxy`, `${OFFICIAL_ORIGIN}?redirect=evil`]) {
    await assert.rejects(credential({ ...session, appUrl }));
  }
  await assert.rejects(credential({ ...session, expiresAt: 1 }), /過期/);
  await assert.rejects(credential({ ...session, accessToken: "" }), /不完整/);
  const fileToken = await readCredential({ authDir: "/synthetic", execute: () => assert.fail("no keychain for file mode"), readFile: async filename => {
    assert.equal(filename, "/synthetic/cli-auth-session.json"); return JSON.stringify(session);
  } });
  assert.equal(fileToken.accountId, token.accountId);
  let calls = 0;
  const service = createQuotaService({ readToken: () => credential(), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, `${OFFICIAL_ORIGIN}/api/perchai/account`);
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-access");
    return { ok: true, json: async () => structuredClone(fixture) };
  } });
  const quota = await service.getQuota();
  assert.equal(calls, 1); assert.equal(quota.source, "perch-account");
  assert.equal(quota.groups.length, 3);
  assert.equal(quota.groups[0].primary.usedPercent, 20);
  assert.equal(quota.groups[0].secondary.usedPercent, 30);
  assert.equal(quota.groups[2].secondary.usedPercent, 20);
  assert.equal(quota.groups[2].primary, null);
  assert.equal(quota.groups[2].paceAdvice.longWindow.remainingPercent, 80);
  assert.equal(quota.groups[0].secondary.resetsAt, null);
  assert.equal(quota.groups[0].paceAdvice.longWindow.idealRemainingPercent, null);
  assert.ok(quota.groups[0].secondary.nextFreedAt);
  assert.equal(windowLabels(quota.groups[2]).secondary, "手動本期");
  assert.equal(windowLabels(quota.groups[2], "en").secondary, "Manual period");
  const changed = structuredClone(fixture); changed.usageMeter.roostRolling.window5hUsd = -1;
  assert.throws(() => normalizeAccount(changed, token), /無效/);
  changed.usageMeter.roostRolling.window5hUsd = null;
  assert.throws(() => normalizeAccount(changed, token), /無效/);
  assert.throws(() => normalizeAccount({ ...fixture, usageMeter: null }, token), /未提供/);
  assert.throws(() => normalizeAccount({ ...fixture, session: { ...fixture.session, userId: "other" } }, token), /不符/);
  const zero = structuredClone(fixture); zero.usageMeter.roostRolling.window5hUsd = 0;
  assert.equal(normalizeAccount(zero, token).primary.usedPercent, 0);
  const starter = structuredClone(fixture); starter.session = { planCode: "starter" }; starter.usageMeter = { monthlyUsd: 5 };
  assert.equal(normalizeAccount(starter, token).secondary.usedPercent, 25);
  const noCaps = structuredClone(fixture); noCaps.session = {}; noCaps.usageMeter = {};
  assert.throws(() => normalizeAccount(noCaps, token), /不以 0%/);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(createQuotaService({ readToken: () => credential(), fetchImpl: async () => ({ ok: false, status }) }).getQuota(), status < 404 ? /authentication required/ : /HTTP/);
  }
  await assert.rejects(createQuotaService({ readToken: () => credential(), fetchImpl: async () => { throw Error("synthetic-access must not leak"); } }).getQuota(), error => !error.message.includes("synthetic-access"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perch-quota-unit-"));
  try {
    const account = createAccountService({ readToken: () => credential(), quotaService: service });
    await fs.writeFile(path.join(dir, "quota-cache.json"), "stale");
    await account.configure(dir);
    await assert.rejects(fs.access(path.join(dir, "quota-cache.json")));
    assert.equal(await account.hasSession(), true);
    await account.getQuota(); await account.logout();
    assert.equal(await account.hasSession(), false);
    await assert.rejects(account.getQuota(), /authentication required/);
    const restarted = createAccountService({ readToken: () => credential(), quotaService: service });
    await restarted.configure(dir); assert.equal(await restarted.hasSession(), false);
    await restarted.login(); assert.equal(await restarted.hasSession(), true);
    await restarted.getQuota();
    const broken = createAccountService({ readToken: async () => { throw Error("logged out"); } });
    await fs.writeFile(path.join(dir, "quota-cache.json"), "stale");
    await broken.configure(dir); await assert.rejects(fs.access(path.join(dir, "quota-cache.json")));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  console.log("Verified Perch credential isolation, official host restriction, rolling/period quotas, unknown and invalid data, no invented reset pace, HTTP failures, connection persistence and stale-cache invalidation.");
})().catch(error => { console.error(error); process.exitCode = 1; });
