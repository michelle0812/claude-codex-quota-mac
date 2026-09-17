const DEFAULT_WIDGET_SETTINGS = Object.freeze({
  recentFastBreathMs: 4000,
  criticalBlinkMs: 3000,
  quotaRefreshMs: 3 * 60 * 1000,
  autoUpdateCheck: true
});

function normalizeWidgetSettings(settings) {
  return {
    recentFastBreathMs: clampSignalMs(settings?.recentFastBreathMs, DEFAULT_WIDGET_SETTINGS.recentFastBreathMs),
    criticalBlinkMs: clampSignalMs(settings?.criticalBlinkMs, DEFAULT_WIDGET_SETTINGS.criticalBlinkMs),
    quotaRefreshMs: clampQuotaRefreshMs(settings?.quotaRefreshMs, DEFAULT_WIDGET_SETTINGS.quotaRefreshMs),
    autoUpdateCheck:
      settings?.autoUpdateCheck === undefined
        ? DEFAULT_WIDGET_SETTINGS.autoUpdateCheck
        : Boolean(settings.autoUpdateCheck)
  };
}

function clampSignalMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(20000, Math.max(1000, Math.round(number)));
}

function clampQuotaRefreshMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(30 * 60 * 1000, Math.max(60 * 1000, Math.round(number)));
}

module.exports = { DEFAULT_WIDGET_SETTINGS, normalizeWidgetSettings };
