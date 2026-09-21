"use strict";

// 「＋」按下後跳出來的命名視窗（renderer 端）。
// 只用共用 preload 暴露的 window.quotaBridge.panelName.*，沒有任何 node/require。

const els = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  input: document.getElementById("nameInput"),
  hint: document.getElementById("hint"),
  okBtn: document.getElementById("okBtn"),
  cancelBtn: document.getElementById("cancelBtn")
};

const COPY = {
  zh: {
    title: "新面板的名稱",
    subtitle: "取個看得懂的名字，之後面板標題會顯示它。",
    hint: (id) => `留白的話就叫「${id}」。`,
    ok: "建立面板",
    cancel: "取消"
  },
  en: {
    title: "Name the new panel",
    subtitle: "Pick something recognisable — the panel title will show it.",
    hint: (id) => `Leave blank to use "${id}".`,
    ok: "Create panel",
    cancel: "Cancel"
  }
};

let submitted = false;

function submit(name) {
  if (submitted) return;
  submitted = true;
  window.quotaBridge.panelName.submit(name);
}

els.okBtn.addEventListener("click", () => submit(els.input.value));
els.cancelBtn.addEventListener("click", () => submit(null));

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submit(els.input.value);
  if (event.key === "Escape") submit(null);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") submit(null);
});

window.quotaBridge.panelName.onShow((payload) => {
  const copy = COPY[payload?.lang === "en" ? "en" : "zh"];
  els.title.textContent = copy.title;
  els.subtitle.textContent = copy.subtitle;
  els.okBtn.textContent = copy.ok;
  els.cancelBtn.textContent = copy.cancel;
  els.hint.textContent = copy.hint(payload?.id || "");
  els.input.placeholder = payload?.id || "";
  els.input.value = "";
  els.input.focus();
});

window.quotaBridge.panelName.ready();
