// Move the data folder (PR B). Settings validates the target, writes
// pending-move.json into the default userData and relaunches. The next boot
// resolves to kind "move" and runs runPendingMove before any store opens:
// copy, verify, then switch the pointer. The old folder is never deleted.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  POINTER_FILE,
  MARKER_FILE,
  BOOT_LIMBO_DIR,
  PENDING_MOVE_FILE,
  POINTER_VERSION,
  CACHE_ROOT_FILE,
  PREVIOUS_ROOT_FILE,
  writePointer,
} = require("./dataRootBootstrap");
const { planOldCopyRemoval } = require("./oldCopyPlanner");

const fsp = fs.promises;
const DB_FILES = ["transcriptions.db", "transcriptions-dev.db"];
// Rebuildable Chromium caches, locks, and this app's own bookkeeping files.
const SKIP = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  BOOT_LIMBO_DIR,
  ".DS_Store",
  PENDING_MOVE_FILE,
  POINTER_FILE,
  MARKER_FILE,
  CACHE_ROOT_FILE,
  PREVIOUS_ROOT_FILE,
]);
const isSkipped = (name) => SKIP.has(name) || name.startsWith("Singleton");

// A move home (to the channel default folder) finds boot's bookkeeping there
// and still counts the folder as empty. The cache stays on the drive, so the
// top-level `cache` of the data root is neither copied nor counted.
const HOME_BOOKKEEPING = new Set([
  POINTER_FILE,
  PENDING_MOVE_FILE,
  BOOT_LIMBO_DIR,
  CACHE_ROOT_FILE,
  ".DS_Store",
]);
const HOME_EXCLUDE = new Set(["cache"]);

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Native realpath also canonicalizes case on a case-insensitive disk.
function isHome(to, defaultUserData) {
  if (typeof to !== "string" || !defaultUserData) return false;
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(to) === real(defaultUserData);
}

// Returns a refusal reason, or null when `to` can receive the move.
function checkDestination({ from, to, cacheRoot, defaultUserData }) {
  if (typeof to !== "string" || !path.isAbsolute(to)) return "missing";
  if (isInside(from, to) || isInside(to, from)) return "insideCurrent";
  if (cacheRoot && (isInside(cacheRoot, to) || isInside(to, cacheRoot))) return "insideCurrent";
  let entries;
  try {
    entries = fs.readdirSync(to);
  } catch {
    return "missing";
  }
  const ignored = isHome(to, defaultUserData) ? HOME_BOOKKEEPING : new Set([".DS_Store"]);
  if (entries.some((name) => !ignored.has(name))) return "notEmpty";
  const probe = path.join(to, `.openwhispr-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch {
    return "notWritable";
  }
  return null;
}

// `exclude` names top-level entries only.
async function tally(dir, into = { files: 0, bytes: 0 }, exclude = null) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (isSkipped(entry.name) || exclude?.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await tally(full, into);
    else if (entry.isFile()) {
      into.files += 1;
      into.bytes += (await fsp.stat(full)).size;
    } else if (entry.isSymbolicLink()) into.files += 1;
  }
  return into;
}

// COPYFILE_EXCL: a name collision (a stray "cache" in the source) fails the
// move instead of silently overwriting.
async function copyTree(from, to, { exclude = null } = {}) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (isSkipped(entry.name) || exclude?.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else if (entry.isFile()) await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
    else if (entry.isSymbolicLink()) await fsp.symlink(await fsp.readlink(src), dst);
  }
}

function integrityCheck(file) {
  const Database = require("better-sqlite3");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.pragma("integrity_check", { simple: true });
  } finally {
    db.close();
  }
}

// The cache is copied separately only when it lives outside the store; a
// store that already holds its cache (pointer mode) carries it along.
function separateCache(from, cacheRoot) {
  return cacheRoot && !isInside(from, cacheRoot) && fs.existsSync(cacheRoot) ? cacheRoot : null;
}

async function measure(from, cacheRoot) {
  const total = await tally(from);
  const cache = separateCache(from, cacheRoot);
  return cache ? tally(cache, total) : total;
}

// Settings side: validate, then record the request. The copy happens at boot.
function requestMove({ defaultUserData, from, to, cacheRoot }) {
  const refusal = checkDestination({ from, to, cacheRoot, defaultUserData });
  if (refusal) return { ok: false, reason: refusal };
  fs.writeFileSync(
    path.join(defaultUserData, PENDING_MOVE_FILE),
    JSON.stringify({ from, to, cacheRoot }, null, 2)
  );
  return { ok: true };
}

class MoveError extends Error {}

// Boot side. Always deletes pending-move.json; on failure the pointer is left
// alone and whatever this run wrote into `to` is removed again.
async function runPendingMove({
  defaultUserData,
  from,
  channel,
  checkDb = integrityCheck,
  copy = copyTree,
  now = new Date(),
}) {
  const pendingPath = path.join(defaultUserData, PENDING_MOVE_FILE);
  let wroteInto = null;
  let home = false;
  try {
    const request = JSON.parse(await fsp.readFile(pendingPath, "utf8"));
    if (request.from !== from) throw new MoveError(`the data folder changed since the request`);
    const { to, cacheRoot } = request;
    const refusal = checkDestination({ from, to, cacheRoot, defaultUserData });
    if (refusal) throw new MoveError(`destination ${refusal}: ${to}`);
    home = isHome(to, defaultUserData);
    wroteInto = to;

    // A move home leaves the cache on the drive: only the data is copied
    // and counted.
    const exclude = home ? HOME_EXCLUDE : null;
    const expected = home ? await tally(from, undefined, exclude) : await measure(from, cacheRoot);
    await copy(from, to, { exclude });
    const cache = home ? null : separateCache(from, cacheRoot);
    if (cache) await copy(cache, path.join(to, "cache"));
    const actual = await tally(to, undefined, exclude);
    if (actual.files !== expected.files || actual.bytes !== expected.bytes) {
      throw new MoveError(
        `copy verification failed: ${actual.files}/${expected.files} files, ` +
          `${actual.bytes}/${expected.bytes} bytes`
      );
    }
    for (const name of DB_FILES) {
      const file = path.join(to, name);
      if (!fs.existsSync(file)) continue;
      const result = checkDb(file);
      if (result !== "ok") throw new MoveError(`${name} integrity check failed: ${result}`);
    }

    if (home) {
      await switchHome(defaultUserData, from);
      return { ok: true, to };
    }

    const storeId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(to, MARKER_FILE),
      JSON.stringify({ storeId, channel, createdAt: now.toISOString() }, null, 2)
    );
    writePointer(defaultUserData, {
      version: POINTER_VERSION,
      dataRoot: to,
      storeId,
      movedAt: now.toISOString(),
      previousDataRoot: from,
    });
    // The pointer is committed: from here `to` is the live store and must never
    // be cleared. Leaving default mode, the pointer now names the cache and the
    // old copy; a stale bookkeeping file is harmless, so its removal cannot fail
    // the move.
    wroteInto = null;
    await fsp.rm(path.join(defaultUserData, CACHE_ROOT_FILE), { force: true }).catch(() => {});
    await fsp.rm(path.join(defaultUserData, PREVIOUS_ROOT_FILE), { force: true }).catch(() => {});
    return { ok: true, to };
  } catch (error) {
    // At home the default folder still holds the pointer: keep boot's files.
    if (wroteInto) await clearFolder(wroteInto, home ? HOME_BOOKKEEPING : undefined);
    return { ok: false, reason: error.message };
  } finally {
    await fsp.rm(pendingPath, { force: true });
  }
}

async function clearFolder(dir, keep = new Set([".DS_Store"])) {
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (keep.has(name)) continue;
    await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
}

function writeJsonAtomic(file, value) {
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, JSON.stringify(value, null, 2));
  fs.renameSync(staging, file);
}

// The data is home: default mode needs no marker. Record where the cache
// stayed and which folder is the old copy, then drop the pointer last, so a
// failure before that leaves pointer mode intact.
async function switchHome(defaultUserData, from) {
  const cacheDir = path.join(from, "cache");
  const cacheRootFile = path.join(defaultUserData, CACHE_ROOT_FILE);
  if (fs.existsSync(cacheDir)) writeJsonAtomic(cacheRootFile, { version: 1, cacheRoot: cacheDir });
  else await fsp.rm(cacheRootFile, { force: true });
  writeJsonAtomic(path.join(defaultUserData, PREVIOUS_ROOT_FILE), {
    version: 1,
    previousDataRoot: from,
  });
  await fsp.rm(path.join(defaultUserData, POINTER_FILE));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Pointer mode keeps previousDataRoot in the pointer; default mode (after a
// move home) keeps it in previous-data-root.json.
function readPreviousDataRoot(defaultUserData) {
  let record;
  try {
    record = readJson(path.join(defaultUserData, POINTER_FILE));
  } catch (error) {
    if (error.code !== "ENOENT") return null;
    try {
      record = readJson(path.join(defaultUserData, PREVIOUS_ROOT_FILE));
    } catch {
      return null;
    }
  }
  return record && typeof record.previousDataRoot === "string" ? record.previousDataRoot : null;
}

// The live model cache a move home left in the old data root, if any.
function readLiveCacheRoot(defaultUserData) {
  try {
    const { cacheRoot } = readJson(path.join(defaultUserData, CACHE_ROOT_FILE));
    return typeof cacheRoot === "string" && path.isAbsolute(cacheRoot) ? cacheRoot : null;
  } catch {
    return null;
  }
}

// Files boot still reads from the default userData folder (dataRootBootstrap).
const OLD_COPY_KEEP = [POINTER_FILE, PENDING_MOVE_FILE];

// True when dir carries this channel's store marker (written by a move or
// adoption), so it was a store of this app and not an arbitrary folder.
function isStoreOf(dir, channel) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), "utf8"));
    return Boolean(channel) && marker.channel === channel;
  } catch {
    return false;
  }
}

async function planOldCopy({ defaultUserData, dataRoot, channel }) {
  const previousDataRoot = readPreviousDataRoot(defaultUserData);
  if (!previousDataRoot || !path.isAbsolute(previousDataRoot)) {
    return planOldCopyRemoval({ previousDataRoot, dataRoot });
  }
  // Realpaths: a symlink or a differently-cased spelling must not hide the
  // live store from the planner.
  const old = realOrResolved(previousDataRoot);
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
  let entries = await fsp.readdir(old).catch(() => []);
  // After a move home the model cache still lives in the old data root and
  // is in use: never plan it, nor anything that contains it.
  const liveCache = readLiveCacheRoot(defaultUserData);
  if (liveCache) {
    const norm = (p) => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p));
    const cache = norm(realOrResolved(liveCache));
    entries = entries.filter((name) => !isInside(norm(path.join(old, name)), cache));
  }
  return planOldCopyRemoval({
    previousDataRoot: old,
    dataRoot: realOrResolved(dataRoot),
    defaultUserData: realOrResolved(defaultUserData),
    oldIsStore: isStoreOf(old, channel),
    caseInsensitive,
    keep: OLD_COPY_KEEP,
    entries,
  });
}

async function sizeOf(p) {
  const stat = await fsp.lstat(p).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return (await tally(p).catch(() => ({ bytes: 0 }))).bytes;
}

async function sizeOfAll(paths) {
  let bytes = 0;
  for (const p of paths) bytes += await sizeOf(p);
  return bytes;
}

// Deletes the planned paths, then forgets the old copy: previousDataRoot
// leaves the pointer, or previous-data-root.json goes in default mode.
async function removeOldCopy(options) {
  const plan = await planOldCopy(options);
  if (!plan.ok) return plan;
  const bytes = await sizeOfAll(plan.paths);
  for (const p of plan.paths) await fsp.rm(p, { recursive: true, force: true });
  const pointerPath = path.join(options.defaultUserData, POINTER_FILE);
  if (fs.existsSync(pointerPath)) {
    const pointer = JSON.parse(await fsp.readFile(pointerPath, "utf8"));
    delete pointer.previousDataRoot;
    writePointer(options.defaultUserData, pointer);
  } else {
    await fsp.rm(path.join(options.defaultUserData, PREVIOUS_ROOT_FILE), { force: true });
  }
  return { ok: true, bytes };
}

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// Settings IPC. Only a default or pointer store can move: OPENWHISPR_DATA_DIR
// and --user-data-dir outrank the pointer a move writes.
function registerDataFolderIpc({
  ipcMain,
  dialog,
  shell,
  app,
  resolution,
  defaultUserData,
  getCacheRoot,
  channel,
  t,
}) {
  const canMove = resolution.kind === "default" || resolution.kind === "pointer";
  // Default mode has an old copy only after a move home.
  const previous = () => (canMove ? readPreviousDataRoot(defaultUserData) : null);

  ipcMain.handle("data-folder-info", () => ({
    current: app.getPath("userData"),
    previous: previous(),
    canMove,
  }));
  ipcMain.handle("data-folder-reveal-previous", async () => {
    const dir = previous();
    if (dir) await shell.openPath(dir);
  });
  const oldCopyOptions = () => ({
    defaultUserData,
    dataRoot: app.getPath("userData"),
    channel,
  });
  ipcMain.handle("data-folder:old-copy-size", async () => {
    if (!previous()) return { ok: false, reason: "missing" };
    const plan = await planOldCopy(oldCopyOptions());
    if (!plan.ok) return plan;
    const bytes = await sizeOfAll(plan.paths);
    return { ok: true, bytes, size: formatSize(bytes) };
  });
  ipcMain.handle("data-folder:remove-old-copy", async () => {
    if (!previous()) return { ok: false, reason: "missing" };
    try {
      return await removeOldCopy(oldCopyOptions());
    } catch (error) {
      return { ok: false, reason: error.code || error.message };
    }
  });
  ipcMain.handle("data-folder-move", async () => {
    if (!canMove) return;
    const picked = await dialog.showOpenDialog({
      title: t("dataFolderMove.pickTitle"),
      properties: ["openDirectory", "createDirectory"],
    });
    const to = picked.filePaths?.[0];
    if (picked.canceled || !to) return;
    const from = app.getPath("userData");
    const cacheRoot = getCacheRoot();
    const refusal = checkDestination({ from, to, cacheRoot, defaultUserData });
    if (refusal) {
      await dialog.showMessageBox({
        type: "warning",
        message: t(`dataFolderMove.refused.${refusal}`),
        detail: to,
      });
      return;
    }
    const { bytes } = await measure(from, cacheRoot);
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: t("dataFolderMove.confirm", { size: formatSize(bytes) }),
      detail: to,
      buttons: [t("dataFolderMove.moveButton"), t("dataFolderMove.cancel")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    if (!requestMove({ defaultUserData, from, to, cacheRoot }).ok) return;
    app.relaunch();
    app.quit();
  });
}

module.exports = {
  registerDataFolderIpc,
  checkDestination,
  copyTree,
  measure,
  requestMove,
  runPendingMove,
  readPreviousDataRoot,
  removeOldCopy,
  integrityCheck,
};
