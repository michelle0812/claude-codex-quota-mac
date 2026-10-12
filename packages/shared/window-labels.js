(function (root) {
  "use strict";
  function windowLabels(quota, lang = "zh") {
    const duration = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
    const longDays = Math.round(duration(quota?.secondary?.windowDurationMins, 10080) / 1440 * 10) / 10;
    const shortHours = Math.round(duration(quota?.primary?.windowDurationMins, 300) / 60 * 10) / 10;
    const zh = lang === "zh";
    return {
      primary: zh ? `${shortHours}小時` : `${shortHours}-hour window`,
      secondary: zh ? (longDays === 7 ? "本週" : longDays >= 28 && longDays <= 31 ? "本月" : `${longDays}天`) : `${longDays}-day window`,
      pace: zh ? `${longDays}天節奏` : `${longDays}-day pace`,
      longAbbreviation: `${longDays}d`, shortAbbreviation: `${shortHours}h`, longDays
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { windowLabels };
  else root.QuotaWindowLabels = { windowLabels };
})(typeof window === "undefined" ? globalThis : window);
