const test = require("node:test");
const assert = require("node:assert/strict");

const { selectRetention } = require("../../scripts/lib/releaseRetention");

const LIVE = [
  { tag: "v2.0.24", createdAt: "2026-10-07T17:04:24-04:00" },
  { tag: "v2.0.23", createdAt: "2026-10-07T16:18:13-04:00" },
  { tag: "v2.0.22", createdAt: "2026-10-07T14:05:11-04:00" },
  { tag: "v2.0.21", createdAt: "2026-10-07T09:58:22-04:00" },
  { tag: "v2.0.20", createdAt: "2026-10-02T20:01:11-04:00" },
  { tag: "v2.0.19", createdAt: "2026-10-01T20:06:37-04:00" },
  { tag: "v2.0.18", createdAt: "2026-10-01T17:12:31-04:00" },
  { tag: "v2.0.17", createdAt: "2026-09-30T21:11:32-04:00" },
  { tag: "v2.0.16", createdAt: "2026-09-30T19:58:06-04:00" },
  { tag: "v1.10.1-rtech.5", createdAt: "2026-09-16T16:37:59-04:00" },
];

test("live data keeps the newest build and the two before it", () => {
  const result = selectRetention(LIVE);
  assert.deepEqual(result.keep, ["v2.0.24", "v2.0.20", "v2.0.19"]);
  assert.deepEqual([...result.drop].sort(), [
    "v1.10.1-rtech.5",
    "v2.0.16",
    "v2.0.17",
    "v2.0.18",
    "v2.0.21",
    "v2.0.22",
    "v2.0.23",
  ]);
});

test("same-day collapse uses the time zone, not UTC", () => {
  const result = selectRetention([
    { tag: "v2.0.2", createdAt: "2026-10-08T00:30:00-04:00" },
    { tag: "v2.0.1", createdAt: "2026-10-07T22:30:00-04:00" },
  ]);
  assert.deepEqual(result.keep, ["v2.0.2", "v2.0.1"]);
  assert.deepEqual(result.drop, []);
});

test("semver ordering ranks v2.0.10 above v2.0.9", () => {
  const result = selectRetention(
    [
      { tag: "v2.0.9", createdAt: "2026-10-02T10:00:00-04:00" },
      { tag: "v2.0.10", createdAt: "2026-10-01T10:00:00-04:00" },
    ],
    { keep: 1 }
  );
  assert.deepEqual(result.keep, ["v2.0.10"]);
  assert.deepEqual(result.drop, ["v2.0.9"]);
});

test("a point release older than three builds is dropped", () => {
  const result = selectRetention([
    { tag: "v2.1.3", createdAt: "2026-10-04T10:00:00-04:00" },
    { tag: "v2.1.2", createdAt: "2026-10-03T10:00:00-04:00" },
    { tag: "v2.1.1", createdAt: "2026-10-02T10:00:00-04:00" },
    { tag: "v2.1.0", createdAt: "2026-10-01T10:00:00-04:00" },
  ]);
  assert.deepEqual(result.keep, ["v2.1.3", "v2.1.2", "v2.1.1"]);
  assert.deepEqual(result.drop, ["v2.1.0"]);
});

test("current older than the kept three stays kept and is not dropped", () => {
  const result = selectRetention(LIVE, { current: "v2.0.17" });
  assert.deepEqual(result.keep, ["v2.0.24", "v2.0.20", "v2.0.19", "v2.0.17"]);
  assert.ok(!result.drop.includes("v2.0.17"));
  assert.ok(result.drop.includes("v2.0.16"));
});

test("non-version tags go to drop", () => {
  const result = selectRetention([
    { tag: "v2.0.1", createdAt: "2026-10-01T10:00:00-04:00" },
    { tag: "v1.10.1-rtech.5", createdAt: "2026-09-16T16:37:59-04:00" },
    { tag: "main", createdAt: "2026-09-15T10:00:00-04:00" },
  ]);
  assert.deepEqual(result.keep, ["v2.0.1"]);
  assert.deepEqual(result.drop, ["v1.10.1-rtech.5", "main"]);
});

test("empty input returns empty keep and drop", () => {
  assert.deepEqual(selectRetention([]), { keep: [], drop: [] });
});

test("invalid createdAt throws an error naming the tag", () => {
  assert.throws(() => selectRetention([{ tag: "v2.0.5", createdAt: "not a date" }]), /v2\.0\.5/);
});
