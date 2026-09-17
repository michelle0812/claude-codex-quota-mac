// 齒輪裡的 ChatGPT 登入：PKCE、authorize 網址參數、callback 解析、auth.json 格式、登出改名。
// 參數要跟 Codex CLI 的瀏覽器登入一致（codex-cli 0.154.0 login/src/server.rs）。

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  REDIRECT_URI,
  createCodexAuth,
  createPkce,
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

(async () => {
  verifyPkce();
  verifyAuthorizeUrl();
  verifyParseCallback();
  verifyAuthJson();
  await verifySessionAndLogout();
  console.log("Verified Codex auth: PKCE, authorize URL params, callback parsing, auth.json shape, and logout rename.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
