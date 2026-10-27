"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { readCredential, createQuotaService } = require("./quota-service");

function createAccountService({ readToken = readCredential, quotaService = createQuotaService({ readToken }) } = {}) {
  let directory, connected = true, accountId = null;
  const file = () => path.join(directory, "perch-account.json");
  const clearCache = () => Promise.all(["quota-cache.json", "quota-history.json"].map(name => fs.rm(path.join(directory, name), { force: true })));
  async function save(enabled, id = null) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file(), JSON.stringify({ version: 1, connected: enabled, accountId: id }), { mode: 0o600 });
    connected = enabled; accountId = id;
  }
  return {
    async configure(dir) {
      directory = dir;
      try {
        const saved = JSON.parse(await fs.readFile(file(), "utf8"));
        if (saved.version !== 1 || typeof saved.connected !== "boolean") throw Error("invalid");
        connected = saved.connected; accountId = saved.accountId;
      } catch (error) { if (error.code !== "ENOENT") connected = false; }
      // A cached quota must never survive CLI logout, account switch or expiry.
      try {
        const token = await readToken();
        if (!connected || token.accountId !== accountId) await clearCache();
      } catch { await clearCache(); }
    },
    async hasSession() { if (!connected) return false; try { await readToken(); return true; } catch { return false; } },
    async login() { const token = await readToken(); await clearCache(); await save(true, token.accountId); return { email: token.email }; },
    async logout() { await save(false); await clearCache(); },
    async getQuota() {
      if (!connected) throw Error("Perch authentication required：請按齒輪連接本機 Perch CLI。");
      const quota = await quotaService.getQuota();
      if (accountId !== quota.account.id) { await clearCache(); await save(true, quota.account.id); }
      return quota;
    }
  };
}
module.exports = { createAccountService };
