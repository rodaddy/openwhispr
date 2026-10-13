const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const m = await import("../../src/utils/calendarSyncNowState.ts");
  return m.default || m;
};

const NOW = 1_800_000_000_000;

test("a successful result becomes synced-at-now", async () => {
  const { syncNowStateFromResult } = await load();
  assert.deepEqual(syncNowStateFromResult({ success: true }, NOW), { status: "synced", at: NOW });
});

test("a failed result carries the provider's error text", async () => {
  const { syncNowStateFromResult } = await load();
  assert.deepEqual(
    syncNowStateFromResult({ success: false, error: "Calendar API is disabled" }, NOW),
    { status: "error", message: "Calendar API is disabled" }
  );
});

test("error text is truncated to 200 characters", async () => {
  const { syncNowStateFromResult, SYNC_NOW_ERROR_MAX_LENGTH } = await load();
  const state = syncNowStateFromResult({ success: false, error: "x".repeat(500) }, NOW);
  assert.equal(SYNC_NOW_ERROR_MAX_LENGTH, 200);
  assert.equal(state.message.length, 200);
  assert.ok(state.message.endsWith("…"));
});

test("a missing result or missing error text is still an error state", async () => {
  const { syncNowStateFromResult } = await load();
  assert.deepEqual(syncNowStateFromResult(undefined, NOW), { status: "error", message: "" });
  assert.deepEqual(syncNowStateFromResult({ success: false }, NOW), {
    status: "error",
    message: "",
  });
});

test("the status line: nothing when idle or running", async () => {
  const { syncNowStatusLine } = await load();
  assert.equal(syncNowStatusLine({ status: "idle" }, NOW), null);
  assert.equal(syncNowStatusLine({ status: "running" }, NOW), null);
});

test("the status line: just now, then minutes, then hours", async () => {
  const { syncNowStatusLine } = await load();
  const at = (ms) => syncNowStatusLine({ status: "synced", at: NOW - ms }, NOW);
  assert.deepEqual(at(0), { kind: "synced", key: "syncedJustNow" });
  assert.deepEqual(at(59_000), { kind: "synced", key: "syncedJustNow" });
  assert.deepEqual(at(60_000), { kind: "synced", key: "syncedMinutesAgo", count: 1 });
  assert.deepEqual(at(59 * 60_000), { kind: "synced", key: "syncedMinutesAgo", count: 59 });
  assert.deepEqual(at(60 * 60_000), { kind: "synced", key: "syncedHoursAgo", count: 1 });
  assert.deepEqual(at(5 * 60 * 60_000), { kind: "synced", key: "syncedHoursAgo", count: 5 });
});

test("the status line: an error shows its text, or the generic key when there is none", async () => {
  const { syncNowStatusLine } = await load();
  assert.deepEqual(syncNowStatusLine({ status: "error", message: "boom" }, NOW), {
    kind: "error",
    text: "boom",
  });
  assert.deepEqual(syncNowStatusLine({ status: "error", message: "" }, NOW), {
    kind: "error",
    key: "syncFailed",
  });
});
