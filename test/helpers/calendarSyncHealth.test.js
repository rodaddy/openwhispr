const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifySyncError,
  CalendarSyncHealth,
} = require("../../src/helpers/calendarSyncHealth.js");

test("token refresh Unauthorized, invalid_grant and 401 classify as auth", () => {
  assert.equal(classifySyncError(new Error("Token refresh failed: Unauthorized")), "auth");
  assert.equal(classifySyncError(new Error("Token refresh failed: invalid_grant")), "auth");
  const err = new Error("Request failed");
  err.statusCode = 401;
  assert.equal(classifySyncError(err), "auth");
});

test("network and server errors classify as other", () => {
  assert.equal(classifySyncError(new Error("net::ERR_INTERNET_DISCONNECTED")), "other");
  const err = new Error("Server error");
  err.statusCode = 503;
  assert.equal(classifySyncError(err), "other");
});

test("a failure is recorded and the next success clears it", () => {
  const health = new CalendarSyncHealth();
  health.recordFailure("a@x.com", new Error("Token refresh failed: Unauthorized"), 1000);
  assert.deepEqual(health.get("a@x.com").failure, {
    kind: "auth",
    since: 1000,
    message: "Token refresh failed: Unauthorized",
  });
  health.recordSuccess("a@x.com", 2000);
  assert.equal(health.get("a@x.com").failure, null);
  assert.equal(health.get("a@x.com").lastSuccessAt, 2000);
});

test("an auth failure notifies once per streak, again after a success", () => {
  const health = new CalendarSyncHealth();
  const authErr = new Error("Token refresh failed: Unauthorized");
  assert.equal(health.recordFailure("a@x.com", authErr, 1000).notify, true);
  assert.equal(health.recordFailure("a@x.com", authErr, 2000).notify, false);
  assert.equal(health.get("a@x.com").failure.since, 1000);
  health.recordSuccess("a@x.com", 3000);
  assert.equal(health.recordFailure("a@x.com", authErr, 4000).notify, true);
});

test("an other failure never notifies", () => {
  const health = new CalendarSyncHealth();
  assert.equal(health.recordFailure("a@x.com", new Error("timeout"), 1000).notify, false);
});

test("a sync pass fails an account when any of its calendars failed", () => {
  const health = new CalendarSyncHealth();
  const authErr = new Error("Token refresh failed: Unauthorized");
  const notify = health.recordSyncPass(
    [
      ["a@x.com", null],
      ["a@x.com", authErr],
      ["b@x.com", null],
    ],
    1000
  );
  assert.deepEqual(notify, ["a@x.com"]);
  assert.equal(health.get("a@x.com").failure.kind, "auth");
  assert.equal(health.get("b@x.com").lastSuccessAt, 1000);
});
