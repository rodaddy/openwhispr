const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The word trainer records on an AudioManager built with
// persistHistory: false; no failed, discarded, or completed take from it may
// reach history, whatever the retention settings say.
const retainEverything = {
  dataRetentionEnabled: true,
  audioRetentionDays: 30,
  saveDiscardedTranscriptions: true,
};

async function load(t) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-persist-history-test-",
    settingsKey: "__persistHistorySettings",
    settings: retainEverything,
  });
  const saves = [];
  loaded.window.electronAPI = {
    ...(loaded.window.electronAPI || {}),
    saveTranscription: async (...args) => {
      saves.push(args);
      return { id: null };
    },
    saveTranscriptionAudio: async () => {},
    recordAnalyticsEvent: async () => {},
  };
  return { ...loaded, saves };
}

test("a persistHistory:false manager writes no failed row", async (t) => {
  const { createManager, saves } = await load(t);
  const manager = createManager({ persistHistory: false, lastAudioBlob: new Blob(["x"]) });
  await manager.saveFailedTranscription("boom", "E", {});
  assert.equal(saves.length, 0);
  assert.equal(manager.lastAudioBlob, null);
});

test("a persistHistory:false manager writes no discarded row", async (t) => {
  const { createManager, saves } = await load(t);
  const manager = createManager({ persistHistory: false });
  manager.persistDiscardedBatchRecording({
    durationSeconds: 5,
    chunks: [new Blob(["x"])],
    segments: [],
    mimeType: "audio/webm",
  });
  await manager.saveDiscardedTranscription(new Blob(["x"]), 5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.length, 0);
});

test("a persistHistory:false manager writes no completed row", async (t) => {
  const { createManager, saves } = await load(t);
  const manager = createManager({ persistHistory: false });
  assert.equal(await manager.saveTranscription("hi", "hi"), true);
  assert.equal(saves.length, 0);
});

test("a default manager still writes the failed row", async (t) => {
  const { createManager, saves } = await load(t);
  const manager = createManager({ lastAudioBlob: null });
  await manager.saveFailedTranscription("boom", "E", {});
  assert.equal(saves.length, 1);
});
