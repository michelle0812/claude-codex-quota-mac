"use strict";
// Runs in the extension's isolated world. Neither credentials nor arbitrary page messages
// are sent to the application. Fetch only the current user's own fixed ChatGPT endpoints.
const quotaApi = chrome;
async function collectUsage() {
  const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include", cache: "no-store" });
  if (!sessionResponse.ok) throw new Error("session unavailable");
  const session = await sessionResponse.json();
  if (!session.accessToken || !session.user?.email) throw new Error("sign in required");
  let claims;
  try {
    const payload = session.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(payload));
  } catch { throw new Error("unknown session format"); }
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!accountId) throw new Error("account unavailable");
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    credentials: "include", cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}`, "ChatGPT-Account-Id": accountId }
  });
  if (!response.ok) throw new Error("usage unavailable");
  const usage = await response.json();
  const selectWindow = (w) => w ? {
    used_percent: w.used_percent, limit_window_seconds: w.limit_window_seconds, reset_at: w.reset_at
  } : null;
  return { email: session.user.email, accountId, planType: usage.plan_type,
    rateLimit: { primary_window: selectWindow(usage.rate_limit?.primary_window), secondary_window: selectWindow(usage.rate_limit?.secondary_window) } };
}
quotaApi.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type !== "collect-usage") return false;
  collectUsage().then((snapshot) => reply({ snapshot }), () => reply({ error: "usage-unavailable" }));
  return true;
});

// Signal readiness after navigation/login; the background also polls on an alarm.
quotaApi.runtime.sendMessage({ type: "usage-ready" }, () => {});
