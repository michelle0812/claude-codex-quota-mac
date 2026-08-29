// 更新檢查純邏輯的單元測試（不連網、不碰 electron）。

const assert = require("node:assert/strict");
const { isNewerVersion, msUntilNextWeeklySlot, parseVersion } = require("../shared/update-check");

// ---- parseVersion ----
assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
assert.deepEqual(parseVersion("1.0"), [1, 0, 0]);
assert.deepEqual(parseVersion("2.4.6-beta.1"), [2, 4, 6]);
assert.equal(parseVersion("nightly"), null);
assert.equal(parseVersion(undefined), null);

// ---- isNewerVersion ----
assert.equal(isNewerVersion("1.0.2", "1.0.1"), true);
assert.equal(isNewerVersion("v1.1.0", "1.0.9"), true);
assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
assert.equal(isNewerVersion("1.0.1", "1.0.1"), false);
assert.equal(isNewerVersion("1.0.0", "1.0.1"), false);
assert.equal(isNewerVersion("garbage", "1.0.0"), false, "解析不出來時保守回 false");
assert.equal(isNewerVersion("1.0.2", "garbage"), false);

// ---- msUntilNextWeeklySlot：每週一 10:00 台灣時間（UTC+8）----
// 台灣週一 10:00 == 該日 UTC 02:00。
function taipeiToUtc(y, mon, d, h, mi) {
  return Date.UTC(y, mon, d, h, mi) - 480 * 60_000;
}
const opts = { weekday: 1, hour: 10, minute: 0, tzOffsetMinutes: 480 };

// 台灣時間 週一 09:00 → 距離同日 10:00 剛好 1 小時
let now = taipeiToUtc(2026, 7, 31, 9, 0); // 2026-08-31 是星期一
let ms = msUntilNextWeeklySlot(now, opts);
assert.equal(ms, 60 * 60 * 1000, `週一 09:00 應該還有 1 小時，實際 ${ms}`);

// 台灣時間 週一 10:00 整 → 視為已過，跳到下週一（+7 天）
now = taipeiToUtc(2026, 7, 31, 10, 0);
ms = msUntilNextWeeklySlot(now, opts);
assert.equal(ms, 7 * 24 * 60 * 60 * 1000, `週一 10:00 整應該跳下週，實際 ${ms}`);

// 台灣時間 週三 12:00 → 下一個週一 10:00
now = taipeiToUtc(2026, 8, 2, 12, 0); // 2026-09-02 星期三
ms = msUntilNextWeeklySlot(now, opts);
const expected = taipeiToUtc(2026, 8, 7, 10, 0) - now; // 下週一 2026-09-07
assert.equal(ms, expected, `週三 12:00 應排到下週一，實際 ${ms} 期望 ${expected}`);
assert.ok(ms > 0 && ms < 7 * 24 * 60 * 60 * 1000);

console.log("Verified update-check: version parsing / comparison and weekly-slot scheduling.");
