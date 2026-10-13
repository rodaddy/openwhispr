const test = require("node:test");
const assert = require("node:assert/strict");

const { runCalendarSyncNow, singleFlight } = require("../../src/helpers/calendarSyncNow.js");

test("a clean pass reports success", async () => {
  const calls = [];
  const result = await runCalendarSyncNow({
    fetchCalendars: async () => calls.push("fetch"),
    syncEvents: async () => {
      calls.push("sync");
      return [["a@example.com", null]];
    },
  });
  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, ["fetch", "sync"]);
});

test("a calendar-list failure reaches the caller with the provider's message", async () => {
  const message = "Google Calendar API has not been used in project 123 or it is disabled";
  const result = await runCalendarSyncNow({
    fetchCalendars: async (errors) => errors.push(new Error(message)),
    syncEvents: async () => undefined,
  });
  assert.deepEqual(result, { success: false, error: message });
});

test("an event sync failure reaches the caller", async () => {
  const result = await runCalendarSyncNow({
    fetchCalendars: async () => {},
    syncEvents: async () => [
      ["a@example.com", null],
      ["b@example.com", new Error("Rate limit exceeded")],
    ],
  });
  assert.deepEqual(result, { success: false, error: "Rate limit exceeded" });
});

test("a thrown error is returned, not raised", async () => {
  const result = await runCalendarSyncNow({
    fetchCalendars: async () => {
      throw new Error("database is locked");
    },
    syncEvents: async () => [],
  });
  assert.deepEqual(result, { success: false, error: "database is locked" });
});

test("singleFlight: a second call while one runs gets the running result", async () => {
  let runs = 0;
  let release;
  const run = singleFlight(
    () =>
      new Promise((resolve) => {
        runs += 1;
        release = () => resolve({ success: true, run: runs });
      })
  );
  const first = run();
  const second = run();
  release();
  assert.deepEqual(await first, { success: true, run: 1 });
  assert.deepEqual(await second, { success: true, run: 1 });
  assert.equal(runs, 1);

  const third = run();
  release();
  assert.deepEqual(await third, { success: true, run: 2 });
});
