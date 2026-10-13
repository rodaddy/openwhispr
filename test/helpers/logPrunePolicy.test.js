const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectLogsToPrune,
  LOG_MAX_AGE_DAYS,
  LOG_MAX_TOTAL_BYTES,
} = require("../../src/helpers/logPrunePolicy.js");

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 8, 30, 12);

test("limits are 3 days and 200 MB", () => {
  assert.equal(LOG_MAX_AGE_DAYS, 3);
  assert.equal(LOG_MAX_TOTAL_BYTES, 200 * MB);
});

test("deletes files older than 3 days", () => {
  const files = [
    { name: "debug-old.log", mtimeMs: NOW - 4 * DAY, size: 10 },
    { name: "debug-new.log", mtimeMs: NOW - 2 * DAY, size: 10 },
    { name: "debug-cur.log", mtimeMs: NOW, size: 10 },
  ];
  assert.deepEqual(selectLogsToPrune(files, "debug-cur.log", NOW), ["debug-old.log"]);
});

test("deletes oldest first while the total is over 200 MB", () => {
  const files = [
    { name: "debug-b.log", mtimeMs: NOW - 2 * DAY, size: 100 * MB },
    { name: "debug-a.log", mtimeMs: NOW - 3 * DAY, size: 100 * MB },
    { name: "debug-c.log", mtimeMs: NOW - 1 * DAY, size: 100 * MB },
    { name: "debug-cur.log", mtimeMs: NOW, size: 10 * MB },
  ];
  assert.deepEqual(selectLogsToPrune(files, "debug-cur.log", NOW), ["debug-a.log", "debug-b.log"]);
});

test("never deletes the current log, even when it alone exceeds 200 MB", () => {
  const files = [
    { name: "debug-cur.log", mtimeMs: NOW - 30 * DAY, size: 300 * MB },
    { name: "debug-x.log", mtimeMs: NOW - DAY, size: MB },
  ];
  assert.deepEqual(selectLogsToPrune(files, "debug-cur.log", NOW), ["debug-x.log"]);
});

test("ignores files that are not debug-*.log", () => {
  const files = [
    { name: "onnx-worker.log", mtimeMs: NOW - 30 * DAY, size: 500 * MB },
    { name: "debug-x.txt", mtimeMs: NOW - 30 * DAY, size: 1 },
    { name: "debug-old.log", mtimeMs: NOW - 30 * DAY, size: 1 },
  ];
  assert.deepEqual(selectLogsToPrune(files, null, NOW), ["debug-old.log"]);
});
