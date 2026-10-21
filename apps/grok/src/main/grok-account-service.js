"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_GROK_HOME, readAuth, getQuota } = require("./quota-service");

function createGrokAccountService({ grokHome = DEFAULT_GROK_HOME } = {}) {
  let directory = null;
  let binding = { version: 1, accountId: null, email: null, grokHome: null };

  const configurationFile = () => path.join(directory, "grok-account.json");

  async function save(next) {
    if (!directory) return;
    const file = configurationFile();
    const temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
      binding = next;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  return {
    async configure(userDataPath) {
      directory = userDataPath;
      binding = { version: 1, accountId: null, email: null, grokHome: null };
      try {
        const data = JSON.parse(await fs.readFile(configurationFile(), "utf8"));
        if (data && data.version === 1) {
          binding = data;
        }
      } catch {
        // First run or not configured yet
      }

      // Automatically auto-bind if ~/.grok/auth.json exists
      try {
        const auth = await readAuth(binding.grokHome || grokHome);
        if (!binding.accountId) {
          await save({
            version: 1,
            accountId: auth.accountId,
            email: auth.email,
            grokHome: binding.grokHome || null
          });
        }
      } catch {
        // Not signed in to grok yet
      }
    },

    async hasSession() {
      try {
        const auth = await readAuth(binding.grokHome || grokHome);
        return Boolean(auth.token);
      } catch {
        return false;
      }
    },

    async login() {
      try {
        const auth = await readAuth(binding.grokHome || grokHome);
        await save({
          version: 1,
          accountId: auth.accountId,
          email: auth.email,
          grokHome: binding.grokHome || null
        });
        return { email: auth.email };
      } catch (error) {
        throw new Error(`無法連接本機 Grok 帳號：${error.message}`);
      }
    },

    async logout() {
      await save({ version: 1, accountId: null, email: null, grokHome: null });
    },

    async getOptions() {
      let email = null;
      let name = null;
      try {
        const auth = await readAuth(binding.grokHome || grokHome);
        email = auth.email;
        name = auth.firstName;
      } catch {
        // Ignore
      }
      return { email, name };
    },

    async setOptions(value) {
      if (!value || typeof value !== "object") throw new Error("Grok 額度選項無效。");
      await save({ ...binding, ...value });
      return this.getOptions();
    },

    async getQuota() {
      return getQuota({ grokHome: binding.grokHome || grokHome });
    }
  };
}

module.exports = {
  createGrokAccountService
};
