"use strict";
const bridge = window.quotaBridge, $ = id => document.getElementById(id);
let signal;
function fail(error) { $("message").textContent = error?.message || String(error); $("message").title = $("message").textContent; }
async function status() {
  const connected = await bridge.getAuthStatus(), options = await bridge.getAuthOptions();
  $("account").textContent = connected ? `已連接${options.email ? ` · ${options.email}` : "本機 AGY"}` : "請先登入 AGY，再連接此面板。";
  $("connect").hidden = connected; $("disconnect").hidden = !connected;
}
$("connect").addEventListener("click", async () => {
  $("connect").disabled = true;
  try { const result = await bridge.login(); await status(); if (!result?.cancelled) $("message").textContent = "已連接，正在同步三組用量"; }
  catch (error) { fail(error); } finally { $("connect").disabled = false; }
});
$("disconnect").addEventListener("click", async () => {
  $("disconnect").disabled = true;
  try { await bridge.logout(); await status(); $("message").textContent = "已中斷面板連接，AGY 登入保留"; }
  catch (error) { fail(error); } finally { $("disconnect").disabled = false; }
});
async function save() {
  if (!signal) return;
  signal = await bridge.setSignalSettings({ ...signal, quotaRefreshMs: Number($("refreshMinutes").value) * 60000, autoUpdateCheck: $("autoUpdate").checked });
  $("message").textContent = "已儲存";
}
$("refreshMinutes").addEventListener("change", () => save().catch(fail));
$("autoUpdate").addEventListener("change", () => save().catch(fail));
$("done").addEventListener("click", () => bridge.closeSettings().catch(fail));
bridge.getSignalSettings().then(value => {
  signal = value; const minutes = String(Math.round(value.quotaRefreshMs / 60000));
  if (![...$("refreshMinutes").options].some(option => option.value === minutes)) {
    const option = document.createElement("option"); option.value = minutes; option.textContent = `每 ${minutes} 分鐘`; $("refreshMinutes").append(option);
  }
  $("refreshMinutes").value = minutes; $("autoUpdate").checked = value.autoUpdateCheck;
}).catch(fail);
bridge.onAuthStatusChanged(() => status().catch(fail)); status().catch(fail);
