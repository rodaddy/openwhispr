const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");

const baseSettings = {
  microphoneSelectionMode: "automatic",
  preferredMicDeviceId: "lark",
  preferredMicDeviceLabel: "Wireless microphone (3547:0007)",
  fallbackMicDeviceId: "backup",
  fallbackMicDeviceLabel: "Backup microphone",
  micWarmHoldSeconds: 0,
};

async function load(t) {
  installMicCaptureGlobals(t);
  return loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-fallback-owner-",
    settingsKey: "__micFallbackOwnerSettings",
    settings: {
      ...baseSettings,
    },
    mockModules: {
      "/i18n":
        "export default { t: (key) => key, getFixedT: () => (key) => key }; export const normalizeUiLanguage = (value) => value;",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__micFallbackOwnerSettings;
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

test("AudioManager active mic loss uses normal batch stop and preserves captured bytes", async (t) => {
  const { AudioManager } = await load(t);
  const manager = new AudioManager();
  const first = new Uint8Array(1024).fill(1);
  const second = new Uint8Array(1024).fill(2);
  let processed = null;
  let acquired = 0;
  let resolveProcessed;
  const processedPromise = new Promise((resolve) => (resolveProcessed = resolve));
  class FakeMediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      void this.onstop?.();
    }
  }
  globalThis.MediaRecorder = FakeMediaRecorder;
  t.after(() => delete globalThis.MediaRecorder);
  const track = { stop() {}, addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  manager.isRecording = true;
  manager.isStreaming = false;
  manager.recordingStartTime = Date.now();
  manager._batchSegments = [];
  manager._receivedAudioData = false;
  manager._processingCancellationGeneration = 0;
  manager._streamingCancellationGeneration = 0;
  manager._localSpeechGateState = null;
  manager._streamingCommitActive = false;
  manager.teardownSpeechGate = () => {};
  manager.cleanupPreview = async () => null;
  manager.shouldShowPreviewCleanupState = () => false;
  manager.processAudio = async (blob) => {
    processed = new Uint8Array(await blob.arrayBuffer());
    resolveProcessed();
  };
  manager.onStateChange = () => {};
  manager.micRecovery.acquire = async () => {
    acquired += 1;
  };
  const recorder = manager.createBatchRecorder(stream);
  recorder.ondataavailable({ data: new Blob([first], { type: "audio/webm" }) });
  recorder.ondataavailable({ data: new Blob([second], { type: "audio/webm" }) });

  await manager.micRecovery.onActiveLoss("ended");
  await processedPromise;

  assert.deepEqual(processed, new Uint8Array([...first, ...second]));
  assert.deepEqual(new Uint8Array(await manager.lastAudioBlob.arrayBuffer()), processed);
  assert.equal(acquired, 0);
  manager.cleanup();
});

test("AudioManager automatic startup retries preferred then configured fallback before default", async (t) => {
  const { AudioManager, window } = await load(t);
  const devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - System", groupId: "sys" },
    { kind: "audioinput", deviceId: "system", label: "System", groupId: "sys" },
    { kind: "audioinput", deviceId: "backup", label: "Backup microphone", groupId: "backup" },
    {
      kind: "audioinput",
      deviceId: "lark",
      label: "Wireless microphone (3547:0007)",
      groupId: "lark",
    },
  ];
  navigator.mediaDevices.enumerateDevices = async () => devices;
  window.electronAPI.getLarkM2Status = async () => ({ status: "connected" });
  window.electronAPI.getSystemDefaultMicrophone = async () => ({ name: "System" });
  const attempts = [];
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const id = constraints.audio?.deviceId?.exact || "browser-default";
    attempts.push(id);
    if (id === "lark") throw Object.assign(new Error("gone"), { name: "NotFoundError" });
    return {
      getTracks: () => [],
      getAudioTracks: () => [
        { readyState: "live", label: id, getSettings: () => ({ deviceId: id }) },
      ],
    };
  };
  const manager = new AudioManager();
  manager.cachedMicDeviceId = "stale-preferred";
  manager.preparedMicCapture.take = async () => null;
  manager._acquireCaptureStream = (constraints) => navigator.mediaDevices.getUserMedia(constraints);
  manager.createBatchRecorder = () => {};
  manager.beginMicRecovery = async () => {};
  manager.isRecordingAllowedByPolicy = () => true;
  manager.onStateChange = () => {};

  assert.equal(await manager.startRecording(), true);
  assert.deepEqual(attempts.slice(0, 2), ["lark", "backup"]);
  assert.equal(attempts.includes("browser-default"), false);
  clearInterval(manager._silenceInterval);
  manager._silenceInterval = null;
  manager.cleanup();
});

test("AudioManager stopRecording called twice before onstop finalizes the take once", async (t) => {
  const { AudioManager } = await load(t);
  const manager = new AudioManager();
  class FakeMediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
    }
    // A real recorder goes inactive at once but fires onstop later.
    stop() {
      this.state = "inactive";
    }
  }
  globalThis.MediaRecorder = FakeMediaRecorder;
  t.after(() => delete globalThis.MediaRecorder);
  const track = { stop() {}, addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  manager.isRecording = true;
  manager.isStreaming = false;
  manager.recordingStartTime = Date.now();
  manager._batchSegments = [];
  manager._receivedAudioData = false;
  manager._processingCancellationGeneration = 0;
  manager._streamingCancellationGeneration = 0;
  manager._localSpeechGateState = null;
  manager._streamingCommitActive = false;
  manager.teardownSpeechGate = () => {};
  manager.cleanupPreview = async () => null;
  manager.shouldShowPreviewCleanupState = () => false;
  manager.processAudio = async () => {};
  manager.onStateChange = () => {};
  const finalized = [];
  const finalize = manager.finalizeBatchRecording.bind(manager);
  manager.finalizeBatchRecording = (segment) => {
    finalized.push(segment);
    return finalize(segment);
  };
  const recorder = manager.createBatchRecorder(stream);
  recorder.ondataavailable({
    data: new Blob([new Uint8Array(64).fill(1)], { type: "audio/webm" }),
  });

  assert.equal(manager.stopRecording(), true);
  assert.equal(manager.stopRecording(), false);
  assert.equal(finalized.length, 0);

  await recorder.onstop();

  assert.equal(finalized.length, 1);
  assert.notEqual(finalized[0], null);
  assert.equal(manager._batchStopPending, false);
  manager.cleanup();
});
