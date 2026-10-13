const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ipcHandlersSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
  "utf8"
);

const cleanupHandler = ipcHandlersSource.match(
  /ipcMain\.handle\("cleanup-app", async \(event\) => \{([\s\S]*?)ipcMain\.handle\("update-hotkey"/
);

test("explicit device cleanup covers models, credentials, caches, and browser settings", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const source = cleanupHandler[1];

  for (const operation of [
    "deleteAllParakeetModels",
    "diarizationManager?.deleteModels",
    "modelManager.deleteAllModels",
    "environmentManager?.clearAllPersistedData",
    "tokenStore.clear",
    "clearStorageData",
    "clearCache",
    "setAutoStartEnabled(false)",
  ]) {
    assert.ok(source.includes(operation), `device cleanup includes ${operation}`);
  }

  for (const cacheName of ["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"]) {
    assert.ok(source.includes(`"${cacheName}"`), `device cleanup removes ${cacheName}`);
  }

  assert.ok(
    source.includes("getCacheBaseRoot()"),
    "device cleanup resolves the home caches through getCacheBaseRoot"
  );
  assert.ok(!source.includes('".cache", "openwhispr"'), "no hard-coded home cache path");
});

test("device cleanup backs up and erases the data folder before deleting anything else", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const source = cleanupHandler[1];

  const eraseAt = source.indexOf("eraseDataFolder(");
  assert.ok(eraseAt >= 0, "device cleanup calls eraseDataFolder");
  assert.ok(source.includes('dataRoot: app.getPath("userData")'), "erases the active data folder");
  assert.ok(source.includes("defaultUserData: this.defaultUserData"), "passes the default folder");
  assert.ok(
    source.includes('removePointer: this.dataRootKind === "pointer"'),
    "removes the pointer only when the data folder came from it"
  );

  for (const deletion of [
    "deleteAllAudio",
    "getModelsDirForService",
    "deleteAllParakeetModels",
    "diarizationManager?.deleteModels",
    "modelManager.deleteAllModels",
    "fs.rmSync",
  ]) {
    const at = source.indexOf(deletion);
    if (at >= 0) assert.ok(eraseAt < at, `eraseDataFolder runs before ${deletion}`);
  }

  // A zip or trash failure returns before anything is deleted.
  const failure = source.match(
    /if \(erase\.step === "zip" \|\| erase\.step === "trash"\) \{([\s\S]*?)\n {8}\}/
  );
  assert.ok(failure, "zip/trash failure branch is present");
  assert.match(failure[1], /return \{/);
  assert.match(failure[1], /success: false/);
  assert.match(failure[1], /nothing was erased/);
  assert.doesNotMatch(failure[1], /rmSync|unlinkSync|delete/i);

  // Services are stopped and the DB closed, so the app restarts to come back whole.
  assert.match(failure[1], /app\.relaunch\(/);
  assert.match(failure[1], /app\.exit\(0\)/);
  assert.match(failure[1], /rTech Whisper restarts now/);
  // revokeAllTokens needs the open DB, so it runs before the backup: say so.
  const revokeAt = source.indexOf("revokeAllTokens");
  assert.ok(revokeAt >= 0, "revokeAllTokens is called");
  assert.ok(revokeAt < eraseAt, "revokeAllTokens runs while the DB is still open");
  assert.match(failure[1], /Google Calendar will need to be connected again/);

  assert.match(source, /A backup zip is in the Trash/);
});
