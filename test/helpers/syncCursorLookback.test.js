// Delta cursor lookback (rtech-whisper#228, protocol section 8). The hub stamps
// a row before its write commits and serves a delta with no since_id as
// `updated_at > since`, so a row stamped at or below a stored cursor that
// commits after the pass read past it would never be served again. Every
// stored delta cursor therefore sits L = 60 s behind what the pass saw, with
// no id, and a re-pull of a row the device already holds must change nothing.
//
// Notes, folders and transcriptions run the real SyncService over a real
// DatabaseManager and the fake hub. Dictionary and snippets run the real
// SyncService against a small in-test hub (the fake hub stubs those routes)
// and in-memory IPC, so they need no database.

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
const {
  createElectronApi,
  AUTH_TOKEN,
  AUTH_GENERATION,
} = require("./harness/electronApiBridge.js");
const { createFakeCloud, reportUuidSeedOnFailure } = require("./harness/fakeCloud.js");
const {
  SyncService,
  rewindLegacyDeltaCursors,
  DELTA_CURSOR_KEYS,
  CURSOR_VERSION_KEY,
} = require("../../src/services/SyncService.ts");

const L = 60_000;
const EARLIER = "2026-09-01T00:00:00.000Z";
const NOTES = "/api/notes/list";
const FOLDERS = "/api/folders/list";
const TRANSCRIPTIONS = "/api/transcriptions/list";
const DICTIONARY = "/api/dictionary/list";
const SNIPPETS = "/api/snippets/list";

const iso = (ms) => new Date(ms).toISOString();
const pathOf = (opts) => String(opts?.path ?? "").split("?")[0];
const queryOf = (opts) => new URLSearchParams(String(opts?.path ?? "").split("?")[1] ?? "");

// --- DB-backed kinds: notes, folders, transcriptions -------------------------

async function setupDb(t) {
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
  // Delta mode from the first pass: a stored cursor far in the past.
  for (const kind of ["notes", "folders", "transcriptions"]) {
    localStorageStub.setItem(`lastSyncedAt.${kind}`, EARLIER);
  }
  return { db, cloud, api, service };
}

// Runs `after` once, right after the first delta list response for `path`
// (a folder pass lists by name first, with no `since`): the row it writes
// committed after the pass read past it.
function afterFirstList(api, path, after) {
  const request = api.cloudApiRequest;
  let done = false;
  api.cloudApiRequest = async (opts) => {
    const result = await request(opts);
    if (!done && pathOf(opts) === path && queryOf(opts).get("since")) {
      done = true;
      after();
    }
    return result;
  };
}

const LATE_KINDS = [
  {
    kind: "notes",
    path: NOTES,
    seed: (cloud, stamp) =>
      cloud.seedNote({ client_note_id: "cn-late", title: "late", updated_at: stamp }),
    local: (db) => db.getNoteByClientId("cn-late"),
  },
  {
    kind: "folders",
    path: FOLDERS,
    seed: (cloud, stamp) =>
      cloud.seedFolder({ client_folder_id: "cf-late", name: "Late", updated_at: stamp }),
    local: (db) => db.getFolderByClientId("cf-late"),
  },
  {
    kind: "transcriptions",
    path: TRANSCRIPTIONS,
    seed: (cloud, stamp) =>
      cloud.seedTranscription({
        client_transcription_id: "ct-late",
        text: "late",
        updated_at: stamp,
      }),
    local: (db) => db.getTranscriptionByClientId("ct-late"),
  },
];

for (const k of LATE_KINDS) {
  test(`${k.kind}: a row stamped before the pass started that commits after the read lands on the next pass`, async (t) => {
    const ctx = await setupDb(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const passStart = Date.now();
    // Stamped by the hub 5 s before this pass began, committed only after the
    // pass read its delta (an open transaction).
    afterFirstList(api, k.path, () => k.seed(cloud, iso(passStart - 5_000)));

    await service.syncAll(true);
    assert.ok(!k.local(db), "the pass that read past the row cannot have it");
    await service.syncAll(true);

    assert.ok(k.local(db), "the next pass must serve the late-committed row");
  });

  test(`${k.kind}: the stored cursor is the pass-start clock minus 60 s, with no id`, async (t) => {
    const ctx = await setupDb(t);
    if (!ctx) return;
    const { api, service } = ctx;
    // The clock stands still until the pass has read its first page, then
    // jumps past L: a cursor taken at the end of the pass is then told apart
    // from one taken at its start.
    const passStart = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: passStart });
    afterFirstList(api, k.path, () => t.mock.timers.setTime(passStart + 90_000));

    await service.syncAll(true);

    const saved = localStorageStub.getItem(`lastSyncedAt.${k.kind}`);
    assert.equal(saved, iso(passStart - L), "the cursor is the pass start - 60 s, not the end");
    assert.equal(localStorageStub.getItem(`lastSyncedAt.${k.kind}.id`), null);
  });

  test(`${k.kind}: a row stamped during a pass longer than 60 s that commits after the read lands on the next pass`, async (t) => {
    const ctx = await setupDb(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const passStart = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: passStart });
    // Stamped 20 s into the pass, committed after the pass read its page; the
    // pass then runs to 90 s, so pass end - 60 s is past the row's stamp.
    afterFirstList(api, k.path, () => {
      k.seed(cloud, iso(passStart + 20_000));
      t.mock.timers.setTime(passStart + 90_000);
    });

    await service.syncAll(true);
    assert.ok(!k.local(db), "the pass that read past the row cannot have it");
    await service.syncAll(true);

    assert.ok(k.local(db), "the next pass must serve the row stamped mid-pass");
  });
}

// rtech-whisper#239: the notes and folders team cursors. A full pass keeps
// the team cursor current; a backup-off pass is team-only and reads and
// writes only the team cursor.
test("notes and folders: full and team-only passes store the team cursor as the pass-start clock minus 60 s, with no id", async (t) => {
  const ctx = await setupDb(t);
  if (!ctx) return;
  const { service } = ctx;
  const inWindow = (kind, lo, hi) => {
    const saved = localStorageStub.getItem(`lastSyncedAt.${kind}.team`);
    assert.ok(
      saved >= iso(lo - L) && saved <= iso(hi - L),
      `${kind}.team ${saved} is the pass start - 60 s`
    );
    assert.equal(localStorageStub.getItem(`lastSyncedAt.${kind}.team.id`), null);
  };

  let lo = Date.now();
  await service.syncAll(true);
  let hi = Date.now();
  for (const kind of ["notes", "folders"]) inWindow(kind, lo, hi);

  const personal = ["notes", "folders"].map((k) => localStorageStub.getItem(`lastSyncedAt.${k}`));
  for (const kind of ["notes", "folders"]) {
    localStorageStub.setItem(`lastSyncedAt.${kind}.team`, EARLIER);
  }
  localStorageStub.removeItem("cloudBackupEnabled");
  const teamOnly = new SyncService();
  t.after(() => stopSyncTimers(teamOnly));
  lo = Date.now();
  await teamOnly.syncAll(true);
  hi = Date.now();

  for (const kind of ["notes", "folders"]) inWindow(kind, lo, hi);
  assert.deepEqual(
    ["notes", "folders"].map((k) => localStorageStub.getItem(`lastSyncedAt.${k}`)),
    personal,
    "a team-only pass leaves the personal cursors alone"
  );
});

// Every write the pull side can make, by IPC name.
const LOCAL_WRITE = /^(upsert|hardDelete|acknowledge|mark|set|relocate|restore|purge|update)/;
const SYNCED_KIND = /(Note|Folder|Transcription)/;

function spyLocalWrites(api) {
  const calls = [];
  for (const name of Object.keys(api)) {
    if (!LOCAL_WRITE.test(name) || !SYNCED_KIND.test(name) || typeof api[name] !== "function") {
      continue;
    }
    const inner = api[name];
    api[name] = async (...args) => {
      calls.push(name);
      return inner(...args);
    };
  }
  return calls;
}

function recordServed(api) {
  const served = [];
  const request = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    const result = await request(opts);
    const path = pathOf(opts);
    if (result.success && [NOTES, FOLDERS, TRANSCRIPTIONS].includes(path)) {
      const rows = result.data.notes ?? result.data.folders ?? result.data.transcriptions ?? [];
      for (const row of rows) served.push(row.id);
    }
    return result;
  };
  return served;
}

function dump(db) {
  const all = (table) => db.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return { notes: all("notes"), folders: all("folders"), transcriptions: all("transcriptions") };
}

test("a re-pull inside the lookback of rows the device already holds changes nothing", async (t) => {
  const ctx = await setupDb(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;

  // This device's own rows, pushed on the first pass and echoed back.
  const work = db.createFolder("Work").folder;
  db.saveNote("Mine", "body", "personal", null, null, work.id);
  db.saveTranscription("dictated here");
  // Rows another device wrote.
  const theirFolder = cloud.seedFolder({ client_folder_id: "cf-theirs", name: "Theirs" });
  cloud.seedNote({ client_note_id: "cn-theirs", title: "Theirs", folder_id: theirFolder.id });
  cloud.seedTranscription({ client_transcription_id: "ct-theirs", text: "dictated there" });
  // Rows deleted on the hub after this device pulled them: the second pass
  // applies the tombstones, the third is served them again.
  const goneNote = cloud.seedNote({ client_note_id: "cn-gone", title: "gone" });
  const goneTranscription = cloud.seedTranscription({
    client_transcription_id: "ct-gone",
    text: "gone",
  });

  await service.syncAll(true);
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: goneNote.id } });
  cloud.tombstoneTranscription(goneTranscription.id);
  await service.syncAll(true);

  const before = dump(db);
  const served = recordServed(api);
  const writes = spyLocalWrites(api);
  const logBefore = cloud.log.length;
  const eventsBefore = api.syncEvents.length;

  await service.syncAll(true);

  const hubIds = [...cloud.notes(), ...cloud.folders(), ...cloud.transcriptions()].map((r) => r.id);
  for (const id of hubIds) {
    assert.ok(served.includes(id), `row ${id} must be re-served inside the lookback`);
  }
  assert.deepEqual(writes, [], "a re-served unchanged row makes no local write");
  const pushes = cloud.log.slice(logBefore).filter((c) => c.method !== "GET");
  assert.deepEqual(
    pushes.map((c) => `${c.method} ${c.path}`),
    [],
    "a re-served row is never pushed back"
  );
  assert.deepEqual(api.syncEvents.slice(eventsBefore), [], "no UI change event");
  assert.deepEqual(dump(db), before, "no duplicate and no changed row");
});

// --- Dictionary and snippets --------------------------------------------------

const S = "2026-09-20T12:00:00.000Z";
const at = (offsetMs) => iso(Date.parse(S) + offsetMs);
// The device clock for the dictionary and snippet tests: 40 s after S, so the
// next cursor (NOW - L = S - 20 s) keeps every row stamped from S - 20 s on
// inside the window.
const NOW = at(40_000);

function freezeClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
}

// The hub's delta list for dictionary and snippets: `updated_at > since`, or
// `(updated_at, id) > (since, since_id)` with an id, ascending, tombstones
// included (hub src/sync/common.ts listPlan). A cursor always exists here, so
// the snapshot shape is not needed.
function createListHub(path) {
  const rows = new Map();
  const lists = [];
  function list(query) {
    const since = query.get("since");
    const sinceId = query.get("since_id");
    assert.ok(since, `${path} must be a delta pull in these tests`);
    const limit = Number(query.get("limit")) || 100;
    const matching = [...rows.values()]
      .filter(
        (r) => r.updated_at > since || (r.updated_at === since && !!sinceId && r.id > sinceId)
      )
      .sort((a, b) =>
        a.updated_at === b.updated_at
          ? a.id < b.id
            ? -1
            : 1
          : a.updated_at < b.updated_at
            ? -1
            : 1
      );
    lists.push({ since, sinceId, served: matching.slice(0, limit).map((r) => r.id) });
    return {
      entries: matching.slice(0, limit).map((r) => structuredClone(r)),
      hasMore: matching.length > limit,
    };
  }
  return { rows, lists, list, put: (row) => rows.set(row.id, structuredClone(row)) };
}

const LIST_KINDS = [
  {
    kind: "dictionary",
    path: DICTIONARY,
    clientKey: "client_dict_id",
    row: (id, stamp, extra = {}) => ({
      id,
      client_dict_id: `c-${id}`,
      word: id,
      source: "manual",
      deleted_at: null,
      created_at: stamp,
      updated_at: stamp,
      ...extra,
    }),
    api: (local, log) => ({
      getPendingDictionary: async () => [],
      getPendingDictionaryDeletes: async () => [],
      getDictionaryByClientId: async (clientId) => local.get(clientId) ?? null,
      upsertDictionaryFromCloud: async (entry) => {
        log.push(`upsert ${entry.id}`);
        local.set(entry.client_dict_id, { ...entry, cloud_id: entry.id, sync_status: "synced" });
      },
      markDictionarySynced: async () => ({ success: true, changes: 1 }),
      hardDeleteDictionary: async (id) => {
        log.push(`delete ${id}`);
        return { success: true };
      },
      clearDictionaryCloudId: async () => ({ success: true }),
      broadcastDictionaryUpdated: async () => {
        log.push("broadcast");
      },
    }),
    run: (service) => service.syncDictionaryNow(),
  },
  {
    kind: "snippets",
    path: SNIPPETS,
    clientKey: "client_snippet_id",
    row: (id, stamp, extra = {}) => ({
      id,
      client_snippet_id: `c-${id}`,
      trigger: id,
      replacement: `${id} text`,
      deleted_at: null,
      created_at: stamp,
      updated_at: stamp,
      ...extra,
    }),
    api: (local, log) => ({
      getPendingSnippets: async () => [],
      getPendingSnippetDeletes: async () => [],
      getSnippetForCloudMerge: async (entry) => local.get(entry.client_snippet_id) ?? null,
      upsertSnippetFromCloud: async (entry) => {
        log.push(`upsert ${entry.id}`);
        local.set(entry.client_snippet_id, {
          ...entry,
          cloud_id: entry.id,
          sync_status: "synced",
        });
      },
      markSnippetSynced: async () => ({ success: true, changes: 1 }),
      hardDeleteSnippet: async (id) => {
        log.push(`delete ${id}`);
        return { success: true };
      },
      clearSnippetCloudId: async () => ({ success: true }),
      broadcastSnippetsUpdated: async () => {
        log.push("broadcast");
      },
    }),
    run: (service) => service.syncSnippetsNow(),
  },
];

async function setupList(t, k) {
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const hub = createListHub(k.path);
  const local = new Map();
  const log = [];
  const requests = [];
  let onList = null;
  windowStub.electronAPI = {
    authGetTokenState: async () => ({ token: AUTH_TOKEN, generation: AUTH_GENERATION }),
    emitSyncEvent: async () => ({ success: true }),
    cloudApiRequest: async (opts) => {
      requests.push(`${String(opts?.method ?? "GET").toUpperCase()} ${pathOf(opts)}`);
      if (pathOf(opts) !== k.path) return { success: false, status: 404, error: "no route" };
      const data = hub.list(queryOf(opts));
      if (onList) {
        const run = onList;
        onList = null;
        run();
      }
      return { success: true, data };
    },
    ...k.api(local, log),
  };
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  freezeClock(t);
  return {
    hub,
    local,
    log,
    requests,
    service,
    afterNextList: (fn) => {
      onList = fn;
    },
  };
}

for (const k of LIST_KINDS) {
  const key = `lastSyncedAt.${k.kind}`;

  test(`${k.kind}: a row stamped before the pass started that commits after the read lands on the next pass`, async (t) => {
    const { hub, local, service, afterNextList } = await setupList(t, k);
    localStorageStub.setItem(key, EARLIER);
    hub.put(k.row("a", S));
    // Stamped 5 s before the newest row served (and the pass start),
    // committed after the read.
    afterNextList(() => hub.put(k.row("b", at(-5_000))));

    await k.run(service);
    assert.ok(!local.get("c-b"), "the pass that read past the row cannot have it");
    await k.run(service);

    assert.ok(local.get("c-b"), "the next pass must serve the late-committed row");
  });

  test(`${k.kind}: the stored cursor is the pass-start clock minus 60 s, with no id, whatever was served`, async (t) => {
    const { hub, service, afterNextList } = await setupList(t, k);
    const clock = Date.parse(NOW);
    localStorageStub.setItem(key, EARLIER);

    // The newest row served is an hour older than the pass start. The clock
    // jumps past L once the page is read, so a pass-end cursor would differ.
    hub.put(k.row("old", at(-3_600_000)));
    afterNextList(() => t.mock.timers.setTime(clock + 90_000));
    await k.run(service);
    assert.equal(localStorageStub.getItem(key), iso(clock - L), "pass start - 60 s, not the end");
    assert.equal(localStorageStub.getItem(`${key}.id`), null);

    // The newest row served (a tombstone) is stamped after the pass start.
    t.mock.timers.setTime(clock + 5_000);
    hub.put(k.row("new", iso(clock + 600_000), { deleted_at: iso(clock + 600_000) }));
    await k.run(service);
    assert.equal(localStorageStub.getItem(key), iso(clock + 5_000 - L));

    // Nothing served: the cursor still follows the pass start.
    hub.rows.clear();
    t.mock.timers.setTime(clock + 10_000);
    await k.run(service);
    assert.equal(localStorageStub.getItem(key), iso(clock + 10_000 - L));
    assert.equal(localStorageStub.getItem(`${key}.id`), null);
  });

  test(`${k.kind}: a row stamped during a pass longer than 60 s that commits after the read lands on the next pass`, async (t) => {
    const { hub, local, service, afterNextList } = await setupList(t, k);
    const clock = Date.parse(NOW);
    localStorageStub.setItem(key, EARLIER);
    hub.put(k.row("a", S));
    // Stamped 20 s into the pass, committed after the read; the pass then
    // runs to 90 s, so pass end - 60 s is past the row's stamp.
    afterNextList(() => {
      hub.put(k.row("mid", iso(clock + 20_000)));
      t.mock.timers.setTime(clock + 90_000);
    });

    await k.run(service);
    assert.ok(!local.get("c-mid"), "the pass that read past the row cannot have it");
    await k.run(service);

    assert.ok(local.get("c-mid"), "the next pass must serve the row stamped mid-pass");
  });

  test(`${k.kind}: a failed pass leaves the cursor where it was`, async (t) => {
    const { service } = await setupList(t, k);
    localStorageStub.setItem(CURSOR_VERSION_KEY, "2");
    localStorageStub.setItem(key, S);
    windowStub.electronAPI.cloudApiRequest = async () => ({
      success: false,
      status: 503,
      error: "unavailable",
    });

    await k.run(service);

    assert.equal(localStorageStub.getItem(key), S);
  });

  test(`${k.kind}: an upgraded cursor saved with its id is read 60 s earlier once, and the id dropped`, async (t) => {
    const { hub, service } = await setupList(t, k);
    localStorageStub.setItem(key, S);
    localStorageStub.setItem(`${key}.id`, "a");

    await k.run(service);
    await k.run(service);

    assert.deepEqual(hub.lists[0], { since: at(-L), sinceId: null, served: [] });
    // The second pass reads the cursor the first stored, not moved again.
    assert.deepEqual(hub.lists[1], { since: iso(Date.parse(NOW) - L), sinceId: null, served: [] });
    assert.equal(localStorageStub.getItem(`${key}.id`), null);
  });

  test(`${k.kind}: a re-pull inside the lookback of rows the device already holds changes nothing`, async (t) => {
    const { hub, local, log, requests, service } = await setupList(t, k);
    localStorageStub.setItem(key, EARLIER);
    hub.put(k.row("a", at(-2_000)));
    hub.put(k.row("b", S));
    // A tombstone for a row this device never held.
    hub.put(k.row("gone", at(-1_000), { deleted_at: at(-1_000) }));

    await k.run(service);
    assert.deepEqual(log.sort(), ["broadcast", "upsert a", "upsert b"]);
    const held = structuredClone([...local.entries()]);
    log.length = 0;
    requests.length = 0;

    await k.run(service);

    assert.deepEqual(hub.lists.at(-1).served.sort(), ["a", "b", "gone"], "all rows re-served");
    assert.deepEqual(log, [], "no local write, no delete, no change broadcast");
    assert.deepEqual(requests, [`GET ${k.path}`], "nothing is pushed back");
    assert.deepEqual([...local.entries()], held, "no duplicate and no changed row");
  });
}

// --- Re-served rows over a real database: dictionary and snippets ------------
//
// The lookback re-serves the newest rows on every idle pass, so each re-pull
// must be idempotent over the real merge SQL, and must never overwrite a
// pending local edit. Pushes to the hub fail with 503 here: the edit stays
// pending, as it does offline or on stamp_budget_exceeded.

async function setupListDb(t, path) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const hub = createListHub(path);
  const log = [];
  const logged =
    (name, fn) =>
    async (...args) => {
      log.push(name);
      return fn(...args);
    };
  windowStub.electronAPI = {
    authGetTokenState: async () => ({ token: AUTH_TOKEN, generation: AUTH_GENERATION }),
    emitSyncEvent: async () => ({ success: true }),
    cloudApiRequest: async (opts) =>
      pathOf(opts) === path && String(opts?.method ?? "GET").toUpperCase() === "GET"
        ? { success: true, data: hub.list(queryOf(opts)) }
        : { success: false, status: 503, error: "stamp_budget_exceeded" },
    getPendingDictionary: async () => db.getPendingDictionary(),
    getPendingDictionaryDeletes: async () => db.getPendingDictionaryDeletes(),
    getDictionaryByClientId: async (id) => db.getDictionaryEntryByClientId(id) ?? null,
    upsertDictionaryFromCloud: logged("upsert", async (e) => db.upsertDictionaryFromCloud(e)),
    markDictionarySynced: logged("mark", async (id, c) => db.markDictionaryEntrySynced(id, c)),
    hardDeleteDictionary: logged("delete", async (id) => db.hardDeleteDictionaryEntry(id)),
    clearDictionaryCloudId: logged("clear", async (id) => db.clearDictionaryCloudId(id)),
    broadcastDictionaryUpdated: logged("broadcast", async () => undefined),
    getPendingSnippets: async () => db.getPendingSnippets(),
    getPendingSnippetDeletes: async () => db.getPendingSnippetDeletes(),
    getSnippetForCloudMerge: async (e) => db.getSnippetForCloudMerge(e) ?? null,
    upsertSnippetFromCloud: logged("upsert", async (e) => db.upsertSnippetFromCloud(e)),
    markSnippetSynced: logged("mark", async (...a) => db.markSnippetSynced(...a)),
    hardDeleteSnippet: logged("delete", async (id) => db.hardDeleteSnippet(id)),
    clearSnippetCloudId: logged("clear", async (id) => db.clearSnippetCloudId(id)),
    broadcastSnippetsUpdated: logged("broadcast", async () => undefined),
  };
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  freezeClock(t);
  return { db, hub, log, service };
}

const snippetRow = (id, trigger, stamp, extra = {}) => ({
  id,
  client_snippet_id: `c-${id}`,
  trigger,
  replacement: `${id} text`,
  deleted_at: null,
  created_at: stamp,
  updated_at: stamp,
  ...extra,
});

const dictRow = (id, word, stamp, extra = {}) => ({
  id,
  client_dict_id: `c-${id}`,
  word,
  source: "manual",
  deleted_at: null,
  created_at: stamp,
  updated_at: stamp,
  ...extra,
});

const liveSnippets = (db) =>
  db.db.prepare("SELECT * FROM snippets WHERE deleted_at IS NULL ORDER BY id").all();

// The negative assertions below also hold for a pull that threw part-way
// (pullSnippets/pullDictionary swallow errors), so each test also proves the
// pull ran to the end: the cursor moved and the hub served the seeded rows
// (rtech-whisper#247). The clock is frozen, so every pass writes the same
// cursor; a multi-pass test calls resetCursor() before its LAST pass, so the
// cursor check proves that pass, not an earlier one, reached its write.
function resetCursor(kind) {
  localStorageStub.setItem(`lastSyncedAt.${kind}`, EARLIER);
}

function assertPullCompleted(hub, kind, ids) {
  assert.equal(
    localStorageStub.getItem(`lastSyncedAt.${kind}`),
    iso(Date.parse(NOW) - L),
    "the pull stored its cursor"
  );
  assert.deepEqual(
    [...hub.lists.at(-1).served].sort(),
    [...ids].sort(),
    "the seeded rows were served"
  );
}

test("snippets: a re-served tombstone never deletes a live row that reuses its trigger", async (t) => {
  const ctx = await setupListDb(t, SNIPPETS);
  if (!ctx) return;
  const { db, hub, log, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.snippets", EARLIER);
  // 'foo' deleted at S (cloud A), recreated 30 s later (cloud B): both sit
  // inside the lookback, so every idle pass serves A then B.
  hub.put(snippetRow("A", "foo", S, { deleted_at: S }));
  hub.put(snippetRow("B", "foo", at(30_000)));
  db.upsertSnippetFromCloud(hub.rows.get("B"));
  const [held] = liveSnippets(db);

  await service.syncSnippetsNow();
  resetCursor("snippets");
  await service.syncSnippetsNow();

  assert.deepEqual(log, [], "no hard-delete, no re-insert, no broadcast");
  assert.deepEqual(liveSnippets(db), [held], "the live row keeps its local id");
  assertPullCompleted(hub, "snippets", ["A", "B"]);
});

test("snippets: a pending edit survives the re-served tombstone and row", async (t) => {
  const ctx = await setupListDb(t, SNIPPETS);
  if (!ctx) return;
  const { db, hub, log, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.snippets", EARLIER);
  hub.put(snippetRow("A", "foo", S, { deleted_at: S }));
  hub.put(snippetRow("B", "foo", at(30_000)));
  db.upsertSnippetFromCloud(hub.rows.get("B"));
  db.setSnippets([{ trigger: "foo", replacement: "edited" }]);
  // The edit's device stamp trails the hub stamp (clock skew).
  db.db.prepare("UPDATE snippets SET updated_at = ?").run("2026-09-20 12:00:10");

  await service.syncSnippetsNow();
  resetCursor("snippets");
  await service.syncSnippetsNow();

  assert.deepEqual(log, [], "the failed PATCH leaves the edit alone; nothing is pulled over it");
  const [row] = liveSnippets(db);
  assert.equal(row.replacement, "edited");
  assert.equal(row.sync_status, "pending");
  assert.equal(row.cloud_id, "B");
  assertPullCompleted(hub, "snippets", ["A", "B"]);
});

test("dictionary: two cloud rows for one word re-served each pass write nothing after the first", async (t) => {
  const ctx = await setupListDb(t, DICTIONARY);
  if (!ctx) return;
  const { db, hub, log, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.dictionary", EARLIER);
  // Two devices each added the word within the lookback; the hub keeps both.
  hub.put(dictRow("CA", "Kubernetes", at(-10_000)));
  hub.put(dictRow("CB", "Kubernetes", S));
  db.upsertDictionaryFromCloud(hub.rows.get("CA"));

  await service.syncDictionaryNow();
  const settled = db.db.prepare("SELECT * FROM custom_dictionary").all();
  log.length = 0;

  await service.syncDictionaryNow();
  resetCursor("dictionary");
  await service.syncDictionaryNow();

  assert.deepEqual(
    log.filter((e) => e !== "upsert"),
    [],
    "no write and no broadcast"
  );
  assert.deepEqual(db.db.prepare("SELECT * FROM custom_dictionary").all(), settled);
  assertPullCompleted(hub, "dictionary", ["CA", "CB"]);
});

test("dictionary: a pending local delete is not resurrected by the re-served row", async (t) => {
  const ctx = await setupListDb(t, DICTIONARY);
  if (!ctx) return;
  const { db, hub, log, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.dictionary", EARLIER);
  hub.put(dictRow("W", "Grafana", S));
  db.upsertDictionaryFromCloud(hub.rows.get("W"));
  db.applyDictionaryChanges({ remove: ["Grafana"] });
  // The delete's device stamp trails the hub stamp (clock skew).
  db.db.prepare("UPDATE custom_dictionary SET updated_at = ?").run("2026-09-19 12:00:00");

  await service.syncDictionaryNow();
  await service.syncDictionaryNow();

  assert.deepEqual(log, [], "nothing pulled over the pending delete");
  const row = db.db.prepare("SELECT * FROM custom_dictionary").get();
  assert.ok(row.deleted_at, "still deleted");
  assert.equal(row.sync_status, "pending");
  assert.deepEqual(db.getDictionary(), []);
  assertPullCompleted(hub, "dictionary", ["W"]);
});

test("dictionary: a pending local edit is not overwritten by the re-served row", async (t) => {
  const ctx = await setupListDb(t, DICTIONARY);
  if (!ctx) return;
  const { db, hub, log, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.dictionary", EARLIER);
  hub.put(dictRow("W", "grafana", S));
  db.upsertDictionaryFromCloud(hub.rows.get("W"));
  db.applyDictionaryChanges({ add: ["Grafana"] });
  db.db.prepare("UPDATE custom_dictionary SET updated_at = ?").run("2026-09-19 12:00:00");

  await service.syncDictionaryNow();

  assert.deepEqual(log, []);
  assert.deepEqual(db.getDictionary(), ["Grafana"]);
  assertPullCompleted(hub, "dictionary", ["W"]);
});

test("snippets: a pending edit is not overwritten by the re-served row", async (t) => {
  const ctx = await setupListDb(t, SNIPPETS);
  if (!ctx) return;
  const { db, hub, log, service } = ctx;
  localStorageStub.setItem("lastSyncedAt.snippets", EARLIER);
  hub.put(snippetRow("B", "foo", S));
  db.upsertSnippetFromCloud(hub.rows.get("B"));
  db.setSnippets([{ trigger: "foo", replacement: "edited" }]);
  db.db.prepare("UPDATE snippets SET updated_at = ?").run("2026-09-19 12:00:00");

  await service.syncSnippetsNow();

  assert.deepEqual(log, []);
  assert.equal(liveSnippets(db)[0].replacement, "edited");
  assertPullCompleted(hub, "snippets", ["B"]);
});

// --- One-time rewind of cursors stored before the lookback --------------------
//
// A cursor stored before the upgrade can sit past a row that was stamped but
// not yet committed when that pass read. It moves back L once, with its id
// dropped; a kind with no cursor keeps none, so a fresh install snapshots.

test("the upgrade rewind moves each stored cursor back exactly 60 s once and drops its id", () => {
  resetBrowserGlobals();
  installBrowserGlobals();
  const stored = {};
  DELTA_CURSOR_KEYS.forEach((key, i) => {
    stored[key] = iso(Date.parse(S) + i * 1_000);
    localStorageStub.setItem(key, stored[key]);
    localStorageStub.setItem(`${key}.id`, `id-${i}`);
  });
  // A stamp finer than a millisecond truncates to the millisecond.
  localStorageStub.setItem("lastSyncedAt.notes.team", "2026-09-20T12:00:00.123456Z");
  stored["lastSyncedAt.notes.team"] = "2026-09-20T12:00:00.123Z";

  rewindLegacyDeltaCursors();
  rewindLegacyDeltaCursors();

  assert.deepEqual([...DELTA_CURSOR_KEYS].sort(), [
    "lastSyncedAt.dictionary",
    "lastSyncedAt.folders",
    "lastSyncedAt.folders.team",
    "lastSyncedAt.notes",
    "lastSyncedAt.notes.team",
    "lastSyncedAt.snippets",
    "lastSyncedAt.transcriptions",
  ]);
  for (const key of DELTA_CURSOR_KEYS) {
    assert.equal(localStorageStub.getItem(key), iso(Date.parse(stored[key]) - L), key);
    assert.equal(localStorageStub.getItem(`${key}.id`), null, `${key}.id`);
  }
  assert.equal(localStorageStub.getItem(CURSOR_VERSION_KEY), "2");
});

test("the upgrade rewind leaves a fresh install with no cursor", () => {
  resetBrowserGlobals();
  installBrowserGlobals();

  rewindLegacyDeltaCursors();

  for (const key of DELTA_CURSOR_KEYS) assert.equal(localStorageStub.getItem(key), null, key);
  assert.equal(localStorageStub.getItem(CURSOR_VERSION_KEY), "2");
});

test("the upgrade rewind removes a cursor it cannot parse and still sets the marker", () => {
  resetBrowserGlobals();
  installBrowserGlobals();
  // Month 13: Date.parse gives NaN (a bare word would not: the ".000Z" the
  // normalizer appends makes V8 read it as 2000-01-01).
  localStorageStub.setItem("lastSyncedAt.notes", "2026-13-45T99:99:99");
  localStorageStub.setItem("lastSyncedAt.notes.id", "id-x");

  rewindLegacyDeltaCursors();

  assert.equal(localStorageStub.getItem("lastSyncedAt.notes"), null, "the kind snapshots again");
  assert.equal(localStorageStub.getItem("lastSyncedAt.notes.id"), null);
  assert.equal(localStorageStub.getItem(CURSOR_VERSION_KEY), "2");
});

test("the upgrade rewind runs before a pass reads its cursor, and only on the first pass", async (t) => {
  const ctx = await setupDb(t);
  if (!ctx) return;
  const { api, service } = ctx;
  const legacy = iso(Date.now() - 10_000);
  for (const kind of ["notes", "folders", "transcriptions"]) {
    localStorageStub.setItem(`lastSyncedAt.${kind}`, legacy);
  }
  localStorageStub.setItem("lastSyncedAt.transcriptions.id", "legacy-id");
  const sinces = [];
  const request = api.cloudApiRequest;
  api.cloudApiRequest = async (opts) => {
    const q = queryOf(opts);
    if (q.get("since"))
      sinces.push({ path: pathOf(opts), since: q.get("since"), id: q.get("since_id") });
    return request(opts);
  };

  const lo = Date.now();
  await service.syncAll(true);
  const first = sinces.splice(0);
  await service.syncAll(true);

  for (const path of [NOTES, FOLDERS, TRANSCRIPTIONS]) {
    const firstList = first.find((s) => s.path === path);
    assert.deepEqual(firstList, { path, since: iso(Date.parse(legacy) - L), id: null }, path);
    const next = Date.parse(sinces.find((s) => s.path === path).since);
    assert.ok(next >= lo - L, `${path}: the second pass is not rewound again`);
  }
});

for (const k of LATE_KINDS) {
  test(`${k.kind}: a row stamped 2 s before an old cursor that committed late lands on the first pass after the upgrade`, async (t) => {
    const ctx = await setupDb(t);
    if (!ctx) return;
    const { db, cloud, service } = ctx;
    const legacy = Date.now() - 10_000;
    // The old pass stored the newest stamp it saw; this row was stamped 2 s
    // earlier and committed after that pass read.
    localStorageStub.setItem(`lastSyncedAt.${k.kind}`, iso(legacy));
    k.seed(cloud, iso(legacy - 2_000));

    await service.syncAll(true);

    assert.ok(k.local(db), "the first pass after the upgrade must serve the row");
  });
}

for (const k of [
  {
    kind: "dictionary",
    path: DICTIONARY,
    seed: (hub) => hub.put(dictRow("L", "Late", at(-2_000))),
    local: (db) => db.getDictionary().includes("Late"),
    run: (s) => s.syncDictionaryNow(),
  },
  {
    kind: "snippets",
    path: SNIPPETS,
    seed: (hub) => hub.put(snippetRow("L", "late", at(-2_000))),
    local: (db) => liveSnippets(db).some((r) => r.cloud_id === "L"),
    run: (s) => s.syncSnippetsNow(),
  },
]) {
  test(`${k.kind}: a row stamped 2 s before an old cursor that committed late lands on the first pass after the upgrade`, async (t) => {
    const ctx = await setupListDb(t, k.path);
    if (!ctx) return;
    const { db, hub, service } = ctx;
    // An old cursor stored with no id: read as-is before the upgrade.
    localStorageStub.setItem(`lastSyncedAt.${k.kind}`, S);
    k.seed(hub);

    await k.run(service);

    assert.ok(k.local(db), "the first pass after the upgrade must serve the row");
    assert.equal(hub.lists[0].since, at(-L));
  });
}
