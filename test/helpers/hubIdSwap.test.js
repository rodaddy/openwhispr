// Per-hub cloud ids (rtech-whisper#126, decision D14): A -> B -> A resumes A
// from A's own ids, and A never gets its own rows pushed back as new.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtw-hub-ids-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const { skipOrFail } = require("./harness/db.js");

const A = "https://a.example.com";
const B = "https://b.example.com";

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtw-hub-ids-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  try {
    return new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);
    return null;
  }
}

function addNote(db, title, cloudId) {
  return db.db
    .prepare(
      "INSERT INTO notes (title, cloud_id, sync_status, cloud_updated_at) VALUES (?, ?, 'synced', 'hub-clock')"
    )
    .run(title, cloudId).lastInsertRowid;
}

function note(db, id) {
  return db.db
    .prepare("SELECT cloud_id, sync_status, cloud_updated_at FROM notes WHERE id = ?")
    .get(id);
}

// What a push pass to the current hub would do for a note it has no id for.
function pushAsNew(db, id, cloudId) {
  db.db
    .prepare("UPDATE notes SET cloud_id = ?, sync_status = 'synced' WHERE id = ?")
    .run(cloudId, id);
}

test("A -> B -> A restores A's ids; rows made on B push to A as new", (t) => {
  const db = createDb(t);
  if (!db) return;
  assert.equal(db.swapHubIds(A), "first-run");
  const onA = addNote(db, "made on A", "a-1");
  const transcription = db.db
    .prepare(
      "INSERT INTO transcriptions (text, cloud_id, sync_status) VALUES ('hi', 'a-t1', 'synced')"
    )
    .run().lastInsertRowid;

  assert.equal(db.swapHubIds(B), "swapped");
  assert.deepEqual(note(db, onA), {
    cloud_id: null,
    sync_status: "pending",
    cloud_updated_at: null,
  });
  pushAsNew(db, onA, "b-1");
  const onB = addNote(db, "made on B", "b-2");

  assert.equal(db.swapHubIds(A), "swapped");
  // A's own row gets its A id back: it updates on A, never creates a duplicate.
  assert.equal(note(db, onA).cloud_id, "a-1");
  assert.equal(
    db.db.prepare("SELECT cloud_id FROM transcriptions WHERE id = ?").get(transcription).cloud_id,
    "a-t1"
  );
  // The B row has no A id, so it pushes to A as new.
  assert.deepEqual(note(db, onB), {
    cloud_id: null,
    sync_status: "pending",
    cloud_updated_at: null,
  });
  const aLeft = db.db.prepare("SELECT COUNT(*) AS n FROM hub_ids WHERE hub_url = ?").get(A).n;
  assert.equal(aLeft, 0);

  assert.equal(db.swapHubIds(B), "swapped");
  assert.equal(note(db, onA).cloud_id, "b-1");
  assert.equal(note(db, onB).cloud_id, "b-2");
});

test("upgrade: the first run keeps every id and only records the hub", (t) => {
  const db = createDb(t);
  if (!db) return;
  const id = addNote(db, "pre-upgrade", "a-1");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM sync_state").get().n, 0);
  assert.equal(db.swapHubIds(A), "first-run");
  assert.deepEqual(note(db, id), {
    cloud_id: "a-1",
    sync_status: "synced",
    cloud_updated_at: "hub-clock",
  });
  assert.equal(db.db.prepare("SELECT hub_url FROM sync_state").get().hub_url, A);
});

test("hub off and back on to the same URL changes nothing", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.swapHubIds(A);
  const id = addNote(db, "kept", "a-1");
  assert.equal(db.swapHubIds(""), "off");
  assert.equal(db.swapHubIds(A), "same");
  assert.deepEqual(note(db, id), {
    cloud_id: "a-1",
    sync_status: "synced",
    cloud_updated_at: "hub-clock",
  });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM hub_ids").get().n, 0);
});

// rtech-whisper#293: a row deleted on B (tombstone pushed to B, local row
// hard-deleted) still has its stashed A id. Back on A, that id comes back as a
// pending tombstone, so the next push deletes the row on A too.
test("A -> B -> A: a row deleted on B is queued as a delete for A", (t) => {
  const db = createDb(t);
  if (!db) return;
  assert.equal(db.swapHubIds(A), "first-run");
  const kept = addNote(db, "kept", "a-1");
  const gone = addNote(db, "deleted on B", "a-2");
  const word = db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, cloud_id, sync_status) VALUES ('w', 'a-d1', 'synced')"
    )
    .run().lastInsertRowid;
  const folder = db.db
    .prepare("INSERT INTO folders (name, cloud_id, sync_status) VALUES ('F', 'a-f1', 'synced')")
    .run().lastInsertRowid;

  assert.equal(db.swapHubIds(B), "swapped");
  // Deleted on B and its tombstone pushed to B: the local rows are gone.
  db.db.prepare("DELETE FROM notes WHERE id = ?").run(gone);
  db.db.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(word);
  db.db.prepare("DELETE FROM folders WHERE id = ?").run(folder);

  assert.equal(db.swapHubIds(A), "swapped");
  assert.equal(note(db, kept).cloud_id, "a-1");
  assert.deepEqual(
    db.getPendingNoteDeletes().map((n) => n.cloud_id),
    ["a-2"]
  );
  assert.deepEqual(
    db.getPendingDictionaryDeletes().map((d) => d.cloud_id),
    ["a-d1"]
  );
  assert.deepEqual(
    db.getPendingFolderDeletes().map((f) => f.cloud_id),
    ["a-f1"]
  );
  // A deleted row never shows as a live row.
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL").get().n,
    1
  );
});
