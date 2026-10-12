"use strict";
// This content script can only pair with the application's fixed local route.
if (location.hostname === "127.0.0.1" && location.pathname === "/pair") {
  const params = new URLSearchParams(location.hash.slice(1));
  const secret = params.get("secret"), profile = params.get("profile"), browser = params.get("browser");
  if (/^[a-f0-9]{64}$/.test(secret || "") && /^[a-zA-Z0-9_-]{1,80}$/.test(profile || "") &&
      ["safari", "chrome", "firefox", "zen"].includes(browser)) {
    const api = chrome;
    api.runtime.sendMessage({ type: "pair", endpoint: location.origin, secret, profile, browser }, (reply) => {
      const status = document.getElementById("quota-pair-status");
      if (status) status.textContent = reply?.ok
        ? "已連接面板，請在新開啟的 ChatGPT 分頁登入。此分頁可以關閉。"
        : "瀏覽器橋接失敗，請回面板重新連線。";
    });
    // Don't leave the pairing capability in the address bar or copied URLs.
    history.replaceState(null, "", "/pair");
  }
}
