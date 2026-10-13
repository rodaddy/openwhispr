const test = require("node:test");
const assert = require("node:assert/strict");

const { getGrillCalendarEvents } = require("../../src/helpers/grillCalendar.js");

test("returns every connected provider's events in the window", () => {
  const calls = [];
  const db = {
    getCalendarEventsInRange: (...args) => {
      calls.push(args);
      return [{ id: "e1" }];
    },
  };
  const result = getGrillCalendarEvents(db, "a", "b", { error: () => assert.fail("no error") });
  assert.deepEqual(result, { success: true, events: [{ id: "e1" }] });
  assert.deepEqual(calls, [["a", "b", ["google", "microsoft", "apple"]]]);
});

test("a read failure is logged and reported as unsuccessful", () => {
  const logged = [];
  const db = {
    getCalendarEventsInRange: () => {
      throw new Error("no such table: calendar_events");
    },
  };
  const result = getGrillCalendarEvents(db, "a", "b", {
    error: (message, meta, scope) => logged.push([message, meta, scope]),
  });
  assert.deepEqual(result, { success: false, events: [], error: "no such table: calendar_events" });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].error, "no such table: calendar_events");
});

test("the grill-get-calendar-events IPC handler goes through the logging helper", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/helpers/ipcHandlers.js"),
    "utf8"
  );
  const at = source.indexOf('ipcMain.handle("grill-get-calendar-events"');
  assert.ok(at > 0);
  const body = source.slice(at, at + 400);
  assert.match(body, /getGrillCalendarEvents\(this\.databaseManager, start, end, debugLogger\)/);
});
