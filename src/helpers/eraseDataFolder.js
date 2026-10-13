// Erase all data (#257). Rico's decision: first a zip backup of the data
// folder, the zip goes to the Trash, then the folder is deleted, so the
// erase is recoverable from the Trash. The backup leaves out the top-level
// `cache` (models download again) and `tmp` folders. Nothing is deleted
// unless the zip was written and trashed.
//
// Pointer mode (#539): the default folder never holds the live store, so it
// is always an old copy: its entries are backed up under `default-folder/`
// and deleted. The copy the data moved from (previousDataRoot), when it is
// somewhere else, is backed up under `old-copy/` and deleted too. Otherwise
// the next boot opens the default folder and the old data comes back.
const fs = require("fs");
const path = require("path");
const {
  POINTER_FILE,
  PENDING_MOVE_FILE,
  CACHE_ROOT_FILE,
  PREVIOUS_ROOT_FILE,
  BOOT_LIMBO_DIR,
} = require("./dataRootBootstrap");
const { readPreviousDataRoot } = require("./dataFolderMove");

const fsp = fs.promises;
const EXCLUDED_TOP_DIRS = ["cache", "tmp"];
// Singleton* are Electron's live lock and socket entries (dataFolderMove skips them too).
const BASE_IGNORE = [...EXCLUDED_TOP_DIRS.flatMap((dir) => [dir, `${dir}/**`]), "Singleton*"];
// An old copy also leaves out this app's bookkeeping files.
const OLD_COPY_IGNORE = [
  ...BASE_IGNORE,
  POINTER_FILE,
  PENDING_MOVE_FILE,
  CACHE_ROOT_FILE,
  PREVIOUS_ROOT_FILE,
  BOOT_LIMBO_DIR,
  `${BOOT_LIMBO_DIR}/**`,
];
const OLD_COPY_PREFIX = "old-copy";
const DEFAULT_FOLDER_PREFIX = "default-folder";
// Files that keep the default folder marked as pointing at the live store;
// they stay until the old copies are gone.
const POINTER_KEEP = new Set([POINTER_FILE, PENDING_MOVE_FILE, PREVIOUS_ROOT_FILE]);
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3 };

function pad(n) {
  return String(n).padStart(2, "0");
}

function backupName(now) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `rTech Whisper backup ${date} ${time}.zip`;
}

// archiver 8 is ESM-only; load it lazily from this CommonJS module.
// oldCopies: [{ dir, prefix }], each backed up under its prefix.
async function writeZip(dataRoot, zipPath, oldCopies) {
  const { ZipArchive } = await import("archiver");
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.pipe(output);
    archive.glob("**/*", { cwd: dataRoot, dot: true, ignore: BASE_IGNORE });
    for (const { dir, prefix } of oldCopies) {
      archive.glob("**/*", { cwd: dir, dot: true, ignore: OLD_COPY_IGNORE }, { prefix });
    }
    archive.finalize().catch(reject);
  });
}

// True when child is parent or lies inside it.
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// The resolved folder when it can be erased as an old copy, else null: it
// must be an existing directory apart from (not equal to, inside, or around)
// the live folder.
function asOldCopy(folder, dataRoot) {
  if (!folder || !path.isAbsolute(folder)) return null;
  try {
    if (!fs.statSync(folder).isDirectory()) return null;
  } catch {
    return null;
  }
  const live = realPath(dataRoot);
  const old = realPath(folder);
  if (isWithin(live, old) || isWithin(old, live)) return null;
  return old;
}

// Filesystem identity, so a symlinked alias cannot make the live folder look
// separate from an old copy. Falls back to the lexical path when missing.
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Pointer mode's old copies: the default folder, and previousDataRoot when it
// is a separate folder.
function resolveOldCopies(defaultUserData, dataRoot) {
  const defaultFolder = asOldCopy(realPath(defaultUserData), dataRoot);
  let previous = asOldCopy(readPreviousDataRoot(defaultUserData), dataRoot);
  // Never a folder around (or inside) the default folder: deleting it whole
  // would take the pointer with it before the live store is gone.
  const home = realPath(defaultUserData);
  if (previous && (isWithin(previous, home) || isWithin(home, previous))) previous = null;
  return { defaultFolder, previous };
}

// Deletes the default folder's entries while the pointer still names the live
// store; the marker files stay for the next step.
async function clearDefaultFolder(defaultFolder, rm) {
  for (const name of await fsp.readdir(defaultFolder)) {
    if (POINTER_KEEP.has(name)) continue;
    await rm(path.join(defaultFolder, name), RM_OPTIONS);
  }
}

async function removeIgnoringMissing(file) {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// removePointer: true only when the running data folder came from the pointer
// in the default folder. Then the old copies go first, then the pointer and
// pending-move files, and only then the live folder, so a partial delete can
// never leave a pointer to a store whose marker is gone. In default mode they
// live in the folder being deleted; in env or switch mode they belong to
// another store and are never touched.
async function eraseDataFolder({
  dataRoot,
  defaultUserData,
  removePointer,
  trashItem,
  now = new Date(),
  rm = fsp.rm,
}) {
  if (typeof removePointer !== "boolean") {
    throw new TypeError("eraseDataFolder: removePointer must be a boolean");
  }

  const zipPath = path.join(path.dirname(dataRoot), backupName(now));
  const { defaultFolder, previous } = removePointer
    ? resolveOldCopies(defaultUserData, dataRoot)
    : { defaultFolder: null, previous: null };
  const oldCopies = [];
  if (defaultFolder) oldCopies.push({ dir: defaultFolder, prefix: DEFAULT_FOLDER_PREFIX });
  if (previous) oldCopies.push({ dir: previous, prefix: OLD_COPY_PREFIX });

  try {
    await writeZip(dataRoot, zipPath, oldCopies);
  } catch (error) {
    await fsp.rm(zipPath, { force: true }).catch(() => {});
    return { ok: false, step: "zip", error };
  }

  try {
    await trashItem(zipPath);
  } catch (error) {
    await fsp.rm(zipPath, { force: true }).catch(() => {});
    return { ok: false, step: "trash", error };
  }

  try {
    if (removePointer) {
      if (previous) await rm(previous, RM_OPTIONS);
      if (defaultFolder) await clearDefaultFolder(defaultFolder, rm);
      await removeIgnoringMissing(path.join(defaultUserData, POINTER_FILE));
      await removeIgnoringMissing(path.join(defaultUserData, PENDING_MOVE_FILE));
      await removeIgnoringMissing(path.join(defaultUserData, PREVIOUS_ROOT_FILE));
      await removeIgnoringMissing(path.join(defaultUserData, CACHE_ROOT_FILE));
    }
    await rm(dataRoot, RM_OPTIONS);
  } catch (error) {
    return { ok: false, step: "delete", error, zipPath };
  }

  return { ok: true, zipPath };
}

module.exports = { eraseDataFolder };
