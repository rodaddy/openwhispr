// Boot-time data-root resolution. Runs synchronously before app ready,
// so it touches only fs and path; main.js applies the result to Electron.
//
// Precedence: --user-data-dir > OPENWHISPR_DATA_DIR > pointer > channel default.
// A pointer that fails validation blocks boot: the app must never initialize a
// fresh store at the default location while a pointer says the data is elsewhere.
const fs = require("fs");
const path = require("path");

const POINTER_FILE = "data-root.json";
const MARKER_FILE = ".openwhispr-store.json";
const BOOT_LIMBO_DIR = "boot-limbo";
// Written by Settings > Move, consumed by the next boot (dataFolderMove.js).
const PENDING_MOVE_FILE = "pending-move.json";
const POINTER_VERSION = 1;
// Default mode after a move home: the model cache stayed on the drive, and the
// old data root waits for "Remove old copy" (dataFolderMove.js).
const CACHE_ROOT_FILE = "cache-root.json";
const PREVIOUS_ROOT_FILE = "previous-data-root.json";

// Production pins "open-whispr" rather than the default derived from the app name.
function channelDefaultUserData(appData, channel) {
  return path.join(appData, channel === "production" ? "open-whispr" : `OpenWhispr-${channel}`);
}

function readJsonFile(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { error };
  }
}

function isWritableDir(dir) {
  const probe = path.join(dir, `.openwhispr-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Checks a folder as a store for this channel. storeId is optional: adoption
// accepts whatever store the marker names; boot requires the pointer's one.
// Existence and writability only. A folder that is not there must never be
// created by boot: it may be an unmounted drive or a synced folder not yet back.
function inspectFolder(dir) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!stat.isDirectory()) return { ok: false, reason: "missing" };
  if (!isWritableDir(dir)) return { ok: false, reason: "not-writable" };
  return { ok: true };
}

function inspectStore(dir, { channel, storeId } = {}) {
  const folder = inspectFolder(dir);
  if (!folder.ok) return folder;

  const markerPath = path.join(dir, MARKER_FILE);
  if (!fs.existsSync(markerPath)) return { ok: false, reason: "no-marker" };
  const { value: marker } = readJsonFile(markerPath);
  if (!marker || typeof marker.storeId !== "string" || !marker.storeId) {
    return { ok: false, reason: "marker-corrupt" };
  }
  if (storeId && marker.storeId !== storeId) return { ok: false, reason: "store-mismatch" };
  if (marker.channel !== channel) {
    return { ok: false, reason: "channel-mismatch", markerChannel: marker.channel };
  }
  return { ok: true, marker };
}

// The cache a move home left on the drive. A folder that is not there (drive
// not mounted) is ignored: models fall back to the home cache, boot goes on.
function readCacheRoot(defaultUserData) {
  const { value } = readJsonFile(path.join(defaultUserData, CACHE_ROOT_FILE));
  const cacheRoot = value && value.cacheRoot;
  if (typeof cacheRoot !== "string" || !path.isAbsolute(cacheRoot)) return null;
  try {
    return fs.statSync(cacheRoot).isDirectory() ? cacheRoot : null;
  } catch {
    return null;
  }
}

function resolveBootDataRoot({ defaultUserData, channel, hasUserDataDirSwitch, envDataDir }) {
  if (hasUserDataDirSwitch) return { kind: "switch" };
  const blocked = (reason, dataRoot = null, extra = {}) => ({
    kind: "blocked",
    reason,
    dataRoot,
    defaultUserData,
    ...extra,
  });

  if (envDataDir && envDataDir.trim()) {
    const dataRoot = path.resolve(envDataDir.trim());
    // No marker check yet: nothing writes markers before the move engine, and
    // the env var is how a developer points at a fresh store on purpose.
    const check = inspectFolder(dataRoot);
    if (!check.ok) return blocked(check.reason, dataRoot, { source: "env" });
    return { kind: "env", dataRoot };
  }

  // A pending move runs before any store opens; it copies the store boot
  // would otherwise have used.
  const withPendingMove = (resolution, from) =>
    fs.existsSync(path.join(defaultUserData, PENDING_MOVE_FILE))
      ? { kind: "move", from, defaultUserData }
      : resolution;

  const pointerPath = path.join(defaultUserData, POINTER_FILE);
  if (!fs.existsSync(pointerPath)) {
    const resolution = { kind: "default", userData: defaultUserData };
    const cacheRoot = readCacheRoot(defaultUserData);
    if (cacheRoot) resolution.cacheRoot = cacheRoot;
    return withPendingMove(resolution, defaultUserData);
  }

  const { value: pointer } = readJsonFile(pointerPath);
  if (
    !pointer ||
    pointer.version !== POINTER_VERSION ||
    typeof pointer.dataRoot !== "string" ||
    !path.isAbsolute(pointer.dataRoot) ||
    typeof pointer.storeId !== "string" ||
    !pointer.storeId
  ) {
    return blocked("pointer-corrupt");
  }

  const check = inspectStore(pointer.dataRoot, { channel, storeId: pointer.storeId });
  if (!check.ok) {
    return blocked(
      check.reason === "marker-corrupt" ? "store-mismatch" : check.reason,
      pointer.dataRoot
    );
  }
  return withPendingMove(
    { kind: "pointer", dataRoot: pointer.dataRoot, storeId: pointer.storeId },
    pointer.dataRoot
  );
}

// Applies a resolution to Electron paths and cache env defaults. Returns the
// .env to load, or null when boot is blocked (no store is trusted yet).
function applyBootDataRoot(app, resolution, env = process.env) {
  switch (resolution.kind) {
    case "switch":
      // Chromium already set userData from the switch.
      return { dotenvPath: path.join(app.getPath("userData"), ".env") };
    case "default":
      app.setPath("userData", resolution.userData);
      if (resolution.cacheRoot && !env.OPENWHISPR_CACHE_ROOT) {
        env.OPENWHISPR_CACHE_ROOT = resolution.cacheRoot;
      }
      return { dotenvPath: path.join(resolution.userData, ".env") };
    case "env":
    case "pointer": {
      const root = resolution.dataRoot;
      app.setPath("userData", root);
      app.setPath("sessionData", root);
      app.setPath("logs", path.join(root, "logs"));
      app.setPath("crashDumps", path.join(root, "crashes"));
      if (!env.OPENWHISPR_CACHE_ROOT) env.OPENWHISPR_CACHE_ROOT = path.join(root, "cache");
      if (!env.OPENWHISPR_YTDLP_CACHE_DIR) {
        env.OPENWHISPR_YTDLP_CACHE_DIR = path.join(root, "cache", "yt-dlp");
      }
      return { dotenvPath: path.join(root, ".env") };
    }
    case "blocked":
    case "move":
      // Throwaway userData so the singleton lock and Chromium state touch
      // neither the real store nor any store file in the default folder.
      app.setPath("userData", path.join(resolution.defaultUserData, BOOT_LIMBO_DIR));
      return { dotenvPath: null };
    default:
      throw new Error(`Unknown data-root resolution: ${resolution.kind}`);
  }
}

function writePointer(defaultUserData, pointer) {
  const target = path.join(defaultUserData, POINTER_FILE);
  const staging = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(defaultUserData, { recursive: true });
  fs.writeFileSync(staging, JSON.stringify(pointer, null, 2));
  fs.renameSync(staging, target);
}

// "Choose folder…" during blocked boot adopts an existing store for this channel
// in place. Moving data into an empty folder is done from Settings once the app
// is running (the move engine), not from this boot dialog.
function adoptExistingStore({ defaultUserData, channel, folder, now = new Date() }) {
  const check = inspectStore(folder, { channel });
  if (!check.ok)
    return check.reason === "marker-corrupt" ? { ok: false, reason: "no-marker" } : check;
  writePointer(defaultUserData, {
    version: POINTER_VERSION,
    dataRoot: folder,
    storeId: check.marker.storeId,
    movedAt: now.toISOString(),
  });
  return { ok: true };
}

const REASON_KEYS = {
  missing: "missing",
  "not-writable": "notWritable",
  "no-marker": "noMarker",
  "store-mismatch": "mismatch",
  "channel-mismatch": "mismatch",
  "pointer-corrupt": "pointerCorrupt",
};
const REFUSAL_KEYS = {
  missing: "missing",
  "not-writable": "notWritable",
  "no-marker": "noMarker",
  "channel-mismatch": "channelMismatch",
};
// Retry can only help when the folder may come back (drive remounted,
// permissions fixed). An empty or foreign store must never be retried into.
const RETRYABLE = new Set(["missing", "not-writable"]);

// Blocking native dialog shown after whenReady and before any manager, DB,
// sidecar, window, or hub sync exists. Every path ends in exit: relaunch on a
// resolution, plain exit on Quit.
function runBlockedBootDialog({ resolution, channel, resolveAgain, dialog, app, t }) {
  const relaunch = () => {
    app.relaunch();
    app.exit(0);
  };
  let current = resolution;
  let notice = null;

  for (;;) {
    // An env-var block cannot be fixed by Choose: the env var outranks the
    // pointer that Choose writes, so the relaunch would block again.
    const actions = [
      RETRYABLE.has(current.reason) ? "retry" : null,
      current.source === "env" ? null : "choose",
      "quit",
    ].filter(Boolean);
    const detail = [
      notice,
      current.dataRoot ? t("dataFolderDialog.folderDetail", { path: current.dataRoot }) : null,
    ];
    const response = dialog.showMessageBoxSync({
      type: "warning",
      title: t("dataFolderDialog.title"),
      message: t(`dataFolderDialog.reason.${REASON_KEYS[current.reason]}`),
      detail: detail.filter(Boolean).join("\n\n"),
      buttons: actions.map((action) => t(`dataFolderDialog.${action}`)),
      defaultId: 0,
      cancelId: actions.length - 1,
      noLink: true,
    });
    const action = actions[response] || "quit";
    notice = null;

    if (action === "quit") return app.exit(0);
    if (action === "retry") {
      const next = resolveAgain();
      if (next.kind !== "blocked") return relaunch();
      current = next;
      continue;
    }

    const picked = dialog.showOpenDialogSync({
      title: t("dataFolderDialog.chooseTitle"),
      properties: ["openDirectory"],
    });
    if (!picked || picked.length === 0) continue;
    let adopted;
    try {
      adopted = adoptExistingStore({
        defaultUserData: current.defaultUserData,
        channel,
        folder: picked[0],
      });
    } catch (error) {
      // A failed pointer write (ENOSPC, EACCES, EPERM) must keep the dialog
      // up; escaping here leaves a windowless process holding the lock.
      notice = t("dataFolderDialog.refused.writeFailed", {
        error: error.code || error.message,
      });
      continue;
    }
    if (adopted.ok) return relaunch();
    notice = t(`dataFolderDialog.refused.${REFUSAL_KEYS[adopted.reason]}`, {
      channel: adopted.markerChannel,
    });
  }
}

// The whenReady gate: a move or blocked resolution runs only the move or the
// dialog and never reaches startApp (no manager, DB, sidecar, window, or hub
// sync). A throw from either goes to onBlockedError, which must exit.
function runBootGate({ resolution, runBlocked, runMove, start, onBlockedError }) {
  if (resolution.kind === "move") {
    // The move ends in relaunch; a throw must still exit, like the dialog.
    Promise.resolve().then(runMove).catch(onBlockedError);
    return "move";
  }
  if (resolution.kind === "blocked") {
    try {
      runBlocked();
    } catch (error) {
      onBlockedError(error);
    }
    return "blocked";
  }
  start();
  return "started";
}

module.exports = {
  POINTER_FILE,
  MARKER_FILE,
  BOOT_LIMBO_DIR,
  PENDING_MOVE_FILE,
  POINTER_VERSION,
  CACHE_ROOT_FILE,
  PREVIOUS_ROOT_FILE,
  channelDefaultUserData,
  writePointer,
  resolveBootDataRoot,
  applyBootDataRoot,
  adoptExistingStore,
  runBlockedBootDialog,
  runBootGate,
};
