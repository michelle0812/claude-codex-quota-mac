// 齒輪裡的 ChatGPT 登入：PKCE、authorize 網址參數、callback 解析、auth.json 格式、登出改名。
// 參數要跟 Codex CLI 的瀏覽器登入一致（codex-cli 0.154.0 login/src/server.rs）。

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {
  REDIRECT_URI,
  createCodexAuth,
  createPkce,
  captureAuthorizationCode,
  buildAuthorizeUrl,
  parseCallbackUrl,
  buildAuthJson
} = require("../src/main/codex-auth-service");

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verifyPkce() {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  assert.notEqual(createPkce().verifier, verifier);
}

function verifyAuthorizeUrl() {
  const url = new URL(buildAuthorizeUrl({ challenge: "CHAL", state: "STATE" }));
  assert.equal(`${url.origin}${url.pathname}`, "https://auth.openai.com/oauth/authorize");
  const q = url.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(q.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.ok(q.get("scope").split(" ").includes("offline_access"), "沒有 offline_access 就拿不到 refresh_token");
  assert.equal(q.get("code_challenge"), "CHAL");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("id_token_add_organizations"), "true");
  assert.equal(q.get("codex_cli_simplified_flow"), "true");
  assert.equal(q.get("state"), "STATE");
}

function verifyParseCallback() {
  assert.equal(parseCallbackUrl("https://auth.openai.com/log-in", "S"), null);
  assert.equal(parseCallbackUrl("http://localhost:1455/favicon.ico", "S"), null);
  assert.equal(parseCallbackUrl(`${REDIRECT_URI}?code=abc&state=S`, "S"), "abc");
  assert.throws(() => parseCallbackUrl(`${REDIRECT_URI}?code=abc&state=X`, "S"), /state 不符/);
  assert.throws(() => parseCallbackUrl(`${REDIRECT_URI}?error=access_denied&state=S`, "S"), /access_denied/);
  assert.throws(() => parseCallbackUrl(`${REDIRECT_URI}?state=S`, "S"), /沒有 code/);
}

function verifyAuthJson() {
  const idToken = `${base64url({ alg: "none" })}.${base64url({
    email: "a@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" }
  })}.sig`;
  const now = new Date("2026-09-17T12:00:00.000Z");
  const json = buildAuthJson({ id_token: idToken, access_token: "AT", refresh_token: "RT" }, now);
  // 跟 `codex login` 寫出來的 auth.json 同一組欄位，Codex CLI 才讀得懂。
  assert.deepEqual(Object.keys(json).sort(), ["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"]);
  assert.equal(json.auth_mode, "chatgpt");
  assert.equal(json.OPENAI_API_KEY, null);
  assert.deepEqual(json.tokens, { id_token: idToken, access_token: "AT", refresh_token: "RT", account_id: "acct-123" });
  assert.equal(json.last_refresh, "2026-09-17T12:00:00.000Z");
}

async function verifySessionAndLogout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  const authFilePath = path.join(dir, "auth.json");
  const auth = createCodexAuth({ authFilePath, profileName: "測試" });
  try {
    assert.equal(await auth.hasSession(), false);
    fs.writeFileSync(authFilePath, JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
    assert.equal(await auth.hasSession(), true);

    await auth.logout();
    assert.equal(await auth.hasSession(), false);
    assert.equal(fs.existsSync(authFilePath), false);
    const kept = fs.readdirSync(dir).filter((name) => name.startsWith("auth.json.logout-"));
    assert.equal(kept.length, 1, "登出要把舊登入檔改名保留，不是刪掉");

    await auth.logout(); // 已登出再登出不能炸
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function verifyBrowserCallback() {
  // 真正走 loopback HTTP，但不開瀏覽器、不連外、不使用真實帳號。
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const options = { authorizeUrl: "https://auth.openai.com/", state: "S", port, timeoutMs: 2000 };
  let browserChecks;
  const result = captureAuthorizationCode({ ...options, openExternal: (url) => {
    browserChecks = (async () => {
      assert.equal(url, options.authorizeUrl);
      const wrong = await fetch(`${base}/auth/callback?code=wrong&state=old`);
      assert.equal(wrong.status, 400);
      await wrong.text();
      const missing = await fetch(`${base}/favicon.ico`);
      assert.equal(missing.status, 404);
      await missing.text();
      const valid = await fetch(`${base}/auth/callback?code=correct&state=S`);
      assert.equal(valid.status, 200);
      assert.match(await valid.text(), /回到 Codex/);
    })();
    return browserChecks;
  } });
  assert.equal(await result, "correct");
  await browserChecks;
  await assert.rejects(captureAuthorizationCode({ ...options, openExternal: () => {
    throw new Error("browser unavailable");
  } }), /無法開啟系統瀏覽器/);
  await assert.rejects(captureAuthorizationCode({ ...options, timeoutMs: 30, openExternal: () => {} }), /逾時/);
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(port, "127.0.0.1", resolve));
  try {
    await assert.rejects(captureAuthorizationCode({ ...options, openExternal: () => {
      assert.fail("埠被占用時不應開啟瀏覽器");
    } }), /已被占用/);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
}

(async () => {
  verifyPkce();
  verifyAuthorizeUrl();
  verifyParseCallback();
  verifyAuthJson();
  await verifySessionAndLogout();
  await verifyBrowserCallback();
  console.log("Verified Codex auth: PKCE, authorize URL params, callback parsing, auth.json shape, and logout rename.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
