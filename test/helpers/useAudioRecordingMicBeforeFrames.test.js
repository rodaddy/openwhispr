const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// macOS opens the mic before the visual-frame wait; elsewhere the wait
// still keeps a slow driver wake off the paint path.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  getState() {
    return {};
  }
  setCallbacks() {}
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  setMeetingHighlightRequested() {}
  shouldUseStreaming() {
    return false;
  }
  prepareMicCapture() {
    globalThis.__micFrameEvents.push("prepare");
  }
  cancelPreparedMicCapture() {}
  cleanup() {}
  async startRecording() {
    return false;
  }
}
`;

const FAKE_VISUAL_FRAME_SOURCE = `
export const waitForVisualFrames = () => {
  globalThis.__micFrameEvents.push("frame-wait");
  return new Promise((resolve) => {
    globalThis.__releaseFrames = () => {
      globalThis.__micFrameEvents.push("frames-done");
      resolve();
    };
  });
};
`;

async function mount(t, platform) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const events = [];
  globalThis.__micFrameEvents = events;
  t.after(() => {
    delete globalThis.__micFrameEvents;
    delete globalThis.__releaseFrames;
  });
  let prepareHandler = null;
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => platform,
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: (handler) => {
          prepareHandler = handler;
          return () => {};
        },
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-mic-before-frames-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/visualFrame": FAKE_VISUAL_FRAME_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  let api;
  function Harness() {
    api = useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  return { api: () => api, prepare: () => prepareHandler, events };
}

async function runStart(harness) {
  let pending;
  await React.act(async () => {
    pending = harness.api().startRecording();
    await Promise.resolve();
  });
  const beforeFrames = [...harness.events];
  await React.act(async () => {
    globalThis.__releaseFrames();
    await pending;
  });
  return beforeFrames;
}

async function runPrepare(harness) {
  let pending;
  await React.act(async () => {
    pending = harness.prepare()({ inputKind: "dictation" });
    await Promise.resolve();
  });
  const beforeFrames = [...harness.events];
  await React.act(async () => {
    globalThis.__releaseFrames();
    await pending;
  });
  return beforeFrames;
}

test("on macOS the start path opens the mic before the frame wait resolves", async (t) => {
  const harness = await mount(t, "darwin");
  assert.deepEqual(await runStart(harness), ["prepare", "frame-wait"]);
  assert.deepEqual(harness.events, ["prepare", "frame-wait", "frames-done"]);
});

test("on Windows the start path opens the mic only after the frame wait", async (t) => {
  const harness = await mount(t, "win32");
  assert.deepEqual(await runStart(harness), ["frame-wait"]);
  assert.deepEqual(harness.events, ["frame-wait", "frames-done", "prepare"]);
});

test("on macOS the prepare event opens the mic before the frame wait resolves", async (t) => {
  const harness = await mount(t, "darwin");
  assert.deepEqual(await runPrepare(harness), ["prepare", "frame-wait"]);
  assert.deepEqual(harness.events, ["prepare", "frame-wait", "frames-done"]);
});

test("on Linux the prepare event opens the mic only after the frame wait", async (t) => {
  const harness = await mount(t, "linux");
  assert.deepEqual(await runPrepare(harness), ["frame-wait"]);
  assert.deepEqual(harness.events, ["frame-wait", "frames-done", "prepare"]);
});
