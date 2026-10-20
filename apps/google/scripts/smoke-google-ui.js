"use strict";

// Run the packaged renderer/IPC with synthetic credentials in an isolated,
// hidden Electron instance. No installed App or real AGY login is touched.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const { readCredential } = require("../src/main/quota-service");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(run, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await run();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(message);
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), errors = [];
  let id = 0;
  await once(socket, "open");
  socket.addEventListener("message", event => {
    const data = JSON.parse(event.data);
    if (data.method === "Runtime.exceptionThrown") errors.push(data.params.exceptionDetails.text);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id); pending.delete(data.id);
      if (data.error) reject(Error(data.error.message)); else resolve(data.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id; pending.set(request, { resolve, reject }); socket.send(JSON.stringify({ id: request, method, params }));
  });
  await send("Runtime.enable");
  return { errors, close: () => socket.close(), eval: async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } };
}
async function smoke(bundle) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "google-quota-ui-"));
  let child; const clients = []; let stderr = "";
  try {
    const tokenFile = path.join(directory, "synthetic-agy-token");
    const jwt = `header.${Buffer.from(JSON.stringify({ sub: "smoke-account", email: "smoke@example.test" })).toString("base64url")}.signature`;
    const tokenBytes = JSON.stringify({ token: { access_token: "smoke-access-token", refresh_token: "smoke-refresh-token", expiry: "2030-01-01T01:00:00Z" }, id_token: jwt });
    await fs.writeFile(tokenFile, tokenBytes, { mode: 0o600 });
    const { accountId } = await readCredential(tokenFile);
    await fs.writeFile(path.join(directory, "agy-account.json"), JSON.stringify({ version: 1, tokenFile, accountId, group: "gemini" }));
    await fs.writeFile(path.join(directory, "widget-settings.json"), JSON.stringify({ autoUpdateCheck: false }));
    const wrapper = path.join(directory, "test-main.cjs");
    const fixture = path.resolve(__dirname, "fixtures/quota-summary.json");
    await fs.writeFile(wrapper, `
const {app,BrowserWindow,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(directory)});
for(const name of ['show','showInactive','focus']) BrowserWindow.prototype[name]=function(){};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(tokenFile)}]});
dialog.showMessageBox=async()=>({response:0});
const cp=require('node:child_process'),util=require('node:util');
const originalRun=util.promisify(cp.execFile);
function scopedExec(...args){return cp.execFileOriginal(...args);}
cp.execFileOriginal=cp.execFile;
scopedExec[util.promisify.custom]=async(command,args,options)=>{
 if(command==='/usr/bin/security'){
  if(JSON.stringify(args)!==JSON.stringify(['find-generic-password','-s','gemini','-a','antigravity','-w'])) throw Error('Unexpected Keychain access');
  return {stdout:'go-keyring-base64:'+Buffer.from(${JSON.stringify(tokenBytes)}).toString('base64')};
 }
 return originalRun(command,args,options);
};
cp.execFile=scopedExec;

globalThis.fetch=async(url)=>{
 if(url.endsWith(':loadCodeAssist')) return new Response(JSON.stringify({cloudaicompanionProject:'smoke-project',paidTier:{name:'Smoke plan'}}));
 if(url.endsWith(':retrieveUserQuotaSummary')) return new Response(JSON.stringify(require(${JSON.stringify(fixture)})));
 throw Error('Unexpected network request in smoke test');
};
app.whenReady().then(()=>{ const timer=setTimeout(()=>app.quit(),30000);timer.unref(); });
require(${JSON.stringify(path.join(bundle, "Contents/Resources/app.asar/src/main/main.js"))});
`);
    let runtime = path.resolve(__dirname, "../node_modules/electron/dist/Electron.app");
    try { await fs.access(path.join(runtime, "Contents/Frameworks/Electron Framework.framework/Electron Framework")); }
    catch {
      // A previous development attempt left a thin/incomplete runtime. Use the
      // official cached distribution without modifying that installation.
      const archive = path.join(os.homedir(), "Library/Caches/electron/electron-v31.7.7-darwin-arm64.zip");
      const extracted = path.join(directory, "test-runtime");
      execFileSync("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
      runtime = path.join(extracted, "Electron.app");
    }
    const executable = path.join(runtime, "Contents/MacOS/Electron");
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const debugPort = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    child = spawn(executable, [wrapper, `--user-data-dir=${directory}`, `--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-12000); });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-12000); });
    child.on("error", error => { stderr += error.message; });
    console.log("Starting isolated packaged UI smoke test...");
    const port = await until(async () => {
      if (child.exitCode !== null || child.signalCode) throw Error(`Test Electron exited (${child.exitCode}, ${child.signalCode}): ${stderr}`);
      try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`); return r.ok && debugPort; } catch { return null; }
    }, "No test debugger (inspect Electron stderr)");
    const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const mainTarget = await until(async () => (await targets()).find(t => t.url.includes("renderer.html")), "Main renderer not loaded");
    const main = await connect(mainTarget); clients.push(main);
    const getState = () => main.eval("window.quotaBridge.getQuotaState()");
    const initial = await until(async () => { const s = await getState(); return s.status === "ready" && s; }, "Initial quota did not become ready");
    assert.equal(initial.quota.limitId, "google:gemini"); assert.equal(initial.quota.primary.usedPercent, 10);
    await main.eval("window.quotaBridge.openSettings()");
    const settingsTarget = await until(async () => (await targets()).find(t => t.url.includes("settings.html")), "Settings not loaded");
    const settings = await connect(settingsTarget); clients.push(settings);
    await until(() => settings.eval("document.querySelector('#quotaGroup')?.options.length === 2 && !document.querySelector('#quotaGroup').disabled"), "Quota group selector unavailable");
    assert.equal(await settings.eval("document.querySelector('#quotaGroup').value"), "gemini");
    assert.equal(await settings.eval("[...document.querySelectorAll('#authField button')].find(b=>b.textContent==='中斷連接')?.hidden"), false);
    assert.ok(await settings.eval("document.querySelector('#authField').textContent.includes('smoke@example.test')"));
    await settings.eval("document.querySelector('#quotaGroup').value='third-party';document.querySelector('#quotaGroup').dispatchEvent(new Event('change',{bubbles:true}));true");
    const changed = await until(async () => { const s = await getState(); return s.status === "ready" && s.quota?.limitId === "google:third-party" && s; }, "Group change did not reach the quota reader");
    assert.equal(changed.quota.primary.usedPercent, 60); assert.equal(changed.quota.secondary.usedPercent, 80);
    await settings.eval("[...document.querySelectorAll('#authField button')].find(b=>b.textContent==='中斷連接').click();true");
    await until(async () => { const s = await getState(); return s.status === "error" && s.quota === null; }, "Disconnect kept old quota");
    await settings.eval("[...document.querySelectorAll('#authField button')].find(b=>b.textContent==='連接 AGY 帳號').click();true");
    await until(async () => { const s = await getState(); return s.status === "ready" && s.quota?.limitId === "google:third-party"; }, "Reconnect did not restore the chosen group");
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "agy-account.json"), "utf8")).keychainAccount, "antigravity");
    assert.equal(await fs.readFile(tokenFile, "utf8"), tokenBytes);
    assert.deepEqual(main.errors, []); assert.deepEqual(settings.errors, []);
    console.log("Verified packaged Google UI: preload, authenticated startup, group selector, IPC quota switch, disconnect clears quota, reconnect, and no renderer exceptions.");
  } catch (error) {
    throw new Error(`${error.message}\nElectron output: ${stderr}`);
  } finally {
    for (const client of clients) client.close();
    if (child && child.exitCode === null) {
      const ended = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([ended, sleep(3000)]);
      if (child.exitCode === null) { child.kill("SIGKILL"); await Promise.race([ended, sleep(3000)]); }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
if (!process.argv[2]) { console.error("Usage: node smoke-google-ui.js /path/to/staged.app"); process.exitCode = 1; }
else smoke(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
