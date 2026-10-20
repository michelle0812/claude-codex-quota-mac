"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_TOKEN_FILE, QUOTA_GROUPS, quotaGroup, readCredential, createQuotaService } = require("./quota-service");

// Only an explicitly selected file or exact AGY Keychain entry is read. Never
// export credentials, search unrelated entries, refresh, or change AGY login.
function createAccountService({ selectSource, selectFile, readToken = readCredential, quotaService = createQuotaService() } = {}) {
  let directory;
  let binding = { version: 1, tokenFile: null, keychainAccount: null, accountId: null, group: "gemini" };
  const sourceFor = (value) => value.keychainAccount ? { type: "keychain", account: value.keychainAccount } : value.tokenFile;
  const configurationFile = () => path.join(directory, "agy-account.json");
  async function save(next) {
    const file = configurationFile(), temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
      binding = next;
    } finally { await fs.rm(temp, { force: true }); }
  }
  return {
    async configure(userDataPath) {
      directory = userDataPath;
      let valid = false;
      try {
        const data = JSON.parse(await fs.readFile(configurationFile(), "utf8"));
        quotaGroup(data.group);
        const keychainAccount = data.keychainAccount ?? null;
        const hasIdentity = typeof data.accountId === "string" && /^[a-f0-9]{64}$/.test(data.accountId);
        if (data.version !== 1 || !((data.tokenFile === null && keychainAccount === null && data.accountId === null)
          || (typeof data.tokenFile === "string" && path.isAbsolute(data.tokenFile) && keychainAccount === null && hasIdentity)
          || (data.tokenFile === null && keychainAccount === "antigravity" && hasIdentity))) {
          throw new Error("invalid account configuration");
        }
        binding = { version: 1, tokenFile: data.tokenFile, keychainAccount, accountId: data.accountId, group: data.group };
        valid = true;
      } catch (error) {
        if (error.code !== "ENOENT") console.warn("Google 面板帳號設定無效，請重新連接 AGY。 ");
      }
      // Old builds cached unverified statusLine data. Do not display it after
      // migration or reuse it in a disconnected panel.
      if (!valid || !binding.accountId) {
        await Promise.all(["quota-cache.json", "quota-history.json"].map((name) => fs.rm(path.join(directory, name), { force: true })));
      } else {
        // A removed/replaced credential must not revive another account's cache.
        try {
          const credential = await readToken(sourceFor(binding));
          if (credential.accountId !== binding.accountId) throw new Error("account changed");
          const cache = JSON.parse(await fs.readFile(path.join(directory, "quota-cache.json"), "utf8"));
          if (cache?.quota?.account?.id !== binding.accountId || cache?.quota?.limitId !== `google:${binding.group}`) {
            throw new Error("cache belongs to a different account or quota group");
          }
        } catch {
          await Promise.all(["quota-cache.json", "quota-history.json"].map((name) => fs.rm(path.join(directory, name), { force: true })));
        }
      }
    },
    async hasSession() {
      if (!sourceFor(binding) || !binding.accountId) return false;
      try { return (await readToken(sourceFor(binding))).accountId === binding.accountId; }
      catch { return false; }
    },
    async login() {
      const options = { defaultPath: binding.tokenFile || DEFAULT_TOKEN_FILE };
      let selected;
      if (selectSource) selected = await selectSource(options);
      else { const file = await selectFile(options); selected = file ? { type: "file", path: file } : null; }
      if (!selected) return { cancelled: true };
      if (selected.type !== "file" && selected.type !== "keychain") throw new Error("AGY 登入來源無效。");
      if (selected.type === "file" && (typeof selected.path !== "string" || !selected.path)) throw new Error("AGY 憑證路徑無效。");
      const next = { ...binding, tokenFile: selected.type === "file" ? path.resolve(selected.path) : null,
        keychainAccount: selected.type === "keychain" ? "antigravity" : null };
      const credential = await readToken(sourceFor(next));
      await save({ ...next, accountId: credential.accountId });
      return { email: credential.email };
    },
    async logout() {
      await save({ ...binding, tokenFile: null, keychainAccount: null, accountId: null });
    },
    async getOptions() {
      let email = null;
      if (sourceFor(binding)) {
        try {
          const credential = await readToken(sourceFor(binding));
          if (credential.accountId === binding.accountId) email = credential.email;
        } catch { /* status and refresh report the error */ }
      }
      return { group: binding.group, groups: QUOTA_GROUPS.map(({ id, label }) => ({ id, label })), email };
    },
    async setOptions(value) {
      if (!value || typeof value !== "object") throw new Error("Google 額度選項無效。");
      quotaGroup(value.group);
      await save({ ...binding, group: value.group });
      return this.getOptions();
    },
    getQuota() { return quotaService.getQuota({ ...binding }); }
  };
}
module.exports = { createAccountService };
