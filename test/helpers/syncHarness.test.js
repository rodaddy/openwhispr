const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeCloud } = require("./harness/fakeCloud.js");
const { assertNoContentRegression } = require("./harness/invariants.js");
const {
  dispatchWindowEvent,
  resetBrowserGlobals,
  window: windowStub,
  windowListenerCount,
} = require("./harness/browserGlobals.js");

const T1 = "2026-07-20T10:00:00.000Z";
const T2 = "2026-07-20T11:00:00.000Z";

function note(overrides = {}) {
  return {
    id: "local-1",
    client_note_id: "client-1",
    content: "important text",
    transcript: null,
    enhanced_content: null,
    deleted_at: null,
    updated_at: T1,
    ...overrides,
  };
}

test("content invariant rejects a note that disappears without a cloud tombstone", () => {
  assert.throws(
    () => assertNoContentRegression([note()], [], []),
    /sync hard-deleted note local-1/
  );
});

test("content invariant allows a note removed by a current cloud tombstone", () => {
  const tombstone = note({ id: "note-1", deleted_at: T2, updated_at: T2 });
  assert.doesNotThrow(() => assertNoContentRegression([note()], [], [tombstone]));
});

test("fake cloud paginates tied timestamps with the composite cursor id", async () => {
  const cloud = createFakeCloud();
  for (let i = 1; i <= 51; i += 1) {
    cloud.seedNote({
      client_note_id: `client-${i}`,
      content: `note ${i}`,
      created_at: T1,
      updated_at: T1,
    });
  }

  const snapshotFirst = await cloud.request({
    path: `/api/notes/list?limit=50&before=${encodeURIComponent(T2)}`,
  });
  assert.equal(snapshotFirst.success, true);
  assert.equal(snapshotFirst.data.notes.length, 50);
  const snapshotCursor = snapshotFirst.data.notes.at(-1);
  const snapshotSecond = await cloud.request({
    path:
      `/api/notes/list?limit=50&before=${encodeURIComponent(snapshotCursor.created_at)}` +
      `&before_id=${snapshotCursor.id}`,
  });
  assert.deepEqual(
    snapshotSecond.data.notes.map((row) => row.id),
    ["note-0001"]
  );

  const deltaFirst = await cloud.request({
    path: `/api/notes/list?limit=50&since=${encodeURIComponent(T1)}` + "&since_id=note-0000",
  });
  assert.equal(deltaFirst.success, true);
  assert.equal(deltaFirst.data.notes.length, 50);
  const deltaCursor = deltaFirst.data.notes.at(-1);
  const deltaSecond = await cloud.request({
    path:
      `/api/notes/list?limit=50&since=${encodeURIComponent(deltaCursor.updated_at)}` +
      `&since_id=${deltaCursor.id}`,
  });
  assert.deepEqual(
    deltaSecond.data.notes.map((row) => row.id),
    ["note-0051"]
  );
});

// rtech-whisper#211: like the hub, a delta with no since_id is strictly after
// `since`; a row stamped exactly at `since` is served only past a since_id.
test("fake cloud delta without since_id does not serve a row stamped exactly at since", async () => {
  const cloud = createFakeCloud({ uuidSeed: 3 });
  cloud.setClock(() => T1);
  await cloud.request({ method: "POST", path: "/api/notes/create", body: { content: "at T" } });
  cloud.seedTranscription({ text: "at T", updated_at: T1 });

  for (const [path, key] of [
    ["/api/notes/list", "notes"],
    ["/api/transcriptions/list", "transcriptions"],
  ]) {
    const strict = await cloud.request({ path: `${path}?since=${encodeURIComponent(T1)}` });
    assert.deepEqual(strict.data[key], [], `${path} since=T must not serve a row stamped T`);
    const tied = await cloud.request({
      path: `${path}?since=${encodeURIComponent(T1)}&since_id=0`,
    });
    assert.equal(tied.data[key].length, 1, `${path} since=T&since_id serves the tie`);
  }
});

// rtech-whisper#165: transcription ids are varied but replayable from a seed.
test("fake cloud transcription ids replay from the seed and look like Postgres uuids", () => {
  const ids = (seed) => {
    const cloud = createFakeCloud({ uuidSeed: seed });
    return Array.from({ length: 20 }, (_, i) => cloud.seedTranscription({ text: `t${i}` }).id);
  };
  const first = ids("replay-me");
  assert.deepEqual(ids("replay-me"), first, "the same seed yields the same ids");
  assert.notDeepEqual(ids("another-seed"), first, "a different seed yields different ids");
  for (const id of first) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  const sorted = [...first].sort();
  assert.notDeepEqual(first, sorted, "ids must not arrive in hex order, or ties never reorder");
  assert.equal(createFakeCloud({ uuidSeed: 7 }).uuidSeed, "7");
});

// rtech-whisper#185: the transcription write routes store and tombstone rows
// the way the hub does, so a device's own pushes come back on the delta.
test("fake cloud transcription create stores the row, dedupes by client id, and deletes softly", async () => {
  const cloud = createFakeCloud({ uuidSeed: 1 });
  cloud.setClock(() => T2);
  const input = { client_transcription_id: "c-1", text: "hello", created_at: T1 };
  const first = await cloud.request({
    method: "POST",
    path: "/api/transcriptions/batch-create",
    body: { transcriptions: [input] },
  });
  const [created] = first.data.created;
  assert.equal(created.updated_at, T2, "the hub clock stamps updated_at");
  assert.equal(created.created_at, T1);
  const retry = await cloud.request({
    method: "POST",
    path: "/api/transcriptions/create",
    body: input,
  });
  assert.equal(retry.data.id, created.id, "a retried create returns the first row");
  assert.equal(cloud.transcriptions().length, 1);

  const delta = await cloud.request({
    method: "GET",
    path: `/api/transcriptions/list?since=${T1}`,
  });
  assert.deepEqual(
    delta.data.transcriptions.map((r) => r.id),
    [created.id],
    "the delta echoes the pushed row"
  );

  const del = await cloud.request({
    method: "POST",
    path: "/api/transcriptions/batch-delete",
    body: { ids: [created.id, "unknown"] },
  });
  assert.deepEqual(del.data.deleted, [created.id], "only live ids are reported");
  assert.ok(cloud.transcriptions()[0].deleted_at);
  const again = await cloud.request({
    method: "DELETE",
    path: "/api/transcriptions/delete",
    body: { id: created.id },
  });
  assert.equal(again.status, 404, "a deleted id 404s on the single delete");
});

// A hub tombstone is stamped strictly after the row's previous stamp
// (greatest(now, updated_at + 1ms)), so a delta resuming from the create's
// (stamp, id) cursor still serves the delete even under a pinned clock.
// Transcription stamps never read updatedAtClamp, so one config covers it (#212).
test("fake cloud transcription tombstones land after the create stamp", async () => {
  const cloud = createFakeCloud({ uuidSeed: 2 });
  cloud.setClock(() => T2);
  const created = await cloud.request({
    method: "POST",
    path: "/api/transcriptions/create",
    body: { client_transcription_id: "c-1", text: "hello", created_at: T1 },
  });
  const other = await cloud.request({
    method: "POST",
    path: "/api/transcriptions/create",
    body: { client_transcription_id: "c-2", text: "bye", created_at: T1 },
  });
  await cloud.request({
    method: "POST",
    path: "/api/transcriptions/batch-delete",
    body: { ids: [created.data.id] },
  });
  await cloud.request({
    method: "DELETE",
    path: "/api/transcriptions/delete",
    body: { id: other.data.id },
  });
  for (const row of [created.data, other.data]) {
    const delta = await cloud.request({
      method: "GET",
      path: `/api/transcriptions/list?since=${encodeURIComponent(row.updated_at)}&since_id=${row.id}`,
    });
    const served = delta.data.transcriptions.find((r) => r.id === row.id);
    assert.ok(served?.deleted_at, "the delta from the create cursor serves the tombstone");
    assert.ok(
      served.updated_at > row.updated_at,
      "the tombstone stamp moves past the create stamp"
    );
  }

  // A later clock wins over prev + 1ms.
  const later = "2026-07-20T12:00:00.000Z";
  const third = cloud.seedTranscription({ text: "x", updated_at: T2 });
  cloud.setClock(() => later);
  assert.equal(cloud.tombstoneTranscription(third.id).updated_at, later);
});

// rtech-whisper#204: the fake validates transcription writes as the hub's zod
// schemas do, so a bad row fails here instead of only against the real hub.
test("fake cloud rejects an invalid transcription batch whole, and caps batch-delete", async () => {
  const cloud = createFakeCloud({ uuidSeed: 4 });
  const good = { client_transcription_id: "c-1", text: "hello" };
  for (const bad of [
    { text: "no client id" },
    { client_transcription_id: "", text: "x" },
    { client_transcription_id: "c-2", text: null },
    { client_transcription_id: "c-2", text: "x", audio_duration_ms: -1 },
    { client_transcription_id: "c-2", text: "x", audio_duration_ms: 1.5 },
    { client_transcription_id: "c-2", text: "x", status: null },
    { client_transcription_id: "c-2", text: "x", created_at: null },
    { client_transcription_id: "c-2", text: "x", created_at: "not a date" },
  ]) {
    const res = await cloud.request({
      method: "POST",
      path: "/api/transcriptions/batch-create",
      body: { transcriptions: [good, bad] },
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(cloud.transcriptions().length, 0, "one bad row stores none of the batch");

  const tooMany = await cloud.request({
    method: "POST",
    path: "/api/transcriptions/batch-delete",
    body: { ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) },
  });
  assert.equal(tooMany.status, 400, "more than 500 ids is refused");
});

// rtech-whisper#213: the window stub honours `once` and handleEvent listeners
// the way a browser does.
test("window stub dispatch removes once listeners and calls handleEvent objects", () => {
  resetBrowserGlobals();
  const calls = [];
  const once = (event) => calls.push(`once:${event.key}`);
  const handler = { handleEvent: (event) => calls.push(`handle:${event.key}`) };
  windowStub.addEventListener("storage", once, { once: true });
  windowStub.addEventListener("storage", handler);
  assert.equal(windowListenerCount("storage"), 2);
  dispatchWindowEvent("storage", { key: "a" });
  dispatchWindowEvent("storage", { key: "b" });
  assert.deepEqual(calls, ["once:a", "handle:a", "handle:b"]);
  assert.equal(windowListenerCount("storage"), 1, "the once listener is gone");
  resetBrowserGlobals();
});
