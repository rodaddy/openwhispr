const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");

// The start path used to re-resolve the system default mic (a helper process
// spawn, p50 122 ms) on every press, even for a capture prepared a moment
// earlier. A fresh prepared capture now starts on its own constraints (#563).

async function load(t) {
  installMicCaptureGlobals(t);
  return loadAudioManager(t, {
    cachePrefix: "openwhispr-prepared-constraints-",
    settingsKey: "__preparedConstraintsSettings",
    settings: { microphoneSelectionMode: "automatic", micWarmHoldSeconds: 0 },
    mockModules: {
      "/i18n":
        "export default { t: (key) => key, getFixedT: () => (key) => key }; export const normalizeUiLanguage = (value) => value;",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__preparedConstraintsSettings;
        export const useSettingsStore = { subscribe: () => () => {}, getState: getSettings };
        export const getEffectiveCleanupModel = () => null;
        export const selectResolvedLLMConfig = () => ({ model: null, provider: null });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
    },
  });
}

async function startWithPrepared(t, ageMs, failedDeviceIds) {
  const { AudioManager } = await load(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const manager = new AudioManager();
  const track = { readyState: "live", label: "lark", stop() {}, getSettings: () => ({}) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const constraints = { audio: { deviceId: { exact: "lark" } } };
  const prepared = {
    stream,
    constraints,
    recorder: null,
    chunks: [],
    startedAt: Date.now() - ageMs,
  };
  const resolves = [];
  manager.preparedMicCapture.take = async () => prepared;
  manager.getAudioConstraints = async (...args) => {
    resolves.push(args);
    return constraints;
  };
  manager._acquireCaptureStream = async () => assert.fail("prepared stream must be reused");
  manager.createBatchRecorder = () => {};
  manager.beginMicRecovery = async () => {};
  manager.isRecordingAllowedByPolicy = () => true;
  manager.onStateChange = () => {};
  t.after(() => {
    clearInterval(manager._silenceInterval);
    manager._silenceInterval = null;
  });

  assert.equal(await manager.startRecording(false, failedDeviceIds), true);
  return resolves;
}

test("a freshly prepared capture starts without re-resolving the system default mic", async (t) => {
  const resolves = await startWithPrepared(t, 200);
  assert.deepEqual(resolves, []);
});

test("a stale prepared capture still re-resolves the system default mic", async (t) => {
  const resolves = await startWithPrepared(t, 5000);
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0][1], true);
});

test("a retry that excludes failed devices still re-resolves even when fresh", async (t) => {
  const resolves = await startWithPrepared(t, 200, new Set(["other"]));
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0][1], true);
});

test("the freshness rule the streaming start shares", async (t) => {
  const { AudioManager } = await load(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const manager = new AudioManager();
  const now = Date.now();
  assert.equal(manager._preparedConstraintsFresh({ startedAt: now - 100 }), true);
  assert.equal(manager._preparedConstraintsFresh({ startedAt: now - 3500 }), false);
  assert.equal(manager._preparedConstraintsFresh({}), false);
  assert.equal(manager._preparedConstraintsFresh({ startedAt: now }, new Set(["x"])), false);
});

// The prepare path reads the main-process system-default cache (30 s TTL). A
// devicechange must make the next prepare refresh it, or a fresh capture can
// carry the pre-switch default past the skip above.
async function preparingManager(t) {
  const { AudioManager } = await load(t);
  const manager = new AudioManager();
  const track = { readyState: "live", label: "lark", stop() {}, getSettings: () => ({}) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const refreshes = [];
  let failNext = false;
  manager.isRecordingAllowedByPolicy = () => true;
  manager.shouldUseStreaming = () => true;
  manager.getAudioConstraints = async (_force, refresh) => {
    refreshes.push(refresh);
    if (failNext) {
      failNext = false;
      throw new Error("resolve failed");
    }
    return { audio: { deviceId: { exact: "lark" } } };
  };
  manager._acquireCaptureStream = async () => stream;
  const prepare = async () => {
    const prepared = await manager.prepareMicCapture();
    manager.cancelPreparedMicCapture();
    return prepared;
  };
  t.after(() => manager.cancelPreparedMicCapture());
  return { manager, refreshes, prepare, failOnce: () => (failNext = true) };
}

test("the first prepare after a devicechange refreshes the system default, the next does not", async (t) => {
  const { manager, refreshes, prepare } = await preparingManager(t);
  manager._onDeviceChange();
  assert.ok(await prepare());
  assert.ok(await prepare());
  assert.deepEqual(refreshes, [true, false]);
});

test("a prepare that fails after a devicechange leaves the refresh owed", async (t) => {
  const { manager, refreshes, prepare, failOnce } = await preparingManager(t);
  manager._onDeviceChange();
  failOnce();
  assert.equal(await prepare(), null);
  assert.ok(await prepare());
  assert.ok(await prepare());
  assert.deepEqual(refreshes, [true, true, false]);
});

test("without a devicechange prepare never refreshes the system default", async (t) => {
  const { refreshes, prepare } = await preparingManager(t);
  assert.ok(await prepare());
  assert.ok(await prepare());
  assert.deepEqual(refreshes, [false, false]);
});
