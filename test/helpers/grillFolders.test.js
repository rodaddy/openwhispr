const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  GRILL_FOLDER_NAME,
  LIFE_STORY_FOLDER_NAME,
  GRILL_FOLDERS_USER_VERSION,
  seedGrillFoldersOnce,
} = require("../../src/helpers/grillFolders.js");

const PERSONAL = 1;
const TEAM = 2;

// An existing database as database.js leaves it just before the grill seed:
// spaces migrated (a personal and a team space), the default folders in the
// personal space, and the earlier one-time migrations at user_version 2.
function existingDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE spaces (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      client_folder_id TEXT,
      deleted_at TEXT,
      space_id INTEGER,
      account_id TEXT
    );
  `);
  db.prepare("INSERT INTO spaces (id, kind, name) VALUES (?, 'private', 'Personal')").run(PERSONAL);
  db.prepare("INSERT INTO spaces (id, kind, name) VALUES (?, 'team', 'Acme')").run(TEAM);
  const seed = db.prepare(
    "INSERT INTO folders (name, is_default, sort_order, space_id) VALUES (?, 1, ?, ?)"
  );
  seed.run("Personal", 0, PERSONAL);
  seed.run("Meetings", 1, PERSONAL);
  seed.run("Videos", 2, PERSONAL);
  db.exec("PRAGMA user_version = 2");
  return db;
}

const personalRows = (db) =>
  db
    .prepare(
      "SELECT name, is_default, sort_order FROM folders WHERE space_id = ? AND deleted_at IS NULL ORDER BY sort_order, id"
    )
    .all(PERSONAL)
    .map((r) => ({ ...r }));
const userVersion = (db) => db.prepare("PRAGMA user_version").get().user_version;
const count = (db, name, spaceId) =>
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL"
    )
    .get(name, spaceId).n;

test("seeds Grill and Life Story once, as ordinary personal-space folders after the defaults", () => {
  const db = existingDb();
  seedGrillFoldersOnce(db);
  assert.deepEqual(personalRows(db).slice(3), [
    { name: GRILL_FOLDER_NAME, is_default: 0, sort_order: 3 },
    { name: LIFE_STORY_FOLDER_NAME, is_default: 0, sort_order: 4 },
  ]);
  const ids = db
    .prepare("SELECT client_folder_id FROM folders WHERE name IN ('Grill', 'Life Story')")
    .all()
    .map((r) => r.client_folder_id);
  assert.ok(ids.every(Boolean), "seeded folders carry a client_folder_id for sync");
  assert.equal(userVersion(db), GRILL_FOLDERS_USER_VERSION);
  assert.ok(GRILL_FOLDERS_USER_VERSION > 2, "must follow the existing user_version 2 migration");
});

test("a later launch is a no-op", () => {
  const db = existingDb();
  seedGrillFoldersOnce(db);
  const first = personalRows(db);
  seedGrillFoldersOnce(db);
  seedGrillFoldersOnce(db);
  assert.deepEqual(personalRows(db), first);
});

test("a deleted or renamed grill folder does not come back on the next launch", () => {
  const db = existingDb();
  seedGrillFoldersOnce(db);
  db.prepare("DELETE FROM folders WHERE name = ?").run(GRILL_FOLDER_NAME);
  db.prepare("UPDATE folders SET name = 'My Story' WHERE name = ?").run(LIFE_STORY_FOLDER_NAME);
  seedGrillFoldersOnce(db);
  const names = personalRows(db).map((r) => r.name);
  assert.ok(!names.includes(GRILL_FOLDER_NAME));
  assert.ok(!names.includes(LIFE_STORY_FOLDER_NAME));
  assert.ok(names.includes("My Story"));
});

test("an existing personal folder with the same name is left untouched", () => {
  const db = existingDb();
  db.prepare(
    "INSERT INTO folders (name, is_default, sort_order, space_id) VALUES ('Grill', 0, 9, ?)"
  ).run(PERSONAL);
  seedGrillFoldersOnce(db);
  const grill = db
    .prepare("SELECT is_default, sort_order FROM folders WHERE name = 'Grill' AND space_id = ?")
    .all(PERSONAL);
  assert.deepEqual(
    grill.map((r) => ({ ...r })),
    [{ is_default: 0, sort_order: 9 }]
  );
  assert.equal(count(db, "Life Story", PERSONAL), 1);
});

test("a team-space Grill or a soft-deleted personal Grill does not stop the personal seed", () => {
  const db = existingDb();
  const insert = db.prepare(
    "INSERT INTO folders (name, is_default, sort_order, space_id, deleted_at) VALUES (?, 0, 0, ?, ?)"
  );
  insert.run("Grill", TEAM, null);
  insert.run("Life Story", TEAM, null);
  insert.run("Grill", PERSONAL, "2026-09-01T00:00:00Z");
  seedGrillFoldersOnce(db);
  assert.equal(count(db, "Grill", PERSONAL), 1);
  assert.equal(count(db, "Life Story", PERSONAL), 1);
  assert.equal(count(db, "Grill", TEAM), 1, "the team folder is untouched");
  assert.equal(count(db, "Life Story", TEAM), 1);
});

test("database.js runs the guarded grill seed after spaces are migrated", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/database.js"), "utf8");
  const v2At = source.indexOf('this.db.pragma("user_version = 2");');
  const spacesAt = source.indexOf("UPDATE folders SET space_id = ? WHERE space_id IS NULL");
  const accountAt = source.indexOf("ALTER TABLE folders ADD COLUMN account_id TEXT");
  const seedAt = source.indexOf("seedGrillFoldersOnce(this.db);");
  assert.ok(v2At > 0, "user_version 2 migration not found");
  assert.ok(spacesAt > 0 && accountAt > 0, "spaces migration not found");
  assert.ok(seedAt > v2At, "seedGrillFoldersOnce must run after user_version 2 is set");
  assert.ok(seedAt > spacesAt, "seedGrillFoldersOnce must run after folders get a space");
  assert.ok(seedAt > accountAt, "seedGrillFoldersOnce must run after folders get account_id");
  assert.equal(source.indexOf("seedGrillFolders(this.db);"), -1, "unguarded seed must be gone");
});
