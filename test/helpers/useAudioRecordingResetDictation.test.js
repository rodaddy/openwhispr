const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A failed dictation must blank everything out so the next
// press starts fresh. The fake records resetCapture calls and hands the hook's
// callbacks back to the test so failure outcomes can be fired directly.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    globalThis.__fakeAudioManager = this;
    this.resetReasons = [];
    this.cancelSources = [];
    this.startCalls = 0;
    this.nextStart = null;
  }
  getState() {
    return {};
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  setVoiceAgentRequested(value) {
    this.voiceAgentRequested = value;
  }
  setAssistantSelectionContext() {}
  setTranslationRequested(value) {
    this.translationRequested = value;
  }
  setMeetingHighlightRequested() {}
  shouldUseStreaming() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  resetCapture(reason) {
    this.resetReasons.push(reason);
  }
  cancelRecording(source) {
    this.cancelSources.push(source);
    return true;
  }
  cleanup() {}
  async startRecording() {
    this.startCalls += 1;
    if (this.nextStart) return this.nextStart;
    return false;
  }
}
`;

async function mountHook(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const reported = [];
  const unregisters = [];
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        unregisterCancelHotkey: () => unregisters.push(true),
        dictationLifecycleStateChanged: (state, inputKind) =>
          reported.push(`${state}:${inputKind}`),
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-reset-dictation-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const hook = { api: null };
  // Stable identities: a new toast/options per render re-runs the mount
  // effect, which builds a fresh AudioManager the test would not hold.
  const toast = () => {};
  const options = { onDemoEvent: () => {} };
  function Harness() {
    hook.api = useAudioRecording(toast, options);
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  const manager = globalThis.__fakeAudioManager;
  // Put the hook into a live recording so the failure has something to reset
  // (the mount effect's own "idle" report would otherwise dedup the assertion).
  await React.act(async () => {
    manager.callbacks.onStateChange({ isRecording: true, isProcessing: false });
  });
  reported.length = 0;
  unregisters.length = 0;
  return { hook, manager, reported, unregisters };
}

test("onNoAudio unregisters the cancel hotkey, reports idle and resets the capture", async (t) => {
  const { manager, reported, unregisters } = await mountHook(t);

  await React.act(async () => {
    manager.callbacks.onNoAudio();
  });

  assert.ok(unregisters.length >= 1, "cancel hotkey unregistered");
  assert.deepEqual(reported, ["idle:dictation"]);
  assert.deepEqual(manager.resetReasons, ["no-audio"]);
});

test("onError unregisters the cancel hotkey, reports idle and resets the capture", async (t) => {
  const { manager, reported, unregisters } = await mountHook(t);

  await React.act(async () => {
    manager.callbacks.onError({ title: "Recording Error", message: "mic failed" });
  });

  assert.ok(unregisters.length >= 1, "cancel hotkey unregistered");
  assert.deepEqual(reported, ["idle:dictation"]);
  assert.deepEqual(manager.resetReasons, ["error"]);
});

test("a silence-hallucination transcript resets the capture", async (t) => {
  const { manager, reported } = await mountHook(t);

  await React.act(async () => {
    await manager.callbacks.onTranscriptionComplete({ success: true, text: "Thank you." });
  });

  assert.deepEqual(reported, ["idle:dictation"]);
  assert.deepEqual(manager.resetReasons, ["no-speech"]);
});

test("a start that never began resets the capture once", async (t) => {
  const { hook, manager } = await mountHook(t);
  // Back to idle so a new start is allowed.
  await React.act(async () => {
    manager.callbacks.onStateChange({ isRecording: false, isProcessing: false });
  });

  let started;
  await React.act(async () => {
    started = await hook.api.startRecording();
  });

  assert.equal(started, false);
  assert.deepEqual(manager.resetReasons, ["start-failed"]);
});

test("a reset during an in-flight start leaves the start lock to that start's finally", async (t) => {
  const { hook, manager } = await mountHook(t);
  await React.act(async () => {
    manager.callbacks.onStateChange({ isRecording: false, isProcessing: false });
  });

  let resolveStart;
  manager.nextStart = new Promise((resolve) => {
    resolveStart = resolve;
  });

  let firstStart;
  await React.act(async () => {
    firstStart = hook.api.startRecording();
    // Let the start reach the awaited mic open.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(manager.startCalls, 1);

  await React.act(async () => {
    manager.callbacks.onError({ title: "Recording Error", message: "mic failed" });
  });

  // The lock is still held by the in-flight start: a second press is refused.
  let second;
  await React.act(async () => {
    second = await hook.api.startRecording();
  });
  assert.equal(second, false);
  assert.equal(manager.startCalls, 1);

  await React.act(async () => {
    resolveStart(false);
    await firstStart;
  });

  // Released by the finally: the next press reaches the mic open again.
  manager.nextStart = null;
  await React.act(async () => {
    await hook.api.startRecording();
  });
  assert.equal(manager.startCalls, 2);
});

test("cancelRecording passes its source through to the AudioManager", async (t) => {
  const { hook, manager } = await mountHook(t);

  await React.act(async () => {
    await hook.api.cancelRecording("escape-hotkey");
  });
  await React.act(async () => {
    await hook.api.cancelRecording();
  });

  assert.deepEqual(manager.cancelSources, ["escape-hotkey", "unknown"]);
});
