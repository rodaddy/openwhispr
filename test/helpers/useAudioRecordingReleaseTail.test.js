const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// rtech-whisper#564: a normal stop keeps recording for a short tail so the
// last word is not cut; cancel and reset stop at once. The fake records each
// stop with the chunks it saw, so a chunk that lands during the tail must be
// in the stopped take.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    globalThis.__fakeAudioManager = this;
    this.state = { isRecording: false, isProcessing: false };
    this.chunks = [];
    this.stops = [];
    this.cancels = [];
    this.resetReasons = [];
    this.startCalls = 0;
  }
  getState() {
    return this.state;
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  setMeetingHighlightRequested() {}
  shouldUseStreaming() {
    return false;
  }
  prepareMicCapture() {}
  cancelPreparedMicCapture() {}
  resetCapture(reason) {
    this.resetReasons.push(reason);
  }
  stopRecording() {
    if (!this.state.isRecording) return false;
    this.stops.push([...this.chunks]);
    this.emit({ isRecording: false, isProcessing: true });
    return true;
  }
  cancelRecording(source) {
    this.cancels.push(source);
    this.emit({ isRecording: false, isProcessing: false });
    return true;
  }
  // Like the real manager, every state change goes out through onStateChange.
  emit(state) {
    this.state = state;
    this.callbacks.onStateChange(state);
  }
  cleanup() {}
  async startRecording() {
    this.startCalls += 1;
    return false;
  }
}
`;

const CUES_SOURCE = `
export const playStartCue = () => {};
export const playStopCue = () => {};
`;

async function mountRecording(t) {
  let root = null;
  // Every lifecycle state main is told, in order.
  const lifecycle = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
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
        unregisterCancelHotkey: () => {},
        dictationLifecycleStateChanged: (state) => lifecycle.push(state),
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-release-tail-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/dictationCues": CUES_SOURCE,
    },
  });
  const { useAudioRecording, RELEASE_TAIL_MS } = await vite.ssrLoadModule(
    "/hooks/useAudioRecording.js"
  );
  const hook = { api: null };
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
  manager.state = { isRecording: true, isProcessing: false };
  await React.act(async () => {
    manager.callbacks.onStateChange({ isRecording: true, isProcessing: false });
  });
  // Enable after Vite/React setup so only the hook's timers use the fake clock.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tick = (ms) => React.act(async () => t.mock.timers.tick(ms));
  const unmount = async () => {
    const mounted = root;
    root = null;
    await React.act(async () => mounted.unmount());
  };
  return { hook, manager, tick, lifecycle, unmount, RELEASE_TAIL_MS };
}

test("the tail is 400 ms", async (t) => {
  const { RELEASE_TAIL_MS } = await mountRecording(t);
  assert.equal(RELEASE_TAIL_MS, 400);
});

test("a stop keeps recording for the tail, and audio from the tail is in the take", async (t) => {
  const { hook, manager, tick } = await mountRecording(t);
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  manager.chunks.push("tail-word");
  await tick(399);
  assert.equal(manager.stops.length, 0, "still recording inside the tail");
  assert.equal(hook.api.isStopping, false, "pill stays listening during the tail");
  await tick(1);
  await React.act(async () => {
    assert.equal(await stop, true);
  });
  assert.deepEqual(manager.stops, [["tail-word"]]);
});

test("cancel during the tail stops at once with no stop", async (t) => {
  const { hook, manager, tick } = await mountRecording(t);
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  await React.act(async () => {
    await hook.api.cancelRecording("escape-hotkey");
  });
  assert.deepEqual(manager.cancels, ["escape-hotkey"]);
  await React.act(async () => {
    assert.equal(await stop, false);
  });
  await tick(1000);
  assert.equal(manager.stops.length, 0, "a cancelled tail never stops the take");
});

test("a second stop during the tail gives one stop, at once", async (t) => {
  const { hook, manager, tick } = await mountRecording(t);
  let first;
  let second;
  await React.act(async () => {
    first = hook.api.stopRecording();
  });
  await React.act(async () => {
    second = await hook.api.stopRecording();
    await first;
  });
  assert.equal(second, true);
  assert.equal(manager.stops.length, 1, "the second stop ends the tail early");
  await tick(1000);
  assert.equal(manager.stops.length, 1, "no second stop scheduled");
});

test("a press during the tail finishes the take and leaves one recording", async (t) => {
  const { hook, manager, tick } = await mountRecording(t);
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  let started;
  await React.act(async () => {
    started = await hook.api.startRecording();
    await stop;
  });
  assert.equal(manager.stops.length, 1, "the first take finished at once");
  assert.equal(started, false, "the take is processing, as for a press right after a stop");
  assert.equal(manager.startCalls, 0, "no second recording");
  await tick(1000);
  assert.equal(manager.stops.length, 1);

  // Once the take is done the next press starts normally.
  manager.state = { isRecording: false, isProcessing: false };
  await React.act(async () => {
    manager.callbacks.onStateChange({ isRecording: false, isProcessing: false });
  });
  await React.act(async () => {
    await hook.api.startRecording();
  });
  assert.equal(manager.startCalls, 1);
});

test("no tail timer survives a reset", async (t) => {
  const { hook, manager, tick } = await mountRecording(t);
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  await React.act(async () => {
    manager.callbacks.onError({ title: "Recording Error", message: "mic failed" });
  });
  await React.act(async () => {
    assert.equal(await stop, false);
  });
  await tick(1000);
  assert.equal(manager.stops.length, 0);
});

// Main parks and replays a press only while it sees `processing`, so the tail
// reports it; and main must never be left on `processing` once the take is over.
test("a stop reports processing when the tail starts, before the manager stops", async (t) => {
  const { hook, manager, tick, lifecycle, RELEASE_TAIL_MS } = await mountRecording(t);
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  assert.equal(lifecycle.at(-1), "processing", "main parks a press during the tail");
  assert.equal(manager.stops.length, 0, "the manager has not stopped yet");
  await tick(RELEASE_TAIL_MS);
  await React.act(async () => stop);
});

const TAIL_EXITS = {
  "the timer fires on a live take": async ({ manager, tick, RELEASE_TAIL_MS }) => {
    await tick(RELEASE_TAIL_MS);
    assert.equal(manager.stops.length, 1);
    await React.act(async () => manager.emit({ isRecording: false, isProcessing: false }));
  },
  "the take stops itself during the tail": async ({ manager, tick, RELEASE_TAIL_MS }) => {
    await React.act(async () => manager.emit({ isRecording: false, isProcessing: true }));
    await React.act(async () => manager.emit({ isRecording: false, isProcessing: false }));
    await tick(RELEASE_TAIL_MS);
    assert.equal(manager.stops.length, 0);
  },
  "the mic is lost during the tail": async ({ manager, tick, RELEASE_TAIL_MS }) => {
    await React.act(async () => manager.emit({ isRecording: false, isProcessing: false }));
    await tick(RELEASE_TAIL_MS);
  },
  "a second stop during the tail": async ({ hook, manager }) => {
    await React.act(async () => hook.api.stopRecording());
    await React.act(async () => manager.emit({ isRecording: false, isProcessing: false }));
  },
  "a press during the tail": async ({ hook, manager }) => {
    await React.act(async () => hook.api.startRecording());
    await React.act(async () => manager.emit({ isRecording: false, isProcessing: false }));
  },
  "cancel during the tail": async ({ hook }) => {
    await React.act(async () => hook.api.cancelRecording("escape-hotkey"));
  },
  "a reset during the tail": async ({ manager }) => {
    await React.act(async () =>
      manager.callbacks.onError({ title: "Recording Error", message: "mic failed" })
    );
  },
  "unmount during the tail": async ({ unmount }) => {
    await unmount();
  },
  "the stop throws after the tail": async ({ manager, tick, RELEASE_TAIL_MS }) => {
    manager.stopRecording = () => {
      throw new Error("recorder gone");
    };
    await tick(RELEASE_TAIL_MS);
    assert.deepEqual(manager.resetReasons, ["stop-failed"]);
  },
};

for (const [name, exit] of Object.entries(TAIL_EXITS)) {
  test(`main ends on idle when ${name}`, async (t) => {
    const mounted = await mountRecording(t);
    const { hook, lifecycle, tick } = mounted;
    let stop;
    await React.act(async () => {
      stop = hook.api.stopRecording();
    });
    await exit(mounted);
    await React.act(async () => stop);
    await tick(1000);
    assert.equal(lifecycle.at(-1), "idle", `lifecycle: ${lifecycle.join(" > ")}`);
  });
}

test("a mic status change during the tail keeps main on processing", async (t) => {
  const { hook, manager, tick, lifecycle, RELEASE_TAIL_MS } = await mountRecording(t);
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  await React.act(async () =>
    manager.callbacks.onStateChange({
      isRecording: true,
      isProcessing: false,
      micCaptureStatus: "unavailable",
    })
  );
  assert.equal(lifecycle.at(-1), "processing");
  await tick(RELEASE_TAIL_MS);
  await React.act(async () => stop);
});

// rtech-whisper#549 (2.0.23 log, 20:42:06.640): once the tail ended, a
// recording-state change from the stopping take (the manager re-emits
// isRecording:true on a mic status change) reported `recording`. Main read
// processing -> recording as "processing ended" and replayed the parked press
// into a renderer that was still stopping, which dropped it. A take that
// reported processing stays processing until it is idle, so the press is
// replayed once the take is over and starts exactly one new take.
test("a recording-state change while the stop finishes keeps main on processing", async (t) => {
  const { hook, manager, tick, lifecycle, RELEASE_TAIL_MS } = await mountRecording(t);
  const stopRecording = manager.stopRecording.bind(manager);
  manager.stopRecording = () => {
    manager.callbacks.onStateChange({
      isRecording: true,
      isProcessing: false,
      micCaptureStatus: "inactive",
    });
    return stopRecording();
  };
  let stop;
  await React.act(async () => {
    stop = hook.api.stopRecording();
  });
  const fromTail = lifecycle.length;
  await tick(RELEASE_TAIL_MS);
  await React.act(async () => stop);
  assert.deepEqual(
    lifecycle.slice(fromTail),
    [],
    `main never leaves processing before idle: ${lifecycle.join(" > ")}`
  );

  // The take ends in a no-speech reset; main replays the parked press on idle.
  await React.act(async () => manager.callbacks.onNoAudio());
  assert.equal(lifecycle.at(-1), "idle");
  manager.startRecording = async () => {
    manager.startCalls += 1;
    manager.emit({ isRecording: true, isProcessing: false });
    return true;
  };
  manager.state = { isRecording: false, isProcessing: false };
  await React.act(async () => {
    assert.equal(await hook.api.startRecording(), true);
  });
  assert.equal(manager.startCalls, 1, "the replayed press starts one new take");
  assert.equal(lifecycle.at(-1), "recording");
});
