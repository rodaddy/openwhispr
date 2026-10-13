// Delta cursors per hub URL (rtech-whisper#126): stashed on a switch,
// restored on the way back, with the D12 cursorVersion marker alongside.

const test = require("node:test");
const assert = require("node:assert/strict");

const { swapHubCursors } = require("../../src/lib/hubCursors.ts");
const { isHubSwitch } = require("../../src/helpers/hubSync.js");
const { isHubSwitchDraft } = require("../../src/services/hubConnection.ts");

const A = "https://a.example.com";
const B = "https://b.example.com";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

test("cursors and the D12 marker are stashed per hub and restored", () => {
  const store = memoryStorage({
    "sync.hubUrl": A,
    "lastSyncedAt.notes": "2026-09-01T00:00:00.000Z",
    "lastSyncedAt.folders": "2026-09-02T00:00:00.000Z",
    "sync.cursorVersion": "2",
    unrelated: "kept",
  });

  assert.equal(swapHubCursors(B, store), true);
  // B starts with no cursors: its first pass is a full snapshot.
  assert.equal(store.getItem("lastSyncedAt.notes"), null);
  assert.equal(store.getItem("sync.cursorVersion"), null);
  assert.equal(store.getItem("unrelated"), "kept");
  assert.equal(store.getItem("sync.hubUrl"), B);

  store.setItem("lastSyncedAt.notes", "2026-09-10T00:00:00.000Z");
  store.setItem("sync.cursorVersion", "2");

  assert.equal(swapHubCursors(A, store), true);
  assert.equal(store.getItem("lastSyncedAt.notes"), "2026-09-01T00:00:00.000Z");
  assert.equal(store.getItem("lastSyncedAt.folders"), "2026-09-02T00:00:00.000Z");
  assert.equal(store.getItem("sync.cursorVersion"), "2");
  assert.equal(store.getItem(`hubCursors.${A}`), null);
  assert.deepEqual(JSON.parse(store.getItem(`hubCursors.${B}`)), {
    "lastSyncedAt.notes": "2026-09-10T00:00:00.000Z",
    "sync.cursorVersion": "2",
  });
});

test("first run after the upgrade keeps the cursors; same URL and hub off do nothing", () => {
  const store = memoryStorage({ "lastSyncedAt.notes": "c1", "sync.cursorVersion": "2" });
  assert.equal(swapHubCursors(A, store), false);
  assert.equal(store.getItem("lastSyncedAt.notes"), "c1");
  assert.equal(store.getItem("sync.hubUrl"), A);
  assert.equal(swapHubCursors("", store), false);
  assert.equal(swapHubCursors(A, store), false);
  assert.equal(store.getItem("lastSyncedAt.notes"), "c1");
  assert.equal(store.getItem("sync.cursorVersion"), "2");
});

test("only a different, non-empty hub URL is a switch that restarts the app", () => {
  assert.equal(isHubSwitch(A, B), true);
  assert.equal(isHubSwitch("", A), true);
  assert.equal(isHubSwitch(A, A), false);
  assert.equal(isHubSwitch(A, ""), false);
  assert.equal(isHubSwitchDraft(A, ` ${B}/ `), true);
  assert.equal(isHubSwitchDraft(A, `${A}/`), false);
  assert.equal(isHubSwitchDraft(A, ""), false);
  assert.equal(isHubSwitchDraft(A, "not a url"), false);
});
