function applyDockVisibility(dock, showInDock, onError = () => {}) {
  if (!dock) return;

  const result = showInDock ? dock.show() : dock.hide();
  result?.catch?.(onError);
}

module.exports = { applyDockVisibility };
