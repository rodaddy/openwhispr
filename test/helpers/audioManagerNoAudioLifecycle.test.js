const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadManagerClass(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-no-audio-lifecycle-test-",
    settingsKey: "__noAudioLifecycleSettings",
    settings: {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      cloudTranscriptionMode: "byok",
      isSignedIn: false,
    },
  });
  return AudioManager;
}

function createManager(AudioManager, failure) {
  const order = [];
  const saved = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    _localSpeechGateState: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: {},
    processWithLocalWhisper: async () => {
      throw failure;
    },
    onStateChange: (state) => order.push(state.isProcessing ? "processing" : "idle"),
    onNoAudio: () => order.push("no-audio"),
    onError: () => order.push("error"),
    saveFailedTranscription: (message, code) => saved.push({ message, code }),
  });
  return { manager, order, saved };
}

test("local silence becomes one no-audio outcome after processing is idle", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, order, saved } = createManager(AudioManager, new Error("No audio detected"));

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.equal(manager.isProcessing, false);
  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, []);
});

test("dictionary-echo silence keeps the recording but shares the settled outcome", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { DICTIONARY_ECHO_CODE } = await import("../../src/utils/dictionaryEchoFilter.js");
  const failure = new Error("No audio detected");
  failure.code = DICTIONARY_ECHO_CODE;
  const { manager, order, saved } = createManager(AudioManager, failure);

  await manager.processAudio({ size: 256, type: "audio/webm" });

  assert.deepEqual(order, ["idle", "no-audio"]);
  assert.deepEqual(saved, [{ message: "No audio detected", code: DICTIONARY_ECHO_CODE }]);
});

test("a no-audio outcome drops the held mic and cancels the prepared capture", async (t) => {
  const AudioManager = await loadManagerClass(t);
  const { manager, order } = createManager(AudioManager, new Error("No audio detected"));
  manager.micStreamHold = { drop: () => order.push("hold-drop") };
  manager.preparedMicCapture = { cancel: () => order.push("prepared-cancel") };
  manager.cachedMicDeviceId = "stale-device";

  await manager.processAudio({ size: 256, type: "audio/webm" });

  // The next press must open the mic fresh, so the reset lands before the
  // no-audio surface takes over.
  assert.deepEqual(order, ["idle", "prepared-cancel", "hold-drop", "no-audio"]);
  assert.equal(manager.cachedMicDeviceId, null);
});
