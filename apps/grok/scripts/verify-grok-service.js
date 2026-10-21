"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readAuth, getQuota, normalizeSnapshot } = require("../src/main/quota-service");
const { createGrokAccountService } = require("../src/main/grok-account-service");

async function testSnapshotNormalization() {
  const snapshot = {
    limitId: "grok-context",
    limitName: "Grok (grok-4.7)",
    planType: "Grok Build",
    primary: {
      usedPercent: 45,
      windowDurationMins: null,
      resetsAt: "2026-10-21T18:00:00Z"
    },
    secondary: {
      usedPercent: 20,
      windowDurationMins: 1440,
      resetsAt: "2026-10-21T18:00:00Z"
    }
  };

  const normalized = normalizeSnapshot(snapshot);
  assert.equal(normalized.limitId, "grok-context");
  assert.equal(normalized.limitName, "Grok (grok-4.7)");
  assert.equal(normalized.primary.usedPercent, 45);
  assert.equal(normalized.primary.remainingPercent, 55);
  assert.equal(normalized.secondary.usedPercent, 20);
  assert.equal(normalized.secondary.remainingPercent, 80);
  assert.ok(normalized.paceAdvice);
}

async function testLiveOrMockGrokHome() {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "grok-test-home-"));
  try {
    const mockAuth = {
      "https://auth.x.ai::mock": {
        key: "mock-jwt-token",
        email: "mock-tester@example.com",
        first_name: "MockUser",
        user_id: "mock-user-uuid",
        expires_at: "2026-10-22T00:00:00Z"
      }
    };
    await fs.writeFile(path.join(tmpHome, "auth.json"), JSON.stringify(mockAuth, null, 2));

    const auth = await readAuth(tmpHome);
    assert.equal(auth.email, "mock-tester@example.com");
    assert.equal(auth.firstName, "MockUser");
    assert.equal(auth.token, "mock-jwt-token");
    assert.ok(auth.accountId);

    // Test with mock session
    const mockSessionDir = path.join(tmpHome, "sessions", "mock_cwd", "sess-1");
    await fs.mkdir(mockSessionDir, { recursive: true });
    await fs.writeFile(
      path.join(mockSessionDir, "signals.json"),
      JSON.stringify({
        contextWindowUsage: 55,
        contextTokensUsed: 140800,
        contextWindowTokens: 256000,
        primaryModelId: "grok-4.7"
      })
    );
    await fs.writeFile(
      path.join(mockSessionDir, "usage.json"),
      JSON.stringify({
        session: {
          totalTokens: 1500000,
          costUsdTicks: 5000000000
        }
      })
    );

    const quota = await getQuota({ grokHome: tmpHome });
    assert.equal(quota.limitId, "grok-context");
    assert.equal(quota.primary.usedPercent, 55);
    assert.equal(quota.primary.remainingPercent, 45);
    assert.equal(quota.account.email, "mock-tester@example.com");
    assert.equal(quota.account.name, "MockUser");

    // Test Account Service
    const svc = createGrokAccountService({ grokHome: tmpHome });
    const tmpUserDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-user-data-"));
    try {
      await svc.configure(tmpUserDir);
      assert.equal(await svc.hasSession(), true);
      const options = await svc.getOptions();
      assert.equal(options.email, "mock-tester@example.com");
      assert.equal(options.name, "MockUser");

      const svcQuota = await svc.getQuota();
      assert.equal(svcQuota.primary.usedPercent, 55);
    } finally {
      await fs.rm(tmpUserDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }
}

async function run() {
  await testSnapshotNormalization();
  await testLiveOrMockGrokHome();
  console.log("[verify-grok-service] All tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
