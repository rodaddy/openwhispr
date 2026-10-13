// Transcription pull paging (#119): the real SyncService over a real
// DatabaseManager, with only the hub faked. A run of more than one page of rows
// sharing one timestamp must resume by (stamp, id) — `since` + `since_id` on the
// delta, `before` + `before_id` on the snapshot — or the rows past the first
// page are skipped (or the loop stalls). Between passes the cursor is the
// desktop clock at pass start minus the 60 s lookback, with no id (protocol
// section 8), so a row that commits late with a lower (stamp, id) than the
// newest row served still lands.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud, reportUuidSeedOnFailure } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

const LIST = "/api/transcriptions/list";
const SHARED_STAMP = "2026-09-20T12:00:00.000Z";
const EARLIER = "2026-09-01T00:00:00.000Z";
const inMs = (ms) => new Date(Date.now() + ms).toISOString();
// The delta cursor lookback L (protocol section 8).
const LOOKBACK_MS = 60_000;
const lookedBack = (iso) => new Date(Date.parse(iso) - LOOKBACK_MS).toISOString();

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  reportUuidSeedOnFailure(t, cloud);
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));

  // Record every row the hub serves so a repeat is visible, not just a skip.
  const served = [];
  const servedRows = [];
  const request = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    const result = await request(opts);
    if (String(opts?.path ?? "").split("?")[0] === LIST && result.success) {
      for (const row of result.data.transcriptions) {
        served.push(row.id);
        servedRows.push(row);
      }
    }
    return result;
  };
  return { db, cloud, service, served, servedRows };
}

function seedRun(cloud, count, stamp) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(cloud.seedTranscription({ text: `row ${i}`, created_at: stamp, updated_at: stamp }));
  }
  // Hub ids are varied uuids from a seeded stream (#140, #165); a run sharing
  // one stamp pages in id order, which for Postgres uuids is lowercase hex
  // string order.
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function localClientIds(db) {
  return db.db
    .prepare("SELECT client_transcription_id FROM transcriptions")
    .all()
    .map((r) => r.client_transcription_id)
    .sort();
}

function params(call) {
  const [, query] = call.path.split("?");
  return new URLSearchParams(query ?? "");
}

function assertExactlyOnce(served, rows) {
  const counts = new Map();
  for (const id of served) counts.set(id, (counts.get(id) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(repeated, [], "no row may be served twice");
  assert.equal(counts.size, rows.length, "every row must be served");
}

test("a delta pull walks 150 rows sharing one updated_at with no skip and no repeat", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service, served } = ctx;
  const rows = seedRun(cloud, 150, SHARED_STAMP);
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);
  // A cursor from before the upgrade: the one-time rewind moves it back 60 s,
  // and the id the old max-row cursor left is neither sent nor kept.
  localStorageStub.setItem("lastSyncedAt.transcriptions.id", "stale-id");

  await service.syncAll(true);

  assert.equal(localStorageStub.getItem("lastSyncedAt.transcriptions.id"), null);
  assert.deepEqual(
    localClientIds(db),
    rows.map((r) => r.client_transcription_id).sort(),
    "all 150 rows must land locally"
  );
  assertExactlyOnce(served, rows);

  const calls = cloud.logFor(LIST);
  assert.equal(params(calls[0]).get("since"), new Date(Date.parse(EARLIER) - 60_000).toISOString());
  assert.equal(params(calls[0]).get("since_id"), null, "a saved cursor has no id");
  const second = params(calls[1]);
  assert.equal(second.get("since"), SHARED_STAMP);
  assert.equal(second.get("since_id"), rows[99].id, "resume after the last row of page one");
  assert.equal(second.get("before"), null);
});

test("the delta cursor persists the pass-start clock minus the lookback with no id, and the next pass resumes from it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  seedRun(cloud, 150, SHARED_STAMP);
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);

  const lo = lookedBack(new Date().toISOString());
  await service.syncAll(true);
  const hi = lookedBack(new Date().toISOString());

  const saved = localStorageStub.getItem("lastSyncedAt.transcriptions");
  assert.ok(saved >= lo && saved <= hi, `cursor ${saved} is the pass-start clock - 60 s`);
  assert.equal(localStorageStub.getItem("lastSyncedAt.transcriptions.id"), null);

  // A row the hub stamps after that pass.
  const late = cloud.seedTranscription({ text: "late", updated_at: inMs(1000) });
  const before = cloud.logFor(LIST).length;
  await service.syncAll(true);

  const next = params(cloud.logFor(LIST)[before]);
  assert.equal(next.get("since"), saved);
  assert.equal(next.get("since_id"), null);
  assert.ok(db.getTranscriptionByClientId(late.client_transcription_id), "the late row lands");
  assert.equal(localClientIds(db).length, 151);
});

test("a row that commits after the read with a lower (stamp, id) than the newest row served still lands", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);
  const api = windowStub.electronAPI;
  const request = api.cloudApiRequest;
  let listCalls = 0;
  let inFlight = null;
  api.cloudApiRequest = async (opts) => {
    const first = String(opts?.path ?? "").split("?")[0] === LIST && ++listCalls === 1;
    // Committed before the read, with the newer stamp: served.
    if (first) cloud.seedTranscription({ text: "newer", updated_at: inMs(2000) });
    const result = await request(opts);
    // Stamped earlier but committed after the read (an open batch transaction).
    if (first) inFlight = cloud.seedTranscription({ text: "in-flight", updated_at: inMs(1000) });
    return result;
  };

  await service.syncAll(true);
  assert.equal(db.getTranscriptionByClientId(inFlight.client_transcription_id), null);
  await service.syncAll(true);

  assert.ok(
    db.getTranscriptionByClientId(inFlight.client_transcription_id),
    "the late-committed row lands on the next pass"
  );
});

test("a snapshot pull walks 150 rows sharing one created_at with no skip and no repeat", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service, served } = ctx;
  const rows = seedRun(cloud, 150, SHARED_STAMP);

  await service.syncAll(true);

  assert.deepEqual(
    localClientIds(db),
    rows.map((r) => r.client_transcription_id).sort(),
    "all 150 rows must land locally"
  );
  assertExactlyOnce(served, rows);

  const calls = cloud.logFor(LIST);
  assert.equal(params(calls[0]).get("before"), null);
  assert.equal(params(calls[0]).get("since"), null);
  const second = params(calls[1]);
  assert.equal(second.get("before"), SHARED_STAMP);
  // Snapshot pages run id-descending inside a stamp: page one ends at rows[50].
  assert.equal(second.get("before_id"), rows[50].id);
  assert.equal(second.get("since"), null);

  // The snapshot leaves the pass-start clock behind, not the newest row served.
  assert.ok(localStorageStub.getItem("lastSyncedAt.transcriptions") > SHARED_STAMP);
  assert.equal(localStorageStub.getItem("lastSyncedAt.transcriptions.id"), null);
});

test("a paged snapshot serves tombstones, lands every live row, and keeps the tombstoned row out", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service, served } = ctx;
  const rows = seedRun(cloud, 150, SHARED_STAMP);
  // An old row deleted later: the hub's snapshot still serves its tombstone.
  const gone = cloud.seedTranscription({
    text: "gone",
    created_at: EARLIER,
    updated_at: SHARED_STAMP,
    deleted_at: SHARED_STAMP,
  });

  await service.syncAll(true);

  assert.ok(served.includes(gone.id), "the snapshot must serve the tombstone");
  assertExactlyOnce(served, [...rows, gone]);
  assert.deepEqual(
    localClientIds(db),
    rows.map((r) => r.client_transcription_id).sort(),
    "every live row lands and the tombstone never does"
  );
});

// A row written while the snapshot walk is on page two is never served by the
// walk (it sorts ahead of page one). The saved cursor must still sit below it,
// even when a later snapshot page serves a row with a newer updated_at.
async function snapshotWithMidWalkWrite(t, laterPageWrite) {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const rows = seedRun(cloud, 150, SHARED_STAMP);
  const api = windowStub.electronAPI;
  const request = api.cloudApiRequest;
  let listCalls = 0;
  let midWalk = null;
  api.cloudApiRequest = async (opts) => {
    const result = await request(opts);
    if (String(opts?.path ?? "").split("?")[0] === LIST && ++listCalls === 1) {
      // Stamped by the hub clock after the pass started.
      midWalk = cloud.seedTranscription({ text: "mid-walk" });
      laterPageWrite(cloud, rows);
    }
    return result;
  };

  await service.syncAll(true);
  assert.equal(db.getTranscriptionByClientId(midWalk.client_transcription_id), null);
  await service.syncAll(true);

  assert.ok(
    db.getTranscriptionByClientId(midWalk.client_transcription_id),
    "the row written mid-walk lands on the next delta"
  );
}

test("a snapshot cursor does not pass a mid-walk row when a later page serves a newer tombstone", async (t) => {
  await snapshotWithMidWalkWrite(t, (cloud, rows) => {
    // rows[10] sits on page two; its tombstone is newer than the mid-walk row.
    const later = inMs(60_000);
    cloud.setClock(() => later);
    cloud.tombstoneTranscription(rows[10].id);
  });
});

test("a snapshot cursor does not pass a mid-walk row when a later page serves an old-created, newly-written row", async (t) => {
  await snapshotWithMidWalkWrite(t, (cloud) => {
    // A batch-create with an old client created_at lands on page two, newer
    // updated_at than the mid-walk row.
    cloud.seedTranscription({
      text: "backfill",
      created_at: EARLIER,
      updated_at: inMs(60_000),
    });
  });
});

// rtech-whisper#139: the paths the paging tests above do not reach.
test("an empty delta pull still saves the pass-start clock minus the lookback and drops a legacy id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);
  localStorageStub.setItem("lastSyncedAt.transcriptions.id", "legacy-id");

  const lo = lookedBack(new Date().toISOString());
  await service.syncAll(true);
  const hi = lookedBack(new Date().toISOString());

  assert.equal(cloud.logFor(LIST).length, 1, "one empty page ends the pull");
  const saved = localStorageStub.getItem("lastSyncedAt.transcriptions");
  assert.ok(saved >= lo && saved <= hi, `cursor ${saved} must move to the pass-start clock - 60 s`);
  assert.equal(localStorageStub.getItem("lastSyncedAt.transcriptions.id"), null);
});

test("the stall guard ends a pull when the hub ignores since_id and repeats a full page", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  seedRun(cloud, 150, SHARED_STAMP);
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);
  const api = windowStub.electronAPI;
  const request = api.cloudApiRequest;
  let listCalls = 0;
  let firstPage = null;
  api.cloudApiRequest = async (opts) => {
    const [pathname] = String(opts?.path ?? "").split("?");
    if (pathname !== LIST) return request(opts);
    // A client without the guard would page forever; stop it here instead of
    // hanging the suite.
    if (++listCalls > 5) throw new Error("the pull did not stop");
    // A hub that ignores since_id serves the same full page again, whatever
    // the cursor says. Replaying the first response models that directly, so
    // the test does not depend on the fake cloud's tie handling.
    if (!firstPage) firstPage = await request(opts);
    return firstPage;
  };

  await service.syncAll(true);

  assert.equal(listCalls, 2, "the repeated page must end the pull");
  assert.equal(localClientIds(db).length, 100, "the first page still lands");
});

// rtech-whisper#185: the hub stores a device's own push, so the same pass's
// pull (push, delete-push, then pull since the old cursor) serves it back. The echo must match the local row by client id and leave it
// alone: no duplicate, no second push.
test("a device's own push is echoed by the pass's delta and does not duplicate locally", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service, served } = ctx;
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);
  const { transcription: local } = db.saveTranscription("dictated on this Mac");

  await service.syncAll(true);

  const pushed = cloud.transcriptions();
  assert.equal(pushed.length, 1, "the hub stores the pushed row");
  assert.equal(pushed[0].client_transcription_id, local.client_transcription_id);
  assert.equal(db.getTranscriptionByClientId(local.client_transcription_id).cloud_id, pushed[0].id);
  // #205: pass 1 pulls from EARLIER after its push, so the echo arrives there;
  // pass 2 pulls from pass 1's start, after the push stamp.
  assert.ok(served.includes(pushed[0].id), "the pass's own delta serves the device's push");
  assert.equal(localClientIds(db).length, 1, "the echo must not add a second local row");

  await service.syncAll(true);

  assert.equal(localClientIds(db).length, 1, "a later pass adds no second local row");
  assert.equal(
    cloud.logFor("/api/transcriptions/batch-create").length,
    1,
    "a synced row is not pushed again"
  );
});

// The delete travels the same way: batch-delete tombstones the stored row, and
// the echoed tombstone must not bring the row back.
test("a pushed delete tombstones the hub row and its echo keeps the row gone", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service, servedRows } = ctx;
  localStorageStub.setItem("lastSyncedAt.transcriptions", EARLIER);
  const { transcription: local } = db.saveTranscription("dictated, then deleted");
  await service.syncAll(true);
  const cloudId = db.getTranscriptionByClientId(local.client_transcription_id).cloud_id;
  assert.ok(cloudId, "the first pass pushes the row");

  db.deleteTranscription(local.id);
  const servedBefore = servedRows.length;
  await service.syncAll(true);
  // #206: the tombstone is stamped after the push, so the delete pass's pull
  // serves it back.
  const [deleted] = cloud.transcriptions();
  const echo = servedRows.slice(servedBefore).find((r) => r.id === cloudId);
  assert.ok(echo?.deleted_at, "the delete pass serves the tombstone");
  assert.equal(echo.deleted_at, deleted.deleted_at);
  await service.syncAll(true);

  // #230: judge the hub as it stands after the third pass.
  const after = cloud.transcriptions();
  assert.equal(after.length, 1, "the hub still holds exactly one row");
  assert.ok(after[0].deleted_at, "batch-delete leaves a tombstone on the hub");
  assert.equal(
    cloud.logFor("/api/transcriptions/batch-create").length,
    1,
    "the deleted row is not pushed again"
  );
  assert.equal(db.getTranscriptionByClientId(local.client_transcription_id), null);
});
