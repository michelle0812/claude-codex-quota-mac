const assert = require("node:assert/strict");
const { applyDockVisibility } = require("../shared/dock-visibility");
const { DEFAULT_WIDGET_SETTINGS, normalizeWidgetSettings } = require("../shared/widget-settings");

const defaults = normalizeWidgetSettings();
assert.deepEqual(defaults, DEFAULT_WIDGET_SETTINGS);
assert.equal(defaults.showInDock, true);

const hidden = normalizeWidgetSettings({ ...DEFAULT_WIDGET_SETTINGS, showInDock: false });
assert.equal(hidden.showInDock, false);

const shown = normalizeWidgetSettings({ ...DEFAULT_WIDGET_SETTINGS, showInDock: true });
assert.equal(shown.showInDock, true);

const migrated = normalizeWidgetSettings({
  recentFastBreathMs: 6000,
  criticalBlinkMs: 5000,
  quotaRefreshMs: 10 * 60 * 1000
});
assert.equal(migrated.showInDock, true);

const dockCalls = [];
const dock = {
  show() {
    dockCalls.push("show");
  },
  hide() {
    dockCalls.push("hide");
  }
};
applyDockVisibility(dock, false);
applyDockVisibility(dock, true);
assert.deepEqual(dockCalls, ["hide", "show"]);

console.log("Verified Dock visibility defaults, hide/show actions, and migration from existing settings.");
