const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MAX_BACKUPS,
  MAX_BACKUP_SOURCE_BYTES,
  sanitizeVersion,
  backupPathFor,
  listBackups,
  backupBeforeMigrate,
  backupPathForFailure,
} = require("../../src/helpers/databaseBackup");

function withTempDir(t, name = "db-backup-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Stands in for better-sqlite3 (built for Electron's ABI): parses the
// VACUUM INTO target, un-doubles quotes, and writes a file there.
function makeFakeDb({ onExec } = {}) {
  const calls = [];
  return {
    calls,
    exec(sql) {
      calls.push(sql);
      const match = /^VACUUM INTO '((?:[^']|'')*)'$/.exec(sql);
      assert.ok(match, `unexpected SQL: ${sql}`);
      const target = match[1].replace(/''/g, "'");
      if (onExec) onExec(target);
      fs.writeFileSync(target, "snapshot");
    },
  };
}

function seedDb(dir, name = "transcriptions.db") {
  const dbPath = path.join(dir, name);
  fs.writeFileSync(dbPath, "sqlite-bytes");
  return dbPath;
}

function partsIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".part"));
}

test("constants", () => {
  assert.equal(MAX_BACKUPS, 3);
  assert.equal(MAX_BACKUP_SOURCE_BYTES, 500 * 1024 * 1024);
});

test("sanitizeVersion keeps safe versions and neutralizes the rest", () => {
  assert.equal(sanitizeVersion("1.10.1-rtech.5"), "1.10.1-rtech.5");
  const hostile = sanitizeVersion("1.0/../x");
  assert.equal(hostile.includes("/"), false);
  assert.equal(hostile, "1.0_.._x");
  assert.equal(sanitizeVersion(""), "unknown");
  assert.equal(sanitizeVersion(undefined), "unknown");
  assert.equal(sanitizeVersion(42), "unknown");
});

test("backupPathFor appends the sanitized version", () => {
  assert.equal(backupPathFor("/a/b/x.db", "1.0/2"), "/a/b/x.db.backup-1.0_2");
});

test("no database file is skipped and writes nothing", (t) => {
  const dir = withTempDir(t);
  const dbPath = path.join(dir, "transcriptions.db");
  const db = makeFakeDb();

  const result = backupBeforeMigrate({ db, dbPath, version: "1.0.0" });

  assert.deepEqual(result, { status: "skipped", reason: "no-database" });
  assert.equal(db.calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an empty database file is skipped", (t) => {
  const dir = withTempDir(t);
  const dbPath = path.join(dir, "transcriptions.db");
  fs.writeFileSync(dbPath, "");
  const db = makeFakeDb();

  const result = backupBeforeMigrate({ db, dbPath, version: "1.0.0" });

  assert.deepEqual(result, { status: "skipped", reason: "no-database" });
  assert.equal(db.calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), ["transcriptions.db"]);
});

test("first run creates the backup and leaves no part file", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  const db = makeFakeDb();

  const result = backupBeforeMigrate({ db, dbPath, version: "1.10.1-rtech.5" });

  const expected = path.join(dir, "transcriptions.db.backup-1.10.1-rtech.5");
  assert.deepEqual(result, { status: "created", path: expected });
  assert.equal(fs.readFileSync(expected, "utf8"), "snapshot");
  assert.deepEqual(partsIn(dir), []);
  assert.deepEqual(listBackups(dbPath), [expected]);
});

test("second run on the same version is skipped without touching the db", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  const first = backupBeforeMigrate({ db: makeFakeDb(), dbPath, version: "1.0.0" });
  const db = makeFakeDb();

  const result = backupBeforeMigrate({ db, dbPath, version: "1.0.0" });

  assert.deepEqual(result, {
    status: "skipped",
    reason: "already-backed-up",
    path: first.path,
  });
  assert.equal(db.calls.length, 0);
});

test("a new version adds a backup and only the 3 newest are kept", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  const versions = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"];
  const paths = [];

  versions.forEach((version, index) => {
    const result = backupBeforeMigrate({ db: makeFakeDb(), dbPath, version });
    assert.equal(result.status, "created");
    paths.push(result.path);
    // Distinct, increasing mtimes: older versions are older files.
    const when = new Date(Date.UTC(2026, 0, 1 + index));
    fs.utimesSync(result.path, when, when);
    if (index === 1) assert.equal(listBackups(dbPath).length, 2);
  });

  // Creating the 4th snapshot pruned the oldest; the rest list newest first.
  assert.equal(fs.existsSync(paths[0]), false);
  assert.deepEqual(listBackups(dbPath), [paths[3], paths[2], paths[1]]);
  assert.equal(listBackups(dbPath).length, MAX_BACKUPS);
});

test("a leftover part file is removed and never counted as a backup", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  const leftover = path.join(dir, "transcriptions.db.backup-0.9.0.part");
  fs.writeFileSync(leftover, "half a snapshot");

  assert.deepEqual(listBackups(dbPath), []);

  const result = backupBeforeMigrate({ db: makeFakeDb(), dbPath, version: "1.0.0" });

  assert.equal(result.status, "created");
  assert.equal(fs.existsSync(leftover), false);
  assert.deepEqual(partsIn(dir), []);
  assert.deepEqual(listBackups(dbPath), [result.path]);
});

test("a leftover part file is removed even when there is nothing to back up", (t) => {
  const dir = withTempDir(t);
  const dbPath = path.join(dir, "transcriptions.db");
  const leftover = `${dbPath}.backup-0.9.0.part`;
  fs.writeFileSync(leftover, "half a snapshot");

  const result = backupBeforeMigrate({ db: makeFakeDb(), dbPath, version: "1.0.0" });

  assert.deepEqual(result, { status: "skipped", reason: "no-database" });
  assert.equal(fs.existsSync(leftover), false);
});

test("a source over the cap is skipped and logged", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  const db = makeFakeDb();
  const logs = [];

  const result = backupBeforeMigrate({
    db,
    dbPath,
    version: "1.0.0",
    maxSourceBytes: 4,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { status: "skipped", reason: "too-large" });
  assert.equal(db.calls.length, 0);
  assert.equal(logs.length, 1);
  assert.deepEqual(listBackups(dbPath), []);
});

test("exec throwing reports failed, removes the part, and does not throw", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  const logs = [];
  const db = {
    exec(sql) {
      const target = /^VACUUM INTO '(.*)'$/.exec(sql)[1];
      fs.writeFileSync(target, "partial");
      throw new Error("disk I/O error");
    },
  };

  let result;
  assert.doesNotThrow(() => {
    result = backupBeforeMigrate({
      db,
      dbPath,
      version: "1.0.0",
      log: (message) => logs.push(message),
    });
  });

  assert.deepEqual(result, { status: "failed", reason: "disk I/O error" });
  assert.deepEqual(partsIn(dir), []);
  assert.deepEqual(listBackups(dbPath), []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /disk I\/O error/);
});

test("a single quote in the db path is doubled in the SQL and round-trips", (t) => {
  const dir = withTempDir(t, "db-back'up-");
  const dbPath = seedDb(dir);
  const db = makeFakeDb();

  const result = backupBeforeMigrate({ db, dbPath, version: "1.0.0" });

  assert.equal(result.status, "created");
  assert.equal(db.calls.length, 1);
  assert.ok(db.calls[0].includes("db-back''up-"));
  assert.equal(db.calls[0].includes("db-back'up-"), false);
  assert.equal(result.path, `${dbPath}.backup-1.0.0`);
  assert.equal(fs.readFileSync(result.path, "utf8"), "snapshot");
  assert.deepEqual(partsIn(dir), []);
});

test("the WAL counts toward the size cap", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  fs.writeFileSync(`${dbPath}-wal`, "x".repeat(64));
  const db = makeFakeDb();
  const logs = [];

  // The main file alone (12 bytes) is under the cap; main + WAL is over it.
  const result = backupBeforeMigrate({
    db,
    dbPath,
    version: "1.0.0",
    maxSourceBytes: 32,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { status: "skipped", reason: "too-large" });
  assert.equal(db.calls.length, 0);
  assert.match(logs[0], /76 bytes/);
});

test("an empty main file with rows still in the WAL is backed up", (t) => {
  const dir = withTempDir(t);
  const dbPath = path.join(dir, "transcriptions.db");
  fs.writeFileSync(dbPath, "");
  fs.writeFileSync(`${dbPath}-wal`, "wal-frames");

  const result = backupBeforeMigrate({ db: makeFakeDb(), dbPath, version: "1.0.0" });

  assert.equal(result.status, "created");
});

test("the snapshot just written survives the prune even when older ones look newer", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  // Three snapshots stamped in the future, as after a clock correction.
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const older = ["0.7.0", "0.8.0", "0.9.0"].map((version, index) => {
    const filePath = backupPathFor(dbPath, version);
    fs.writeFileSync(filePath, "snapshot");
    const when = new Date(future.getTime() + index * 1000);
    fs.utimesSync(filePath, when, when);
    return filePath;
  });

  const result = backupBeforeMigrate({ db: makeFakeDb(), dbPath, version: "1.0.0" });

  assert.equal(result.status, "created");
  assert.equal(fs.existsSync(result.path), true, "the new snapshot is kept");
  assert.equal(listBackups(dbPath).length, MAX_BACKUPS);
  assert.equal(fs.existsSync(older[0]), false, "the oldest of the others is pruned");
});

test("a prune failure is logged and the snapshot still counts as created", (t) => {
  const dir = withTempDir(t);
  const dbPath = seedDb(dir);
  for (const version of ["0.7.0", "0.8.0", "0.9.0"]) {
    fs.writeFileSync(backupPathFor(dbPath, version), "snapshot");
  }
  const logs = [];
  const failingFs = {
    ...fs,
    unlinkSync() {
      throw new Error("EPERM: operation not permitted");
    },
  };

  const result = backupBeforeMigrate({
    db: makeFakeDb(),
    dbPath,
    version: "1.0.0",
    fs: failingFs,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { status: "created", path: backupPathFor(dbPath, "1.0.0") });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /prune failed: EPERM/);
});

test("backupPathForFailure names only a snapshot whose file is still there", () => {
  const dbPath = "/data/transcriptions.db";
  const snapshot = backupPathFor(dbPath, "1.0.0");
  const fakeFs = (...present) => {
    const set = new Set(present);
    return { existsSync: (p) => set.has(p) };
  };
  const created = { status: "created", path: snapshot };

  assert.equal(backupPathForFailure({ lastBackup: created, fs: fakeFs(snapshot) }), snapshot);
  assert.equal(backupPathForFailure({ lastBackup: created, fs: fakeFs() }), null);
  // The start failed before the snapshot call: an earlier launch's snapshot counts.
  assert.equal(
    backupPathForFailure({ lastBackup: null, dbPath, version: "1.0.0", fs: fakeFs(snapshot) }),
    snapshot
  );
  const throwingFs = {
    existsSync() {
      throw new Error("EACCES");
    },
  };
  assert.equal(backupPathForFailure({ lastBackup: created, fs: throwingFs }), null);
});
