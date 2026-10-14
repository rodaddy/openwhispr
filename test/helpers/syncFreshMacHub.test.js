// A fresh Mac joining the hub (item 3): an empty local
// database with hub mode on pulls every live hub folder and note, files them,
// and pushes nothing back as a create. The second pass is a no-op.
//
// Layers that are real here: SyncService, the note/folder services it calls,
// DatabaseManager over a real SQLite file, hub mode (refreshHubMode reads the
// URL and device key from the bridge; no account flags, no sign-in session),
// and the main-process hub bridge (createHubBridge -> cloudApiRequest
// handler: URL, bearer, error mapping).
// Faked: the network, as a hub that answers the docs/protocol.md v1 shapes
// (rtech-whisper-hub, docs/1-setup), and the preload IPC hop, which
// hubSyncBridge.test.js already covers.
//
// better-sqlite3 in this repo is built for Electron's ABI, so under plain node
// these tests skip like the rest of the sync harness. Run them for real with:
//   ELECTRON_RUN_AS_NODE=1 <electron binary> --import tsx --test test/helpers/syncFreshMacHub.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  stopSyncTimers,
  localStorage: browserLocalStorage,
  window: browserWindow,
} = require("./harness/browserGlobals.js");
const {
  createElectronApi,
  AUTH_TOKEN,
  AUTH_GENERATION,
} = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { createHubBridge } = require("../../src/helpers/hubSync");
const { SyncService } = require("../../src/services/SyncService.ts");
const hubMode = require("../../src/lib/hubMode.ts");
const authContext = require("../../src/lib/authRequestContext.ts");

installBrowserGlobals();

const HUB_URL = "https://hub.example.test:8787";
// The account-era consent flags. Hub mode must not need any of them.
const ACCOUNT_FLAGS = ["isSignedIn", "cloudBackupEnabled", "isSubscribed"];
const HUB_T0 = "2026-07-01T09:00:00.000Z";

function at(minutes) {
  return new Date(Date.parse(HUB_T0) + minutes * 60_000).toISOString();
}

function isWrite(call) {
  return call.method !== "GET";
}

// The hub's list routes hand back tombstones (protocol.md 3 and 4), which the
// generic fake cloud hides from a snapshot. Folders are unpaginated; note
// snapshots page by created_at desc, id desc from before/before_id.
function hubList(cloud, pathname, query) {
  if (query.get("since")) return null;
  if (pathname === "/api/folders/list") {
    const rows = cloud.folders();
    rows.sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
    return { folders: rows };
  }
  if (pathname === "/api/notes/list") {
    const limit = Number(query.get("limit")) || 50;
    const before = query.get("before");
    const beforeId = query.get("before_id");
    const key = (r) => `${r.created_at}|${r.id}`;
    let rows = cloud.notes().sort((a, b) => (key(a) < key(b) ? 1 : -1));
    if (before) {
      const bound = `${new Date(before).toISOString()}|${beforeId ?? ""}`;
      rows = rows.filter((r) =>
        beforeId ? key(r) < bound : r.created_at < new Date(before).toISOString()
      );
    }
    return { notes: rows.slice(0, limit) };
  }
  return null;
}

// The hub as the desktop sees it over HTTP. Every request is recorded with its
// response before the client gets it.
function createHub({ beforeBatchCreate, failFolderListOnce = false, spacesReply } = {}) {
  const cloud = createFakeCloud();
  const requests = [];
  let folderListFailures = failFolderListOnce ? 1 : 0;

  async function proxyFetch(url, init) {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const record = {
      method,
      path: `${pathname}${parsed.search}`,
      pathname,
      query: parsed.searchParams,
      authorization: init.headers.Authorization,
      body,
    };
    requests.push(record);

    const reply = (status, payload) => {
      record.status = status;
      record.response = structuredClone(payload);
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };

    // A hub that answers the spaces probe instead of 404ing.
    if (spacesReply && pathname === "/api/me/spaces") return reply(200, spacesReply);
    // Not in hub v1 (protocol.md 2 and 10): spaces, conversations, analytics.
    if (
      pathname === "/api/me/spaces" ||
      pathname.startsWith("/api/me/") ||
      pathname.startsWith("/api/conversations/") ||
      pathname.startsWith("/api/analytics/")
    ) {
      return reply(404, { error: { message: "not in hub v1" }, code: "not_found", data: null });
    }

    // Live folder names are unique per owner (protocol.md 3). A default that
    // clashes with a default hands back the existing row; any other clash is
    // a 409 for the whole request.
    if (method === "GET" && pathname === "/api/folders/list" && folderListFailures > 0) {
      folderListFailures -= 1;
      return reply(503, { error: { message: "busy" }, code: "upstream_busy", data: null });
    }

    if (method === "POST" && /^\/api\/folders\/(batch-)?create$/.test(pathname)) {
      const batch = pathname.endsWith("batch-create");
      if (batch && beforeBatchCreate) beforeBatchCreate(cloud);
      const inputs = batch ? (body?.folders ?? []) : [body ?? {}];
      const live = cloud.folders().filter((f) => !f.deleted_at);
      const adopted = [];
      for (const input of inputs) {
        const clash = live.find(
          (f) => f.name === input.name && f.client_folder_id !== input.client_folder_id
        );
        if (clash && !(clash.is_default && input.is_default)) {
          return reply(409, {
            error: { message: "folder name taken" },
            code: "folder_name_taken",
            data: null,
          });
        }
        adopted.push(clash ?? null);
      }
      if (adopted.every(Boolean)) return reply(200, batch ? { created: adopted } : adopted[0]);
    }

    const listed = method === "GET" ? hubList(cloud, pathname, parsed.searchParams) : null;
    if (listed) return reply(200, listed);

    const result = await cloud.request({ method, path: record.path, body });
    if (result.success) return reply(200, result.data);
    return reply(result.status ?? 500, {
      error: { message: result.error },
      code: result.code ?? null,
      data: null,
    });
  }

  const bridge = createHubBridge({
    getHubUrl: () => HUB_URL,
    saveHubUrl: () => {},
    // The renderer's validated generation comes from the harness bridge; the
    // device key store answers the same state so the request fence holds.
    tokenStore: {
      getState: () => ({ token: AUTH_TOKEN, generation: AUTH_GENERATION }),
      set: () => ({ success: true }),
      clear: () => ({ success: true }),
    },
    getAppVersion: () => "2.0.5",
    proxyFetch,
    logger: { error: () => {} },
  });

  return {
    cloud,
    requests,
    transport: { request: (opts) => bridge.request(opts) },
    keyBridge: { getUrl: () => bridge.getUrl(), getKeyState: () => bridge.getKeyState() },
  };
}

async function syncPass(db, hub, storage) {
  browserLocalStorage.clear();
  for (const [k, v] of Object.entries(storage)) browserLocalStorage.setItem(k, v);
  for (const flag of ACCOUNT_FLAGS) {
    assert.equal(browserLocalStorage.getItem(flag), null, `hub mode must not need ${flag}`);
  }
  browserWindow.electronAPI = createElectronApi(db, { cloud: hub.transport, hub: hub.keyBridge });
  // No sign-in session: hub mode (URL + device key) is the only consent.
  authContext.resetAuthRequestContextForTests();
  hubMode.resetHubModeForTests();
  const service = new SyncService();
  try {
    await service.syncAll(true);
    assert.equal(hubMode.isHubMode(), true, "the pass must run in hub mode");
    assert.equal(authContext.getValidatedAuthGeneration(), AUTH_GENERATION);
  } finally {
    stopSyncTimers(service);
    hubMode.resetHubModeForTests();
  }
  const next = {};
  for (let i = 0; i < browserLocalStorage.length; i += 1) {
    const key = browserLocalStorage.key(i);
    next[key] = browserLocalStorage.getItem(key);
  }
  return next;
}

function localFolders(db) {
  return db.db.prepare("SELECT * FROM folders ORDER BY id").all();
}

function localNotes(db) {
  return db.db.prepare("SELECT * FROM notes ORDER BY id").all();
}

// What another device (the iPhone, or the first Mac) already put on the hub.
async function seedHub(cloud) {
  // Pin every hub stamp, tombstones included, well in the past.
  cloud.setClock(() => at(300));
  const personal = cloud.seedFolder({
    client_folder_id: "hub-personal",
    name: "Personal",
    is_default: true,
    sort_order: 0,
    created_at: at(0),
  });
  const meetings = cloud.seedFolder({
    client_folder_id: "hub-meetings",
    name: "Meetings",
    is_default: true,
    sort_order: 1,
    created_at: at(0),
  });
  // The first Mac also pushed its other seeded folders.
  const videos = cloud.seedFolder({
    client_folder_id: "hub-videos",
    name: "Videos",
    is_default: true,
    sort_order: 2,
    created_at: at(0),
  });
  const grill = cloud.seedFolder({
    client_folder_id: "hub-grill",
    name: "Grill",
    is_default: false,
    sort_order: 3,
    created_at: at(0),
  });
  const lifeStory = cloud.seedFolder({
    client_folder_id: "hub-life-story",
    name: "Life Story",
    is_default: false,
    sort_order: 4,
    created_at: at(0),
  });
  const projects = cloud.seedFolder({
    client_folder_id: "hub-projects",
    name: "Projects",
    is_default: false,
    sort_order: 5,
    created_at: at(1),
  });
  const gone = cloud.seedFolder({
    client_folder_id: "hub-gone",
    name: "Old Stuff",
    is_default: false,
    sort_order: 6,
    created_at: at(1),
  });
  await cloud.request({ method: "DELETE", path: "/api/folders/delete", body: { id: gone.id } });

  // 57 live notes, more than one 50-row snapshot page, across the folders.
  const homes = [personal, meetings, videos, grill, lifeStory, projects];
  const live = [];
  for (let i = 0; i < 57; i += 1) {
    const folder = homes[i % homes.length];
    live.push(
      cloud.seedNote({
        client_note_id: `hub-note-${String(i).padStart(2, "0")}`,
        title: `Hub note ${i}`,
        content: `body ${i}`,
        note_type: folder === meetings ? "meeting" : "personal",
        folder_id: folder.id,
        created_at: at(10 + i),
      })
    );
  }
  const deleted = cloud.seedNote({
    client_note_id: "hub-note-deleted",
    title: "Deleted on the phone",
    content: "should never reach this Mac",
    folder_id: personal.id,
    created_at: at(200),
  });
  await cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: deleted.id } });

  return { personal, meetings, videos, grill, lifeStory, projects, gone, live, deleted };
}

test("a fresh Mac's first hub sync pulls everything, files it, and pushes nothing new", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub();
  const seeded = await seedHub(hub.cloud);
  const hubFoldersBefore = hub.cloud.folders();
  const hubNotesBefore = hub.cloud.notes();

  // Precondition: a fresh install. No notes, only the seeded folders, none of
  // them known to the hub yet.
  assert.equal(localNotes(db).length, 0);
  assert.deepEqual(
    localFolders(db).map((f) => [f.name, f.is_default, f.cloud_id]),
    [
      ["Personal", 1, null],
      ["Meetings", 1, null],
      ["Videos", 1, null],
      ["Grill", 0, null],
      ["Life Story", 0, null],
    ]
  );

  // No step of a hub pass may fail: the conversation routes the hub does not
  // serve (protocol 12) are not called at all.
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(String(message)));

  const storage = await syncPass(db, hub, {});

  assert.ok(hub.requests.length > 0, "the pass must have reached the hub");
  const snapshotPages = hub.requests.filter(
    (r) => r.pathname === "/api/notes/list" && !r.query.get("since")
  );
  assert.ok(snapshotPages.length >= 2, "57 notes must take more than one snapshot page");
  for (const r of hub.requests) {
    assert.equal(r.authorization, `Bearer ${AUTH_TOKEN}`, `${r.path} must carry the device key`);
  }

  // Nothing went up as a create, and nothing was written at all.
  const writes = hub.requests.filter(isWrite);
  assert.deepEqual(
    writes.map((r) => `${r.method} ${r.pathname}`),
    [],
    "a fresh Mac must not write anything back to the hub on its first pass"
  );

  // Folders: the local seeds adopted the hub's identity instead of becoming
  // duplicates; the custom folder came down; the tombstone did not.
  const folders = localFolders(db);
  const byName = new Map(folders.map((f) => [f.name, f]));
  assert.deepEqual([...byName.keys()].sort(), [
    "Grill",
    "Life Story",
    "Meetings",
    "Personal",
    "Projects",
    "Videos",
  ]);
  assert.equal(folders.length, 6, "no duplicate seeded folder rows");
  for (const [name, hubRow] of [
    ["Personal", seeded.personal],
    ["Meetings", seeded.meetings],
    ["Videos", seeded.videos],
    ["Grill", seeded.grill],
    ["Life Story", seeded.lifeStory],
    ["Projects", seeded.projects],
  ]) {
    const row = byName.get(name);
    assert.equal(row.cloud_id, hubRow.id, `${name} must carry the hub id`);
    assert.equal(
      row.client_folder_id,
      hubRow.client_folder_id,
      `${name} must adopt the hub client id`
    );
    assert.equal(row.sync_status, "synced", `${name} must not be left pending`);
  }

  // Notes: every live hub note, filed in the local folder mapped to its hub
  // folder, synced, with its hub identity. The tombstone stays off this Mac.
  const notes = localNotes(db);
  assert.equal(notes.length, seeded.live.length);
  const localFolderByCloudId = new Map(folders.map((f) => [f.cloud_id, f.id]));
  const localByClient = new Map(notes.map((n) => [n.client_note_id, n]));
  for (const hubNote of seeded.live) {
    const row = localByClient.get(hubNote.client_note_id);
    assert.ok(row, `${hubNote.client_note_id} must be pulled`);
    assert.equal(row.cloud_id, hubNote.id);
    assert.equal(row.content, hubNote.content);
    assert.equal(row.folder_id, localFolderByCloudId.get(hubNote.folder_id));
    assert.equal(row.sync_status, "synced", `${hubNote.client_note_id} must not be pending`);
  }
  assert.equal(localByClient.has("hub-note-deleted"), false);

  // The hub is untouched: same rows, same stamps.
  assert.deepEqual(hub.cloud.folders(), hubFoldersBefore);
  assert.deepEqual(hub.cloud.notes(), hubNotesBefore);

  // Second pass: the cursors from pass one turn both pulls into deltas that
  // return nothing, and still nothing is pushed.
  const mark = hub.requests.length;
  await syncPass(db, hub, storage);
  const second = hub.requests.slice(mark);

  assert.deepEqual(
    second.filter(isWrite).map((r) => `${r.method} ${r.pathname}`),
    [],
    "the second pass must push nothing"
  );
  const noteLists = second.filter((r) => r.pathname === "/api/notes/list");
  const folderLists = second.filter((r) => r.pathname === "/api/folders/list");
  assert.ok(noteLists.length > 0 && folderLists.length > 0, "the second pass still asks the hub");
  for (const r of [...noteLists, ...folderLists]) {
    assert.ok(r.query.get("since"), `${r.path} must be a delta, not another snapshot`);
  }
  assert.deepEqual(
    noteLists.flatMap((r) => r.response.notes),
    [],
    "the note delta must return nothing"
  );
  assert.deepEqual(
    folderLists.flatMap((r) => r.response.folders),
    [],
    "the folder delta must return nothing"
  );
  assert.equal(localNotes(db).length, seeded.live.length);
  assert.equal(localFolders(db).length, 6);
  assert.deepEqual(hub.cloud.notes(), hubNotesBefore);
  assert.deepEqual(errors, [], "no sync step may fail");
  assert.deepEqual(
    hub.requests.filter((r) => r.pathname.startsWith("/api/conversations/")).map((r) => r.path),
    [],
    "hub mode must not call the conversation routes the hub does not serve"
  );
});

// A local folder the hub does not know yet, holding one note.
function localFolderWithNote(db, name) {
  const folder = db.createFolder(name).folder;
  const note = db.saveNote(`In ${name}`, "body", "personal", null, null, folder.id).note;
  return { folder, note };
}

function hubNoteFor(hub, clientNoteId) {
  return hub.cloud.notes().find((n) => n.client_note_id === clientNoteId);
}

// A note may wait for its folder, but it never reaches the hub unfiled.
function assertHeldOrFiledIn(hub, clientNoteId, cloudFolderId) {
  const row = hubNoteFor(hub, clientNoteId);
  if (row) assert.equal(row.folder_id, cloudFolderId, "the note must be filed, not unfiled");
}

test("a local folder whose exact name is already on the hub is adopted, not 409'd", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub();
  const seeded = await seedHub(hub.cloud);
  const projects = localFolderWithNote(db, "Projects");
  const work = localFolderWithNote(db, "Work");
  t.mock.method(console, "error", () => {});

  await syncPass(db, hub, {});

  const folders = new Map(localFolders(db).map((f) => [f.name, f]));
  assert.equal(folders.get("Projects").cloud_id, seeded.projects.id, "Projects adopts the hub row");
  assert.equal(folders.get("Projects").id, projects.folder.id, "no duplicate Projects row");
  const hubWork = hub.cloud.folders().find((f) => f.name === "Work" && !f.deleted_at);
  assert.ok(hubWork, "the fresh folder is created on the hub");
  assert.equal(folders.get("Work").cloud_id, hubWork.id);
  assert.equal(hubNoteFor(hub, projects.note.client_note_id)?.folder_id, seeded.projects.id);
  assert.equal(hubNoteFor(hub, work.note.client_note_id)?.folder_id, hubWork.id);
  assert.equal(
    hub.requests.filter((r) => r.status === 409).length,
    0,
    "no folder_name_taken on the way"
  );
});

test("a name clash mid-batch still creates the rest, and holds the clashing folder's notes", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  // Another device creates "Race" between this Mac's folder list and its
  // batch create, so the batch answers 409 folder_name_taken.
  let raced = null;
  const hub = createHub({
    beforeBatchCreate: (cloud) => {
      raced ??= cloud.seedFolder({ client_folder_id: "hub-race", name: "Race", sort_order: 9 });
    },
  });
  await seedHub(hub.cloud);
  const work = localFolderWithNote(db, "Work");
  const race = localFolderWithNote(db, "Race");
  t.mock.method(console, "error", () => {});

  const storage = await syncPass(db, hub, {});

  assert.ok(
    hub.requests.some((r) => r.pathname === "/api/folders/batch-create" && r.status === 409),
    "the batch must have hit the clash"
  );
  const hubWork = hub.cloud.folders().find((f) => f.name === "Work");
  assert.ok(hubWork, "the non-clashing folder is created one by one after the batch 409");
  assert.equal(hubNoteFor(hub, work.note.client_note_id)?.folder_id, hubWork.id);
  // The clashing folder's note either waits or, once the same pass's pull
  // links the hub's "Race", files there; it never lands with folder_id null.
  assertHeldOrFiledIn(hub, race.note.client_note_id, raced.id);

  // Next pass: the hub's "Race" is linked and the note is filed there.
  await syncPass(db, hub, storage);
  const localRace = localFolders(db).find((f) => f.name === "Race");
  assert.equal(localRace.cloud_id, raced.id);
  assert.equal(hubNoteFor(hub, race.note.client_note_id)?.folder_id, raced.id);
});

test("a failed folder list holds fresh folders and their notes back for a pass", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub({ failFolderListOnce: true });
  const seeded = await seedHub(hub.cloud);
  const projects = localFolderWithNote(db, "Projects");
  t.mock.method(console, "error", () => {});

  const storage = await syncPass(db, hub, {});
  assert.equal(
    hub.requests.filter((r) => r.pathname.startsWith("/api/folders/") && r.method === "POST")
      .length,
    0,
    "no blind folder creates while the hub's names are unknown"
  );
  assertHeldOrFiledIn(hub, projects.note.client_note_id, seeded.projects.id);

  await syncPass(db, hub, storage);
  assert.equal(localFolders(db).find((f) => f.name === "Projects").cloud_id, seeded.projects.id);
  assert.equal(hubNoteFor(hub, projects.note.client_note_id)?.folder_id, seeded.projects.id);
});

// The hub has no /api/conversations routes, so hub mode
// uploads no agent conversation, not even one with messages waiting.
test("hub mode never uploads agent conversations", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub();
  await seedHub(hub.cloud);
  const conversation = db.createAgentConversation("Private chat");
  db.addAgentMessage(conversation.id, "user", "hello");
  t.mock.method(console, "error", () => {});

  const storage = await syncPass(db, hub, {});
  await syncPass(db, hub, storage);

  assert.deepEqual(
    hub.requests.filter((r) => r.pathname.startsWith("/api/conversations/")).map((r) => r.path),
    []
  );
});

// The live purge path. syncSpaces purges every local team
// space the spaces probe does not list. The hub contract has no spaces, so a
// hub answering 200 with an empty list must not purge local team content.
test("a hub answering the spaces probe with an empty list purges no team space", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub({ spacesReply: { data: [] } });
  await seedHub(hub.cloud);
  db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, cloud_space_id, kind, name, sync_status) VALUES (?, ?, 'team', ?, 'synced')"
    )
    .run("local-team", "cloud-team-space", "Acme");
  const teamSpaceId = db.db.prepare("SELECT id FROM spaces WHERE name = 'Acme'").get().id;
  const teamNote = db.saveNote("Team note", "body", "personal").note;
  db.db.prepare("UPDATE notes SET space_id = ? WHERE id = ?").run(teamSpaceId, teamNote.id);
  t.mock.method(console, "error", () => {});

  await syncPass(db, hub, {});

  const team = db.db.prepare("SELECT * FROM spaces WHERE kind = 'team'").all();
  assert.equal(team.length, 1, "the local team space must survive a hub pass");
  assert.equal(team[0].deleted_at, null);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE space_id = ?").get(teamSpaceId).n,
    1,
    "the team note must survive a hub pass"
  );
  assert.equal(
    hub.requests.some((r) => r.pathname === "/api/me/spaces"),
    false,
    "hub mode must not probe spaces the contract does not have"
  );
});

// The live delete paths in hub mode. A hub tombstone
// hard-deletes the local copy on the next delta pull.
test("a hub tombstone deletes the local note on the next pass", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub();
  const seeded = await seedHub(hub.cloud);
  t.mock.method(console, "error", () => {});
  const storage = await syncPass(db, hub, {});
  const target = seeded.live[0];
  assert.ok(localNotes(db).some((n) => n.cloud_id === target.id));

  // The phone deletes it after this Mac's pass.
  hub.cloud.setClock(() => new Date(Date.now() + 1000).toISOString());
  await hub.cloud.request({ method: "DELETE", path: "/api/notes/delete", body: { id: target.id } });
  await syncPass(db, hub, storage);

  assert.equal(
    localNotes(db).some((n) => n.cloud_id === target.id),
    false,
    "the tombstoned note must be gone locally"
  );
  assert.equal(localNotes(db).length, seeded.live.length - 1, "no other note is touched");
});

// An edited note whose hub row is gone 404s on update. It is kept and retried,
// then forked and re-created on the hub, never deleted.
test("an edited note the hub no longer has is kept, then forked back to the hub", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const hub = createHub();
  const seeded = await seedHub(hub.cloud);
  t.mock.method(console, "error", () => {});
  let storage = await syncPass(db, hub, {});
  const local = localNotes(db).find((n) => n.cloud_id === seeded.live[0].id);
  db.db.prepare("UPDATE notes SET cloud_id = ? WHERE id = ?").run("hub-row-gone", local.id);
  db.updateNote(local.id, { content: "edited on this Mac" });

  const created = () =>
    hub.cloud.notes().filter((n) => n.content === "edited on this Mac" && !n.deleted_at);
  for (let pass = 1; pass < 3; pass += 1) {
    storage = await syncPass(db, hub, storage);
    assert.ok(db.getNote(local.id), `pass ${pass}: the edited note must survive the 404`);
    assert.equal(created().length, 0, `pass ${pass}: no fork before the threshold`);
  }
  // The fork lands once the 404 streak reaches the threshold; its create goes
  // up on a following pass.
  for (let pass = 3; pass <= 6; pass += 1) storage = await syncPass(db, hub, storage);

  assert.ok(db.getNote(local.id), "the edited note is never deleted");
  assert.equal(created().length, 1, "the fork is re-created on the hub exactly once");
  assert.ok(
    hub.requests.some((r) => r.status === 404 && r.pathname === "/api/notes/update"),
    "the update must have 404'd"
  );
});
