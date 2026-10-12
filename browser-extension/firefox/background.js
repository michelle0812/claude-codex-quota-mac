"use strict";
const api = chrome;
const invoke = (object, method, ...args) => new Promise((resolve, reject) => {
  object[method](...args, (value) => {
    const error = api.runtime.lastError;
    if (error) reject(new Error("browser bridge unavailable")); else resolve(value);
  });
});
let busy = false;
async function publishAll(preferredTab) {
  if (busy) return;
  busy = true;
  try {
    const { bindings = {} } = await invoke(api.storage.local, "get", "bindings");
    if (!Object.keys(bindings).length) return;
    const tabs = await invoke(api.tabs, "query", { url: "https://chatgpt.com/*" });
    const tab = tabs.find((t) => t.id === preferredTab) || tabs.find((t) => /\/settings\/usage/.test(t.url || "")) || tabs[0];
    if (!tab) return;
    let result;
    try { result = await invoke(api.tabs, "sendMessage", tab.id, { type: "collect-usage" }); }
    catch { return; }
    for (const binding of Object.values(bindings)) {
      // Never pass a URL or request body supplied by a web page. Local destination is validated during pairing.
      try {
        await fetch(`${binding.endpoint}/snapshot`, { method: "POST", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json", "X-Quota-Secret": binding.secret },
          body: JSON.stringify(result?.snapshot || { error: "usage-unavailable" }),
          signal: AbortSignal.timeout(10000) });
      } catch { /* Closed app: wait for a new pairing, never log capabilities or credentials. */ }
    }
  } finally { busy = false; }
}
api.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === "pair") {
    let url, senderUrl;
    try { url = new URL(message.endpoint); senderUrl = new URL(sender.url); } catch { return false; }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" ||
        url.username || url.password || url.search || url.hash || senderUrl.origin !== url.origin || senderUrl.pathname !== "/pair" ||
        !/^[a-f0-9]{64}$/.test(message.secret || "") || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.profile || "") ||
        !["safari", "chrome", "firefox", "zen"].includes(message.browser)) return false;
    (async () => {
      const { bindings = {} } = await invoke(api.storage.local, "get", "bindings");
      bindings[message.profile] = { endpoint: url.origin, secret: message.secret };
      await invoke(api.storage.local, "set", { bindings });
      await invoke(api.tabs, "create", { url: "https://chatgpt.com/settings/usage?tab=overview" });
      api.alarms.create("quota-refresh", { periodInMinutes: 3 });
      reply({ ok: true });
    })().catch(() => reply({ ok: false }));
    return true;
  }
  if (message.type === "usage-ready" && sender.tab && sender.url?.startsWith("https://chatgpt.com/")) {
    publishAll(sender.tab.id).catch(() => {}); reply({ ok: true });
  }
  return false;
});
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "quota-refresh") publishAll().catch(() => {});
});
