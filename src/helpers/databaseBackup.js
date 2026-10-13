// One snapshot of the SQLite database per app version, taken before the
// in-place migrations in DatabaseManager.initDatabase() run. Electron-free so
// it can be unit-tested with a fake `db`.
const path = require("path");

const MAX_BACKUPS = 3;
const MAX_BACKUP_SOURCE_BYTES = 500 * 1024 * 1024;
const PART_SUFFIX = ".part";

function sanitizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) return "unknown";
  return version.replace(/[^A-Za-z0-9._-]/g, "_");
}

function backupPathFor(dbPath, version) {
  return `${dbPath}.backup-${sanitizeVersion(version)}`;
}

function backupPrefixFor(dbPath) {
  return `${path.basename(dbPath)}.backup-`;
}

// Absolute paths of the finished snapshots next to the database, newest first.
function listBackups(dbPath, { fs = require("fs") } = {}) {
  const dir = path.dirname(dbPath);
  const prefix = backupPrefixFor(dbPath);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && !name.endsWith(PART_SUFFIX))
    .map((name) => {
      const filePath = path.join(dir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.filePath);
}

// A snapshot that was cut short is never a backup.
function removeLeftoverParts(dbPath, fs) {
  const dir = path.dirname(dbPath);
  const prefix = backupPrefixFor(dbPath);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix) && name.endsWith(PART_SUFFIX)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

// Keeps the snapshot just written plus the newest of the others. The new one
// is never a candidate: with a skewed clock it can sort as the oldest. A
// prune failure is logged and does not undo a snapshot that exists.
function pruneOldBackups(dbPath, keepPath, fs, log) {
  try {
    const others = listBackups(dbPath, { fs }).filter((filePath) => filePath !== keepPath);
    for (const stale of others.slice(MAX_BACKUPS - 1)) fs.unlinkSync(stale);
  } catch (error) {
    try {
      log(`Database backup prune failed: ${error?.message || String(error)}`);
    } catch {
      // A logger that throws must not break startup.
    }
  }
}

// Never throws: a failed backup must not block startup.
function backupBeforeMigrate({
  db,
  dbPath,
  version,
  fs = require("fs"),
  log = () => {},
  maxSourceBytes = MAX_BACKUP_SOURCE_BYTES,
}) {
  const backupPath = backupPathFor(dbPath, version);
  const partPath = `${backupPath}${PART_SUFFIX}`;
  try {
    removeLeftoverParts(dbPath, fs);

    if (!fs.existsSync(dbPath)) return { status: "skipped", reason: "no-database" };
    // The WAL counts: after a crash most of the data can still be in it, and
    // the snapshot (written synchronously, during startup) copies all of it.
    const walPath = `${dbPath}-wal`;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const sourceBytes = fs.statSync(dbPath).size + walBytes;
    if (sourceBytes === 0) return { status: "skipped", reason: "no-database" };

    if (fs.existsSync(backupPath)) {
      return { status: "skipped", reason: "already-backed-up", path: backupPath };
    }

    if (sourceBytes > maxSourceBytes) {
      log(`Database backup skipped: ${sourceBytes} bytes exceeds the ${maxSourceBytes} byte limit`);
      return { status: "skipped", reason: "too-large" };
    }

    // VACUUM INTO has SQLite write the snapshot, so WAL contents are included.
    db.exec(`VACUUM INTO '${partPath.replace(/'/g, "''")}'`);
    fs.renameSync(partPath, backupPath);

    pruneOldBackups(dbPath, backupPath, fs, log);

    return { status: "created", path: backupPath };
  } catch (error) {
    const reason = error?.message || String(error);
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // Best effort: the next run clears leftover parts before it starts.
    }
    try {
      log(`Database backup failed: ${reason}`);
    } catch {
      // A logger that throws must not break startup either.
    }
    return { status: "failed", reason };
  }
}

// The snapshot a failed start can point the user to: the one this launch
// made or found, else the one an earlier launch of this version left.
// Only a file that is still there counts. Never throws: it runs inside the
// catch of a failing start and must not hide the original error.
function backupPathForFailure({ lastBackup, dbPath, version, fs = require("fs") } = {}) {
  try {
    const isPath = (value) => typeof value === "string" && value.length > 0;
    const candidates = [];
    const named =
      lastBackup?.status === "created" ||
      (lastBackup?.status === "skipped" && lastBackup?.reason === "already-backed-up");
    if (named && isPath(lastBackup.path)) candidates.push(lastBackup.path);
    if (isPath(dbPath) && isPath(version)) candidates.push(backupPathFor(dbPath, version));
    return candidates.find((candidate) => isPath(candidate) && fs.existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
}

module.exports = {
  MAX_BACKUPS,
  MAX_BACKUP_SOURCE_BYTES,
  sanitizeVersion,
  backupPathFor,
  listBackups,
  backupBeforeMigrate,
  backupPathForFailure,
};
