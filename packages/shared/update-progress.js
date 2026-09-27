"use strict";

function renderProgress(state) {
  document.getElementById("progress").textContent = state.progress || "正在準備下載…";
}

window.quotaBridge.onUpdateStateChanged(renderProgress);
window.quotaBridge.getUpdateState().then(renderProgress).catch(() => {});
