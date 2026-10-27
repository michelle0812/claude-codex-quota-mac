"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
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
  return { errors, close: () => socket.close(), capture: async () => (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, eval: async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } };
}

async function smoke() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "perch-quota-ui-"));
  const clients = [];
  let child, output = "";
  try {
    await fs.writeFile(path.join(directory, "widget-settings.json"), JSON.stringify({ signal: { autoUpdateCheck: false } }));
    const sourceRoot = process.argv[3] ? path.join(path.resolve(process.argv[3]), "Contents/Resources/app.asar/src") : path.resolve(__dirname, "../src");
    const mainFile = path.join(sourceRoot, "main/main.js");
    const serviceFile = path.join(sourceRoot, "main/quota-service.js");
    const fixture = path.resolve(__dirname, "fixtures/account.json");
    const wrapper = path.join(directory, "main.cjs");
    await fs.writeFile(wrapper, `
const {app}=require('electron');
const testFs=require('node:fs');
setInterval(()=>{if(testFs.existsSync(${JSON.stringify(path.join(directory, 'quit'))}))app.quit();},200).unref();
app.setPath('userData',${JSON.stringify(directory)});
const service=require(${JSON.stringify(serviceFile)});
service.readCredential=async()=>({userId:'synthetic-user',accountId:'synthetic-account',email:'test@example.test',accessToken:'synthetic-access'});
globalThis.fetch=async(url,opts)=>{
 if(url!=='https://app.perchai.app/api/perchai/account'||opts.headers.Authorization!=='Bearer synthetic-access')throw Error('Unexpected network request');
 return {ok:true,json:async()=>{
   const data=structuredClone(require(${JSON.stringify(fixture)}));
   for(const key of ['roostRolling','manualRolling']){
     data.usageMeter[key].window5hNextFreedAt=new Date(Date.now()+2*3600000).toISOString();
     data.usageMeter[key].window7dNextFreedAt=new Date(Date.now()+5*86400000).toISOString();
   }
   return data;
 }};
};
app.whenReady().then(()=>{const timer=setTimeout(()=>app.quit(),55000);timer.unref();});
require(${JSON.stringify(mainFile)});
`);
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const executable = process.argv[2] || path.resolve(__dirname, "../../codex/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    if (path.basename(executable) !== "Electron") throw Error("請使用通用 Electron runtime；品牌 App 會忽略隔離測試入口。");
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [wrapper, `--user-data-dir=${directory}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-12000); });
    child.on("error", error => { output += error.message; });
    await until(async () => {
      if (child.exitCode !== null || child.signalCode) throw Error(`Electron exited: ${output}`);
      try { return (await fetch(`http://127.0.0.1:${port}/json/list`)).ok; } catch { return false; }
    }, "Debugger did not start");
    const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const main = await connect(await until(async () => (await targets()).find(t => t.url.includes("renderer.html")), "Renderer missing")); clients.push(main);
    await until(() => main.eval("state.snapshot?.status==='ready' && document.querySelector('#quotaGroupName').textContent==='Roost'"), "Perch quota not ready");
    assert.equal(await main.eval("state.quota.account.id"), "synthetic-account", "Isolation failed: refuse to operate on a real account");
    assert.equal(await main.eval("document.querySelector('#remaining').textContent"), "20%");
    assert.equal(await main.eval("document.querySelector('#secondaryText').textContent.startsWith('30%')"), true);
    assert.equal(await main.eval("state.quota.paceAdvice.longWindow.idealRemainingPercent"), null);
    assert.equal(await main.eval("document.querySelector('#liquidMeter').title.includes('額度類別')"), true);
    const captures = path.resolve(__dirname, "../dist"); await fs.mkdir(captures, { recursive: true });
    for (const name of ["Roost", "Manual", "本期 PT"]) {
      assert.equal(await main.eval("document.querySelector('#quotaGroupName').textContent"), name);
      assert.ok(await main.eval("document.querySelector('footer').getBoundingClientRect().bottom<=innerHeight"));
      assert.ok(await main.eval("['paceTitle','quotaGroupName','paceBadge'].map(id=>document.getElementById(id).getBoundingClientRect()).every((r,i,a)=>r.left>=0&&r.right<=innerWidth&&(!i||r.left>=a[i-1].right))"), "Heading overlaps");
      if (name === "本期 PT") {
        assert.equal(await main.eval("document.querySelector('#primaryLabel').textContent"), "帳號本期");
        assert.equal(await main.eval("document.querySelector('#secondaryLabel').textContent"), "手動本期");
        assert.equal(await main.eval("document.querySelector('#weeklyPaceLabel').textContent"), "本期用量");
        assert.ok(await main.eval("document.querySelector('#liquidMeter').title.includes('15,000 / 75,000 PT')"));
        await main.eval("document.querySelector('#langBtn').click();true");
        assert.equal(await main.eval("document.querySelector('#secondaryLabel').textContent"), "Manual period");
        await main.eval("document.querySelector('#langBtn').click();true");
      }
      await sleep(250);
      await fs.writeFile(path.join(captures, `perch-${name === "本期 PT" ? "period" : name.toLowerCase()}-preview.png`), Buffer.from(await main.capture(), "base64"));
      await main.eval("document.querySelector('#liquidMeter').click();true");
    }
    await main.eval("document.querySelector('#liquidMeter').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true");
    assert.equal(await main.eval("document.querySelector('#quotaGroupName').textContent"), "Manual");
    await main.eval("window.quotaBridge.refreshQuota()");
    assert.equal(await main.eval("document.querySelector('#quotaGroupName').textContent"), "Manual");
    await main.eval("location.reload();true");
    await until(() => main.eval("document.readyState==='complete'&&document.querySelector('#quotaGroupName').textContent==='Manual'"), "Selection lost on reload");
    await main.eval("window.quotaBridge.setCompactMode(true)");
    await until(() => main.eval("state.compact===true"), "Compact mode missing");
    assert.equal(await main.eval("document.querySelector('#compactShortText').textContent"), "20%");
    assert.equal(await main.eval("document.querySelector('#compactWeeklyText').textContent"), "30%");
    assert.notEqual(await main.eval("document.querySelector('#compactWeeklyResetText').textContent"), "--");
    await main.eval("window.quotaBridge.setCompactMode(false)");
    await main.eval("window.quotaBridge.openSettings()");
    const settings = await connect(await until(async () => (await targets()).find(t => t.url.includes("settings.html")), "Settings missing")); clients.push(settings);
    await until(() => settings.eval("document.readyState==='complete' && !!document.querySelector('#authField .account-actions button:nth-child(2)') && !document.querySelector('#authField .account-actions button:nth-child(2)').hidden"), "Account controls unavailable");
    assert.equal(await settings.eval("document.querySelector('#authField .account-actions button:nth-child(1)').textContent"), "連接本機 Perch CLI");
    await settings.eval("document.querySelector('#authField .account-actions button:nth-child(2)').click();true");
    await until(() => main.eval("state.snapshot.status==='error'&&state.quota===null"), "Disconnect kept stale quota");
    await settings.eval("document.querySelector('#authField .account-actions button:nth-child(1)').click();true");
    await until(() => main.eval("state.snapshot.status==='ready'&&state.quota.groups.length===3"), "Reconnect failed");
    assert.deepEqual(main.errors, []); assert.deepEqual(settings.errors, []);
    console.log("Verified Perch UI: three quota categories, percentages, rolling release semantics, billing labels, mouse/keyboard switching, refresh/reload persistence, disconnect/reconnect, layout and renderer errors.");
    console.log(`Synthetic previews: ${captures}`);
  } catch (error) { throw Error(`${error.stack}\n${output}`); }
  finally {
    for (const client of clients) client.close();
    // Ask the isolated app to quit through its test-only sentinel, without
    // stopping any installed application or touching real user data.
    if (child && child.exitCode === null) {
      await fs.writeFile(path.join(directory, "quit"), "quit");
      await Promise.race([once(child, "exit"), sleep(3000)]);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
smoke().catch(error => { console.error(error.message); process.exitCode = 1; });
