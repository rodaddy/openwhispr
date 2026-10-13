const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A fake AudioManager: records every call so the test can prove the trainer
// take never pastes or saves history.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor(options) {
    this.options = options;
    this.calls = [];
    (globalThis.__trainerManagers ||= []).push(this);
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  // Like the real one: the mic is only "recording" once start resolves, and a
  // cancel before that is a no-op. globalThis.__startGate holds a start open.
  async startRecording() {
    this.calls.push("start");
    this.starting = (this.starting || 0) + 1;
    if (globalThis.__startGate) await globalThis.__startGate;
    this.starting -= 1;
    this.recording = true;
    return true;
  }
  stopRecording() { this.calls.push("stop"); return true; }
  cancelRecording() {
    this.calls.push("cancel");
    const was = !!this.recording;
    this.recording = false;
    return was;
  }
  async safePaste() { this.calls.push("safePaste"); return true; }
  async saveTranscription() { this.calls.push("saveTranscription"); return true; }
  cleanup() { this.calls.push("cleanup"); }
}
`;

async function setup(t, { live = false } = {}) {
  // Registered first so the root unmounts before the harness removes its globals.
  let root = null;
  t.after(async () => {
    if (root && !root.unmounted) await React.act(async () => root.unmount());
    delete globalThis.__trainerManagers;
    delete globalThis.__startGate;
  });
  const bridge = { live, listeners: new Set(), saves: 0 };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getDictationLive: async () => bridge.live,
        onDictationLiveChanged: (cb) => {
          bridge.listeners.add(cb);
          return () => bridge.listeners.delete(cb);
        },
        saveTranscription: async () => {
          bridge.saves += 1;
        },
      },
    },
  });
  bridge.setLive = (value) => {
    bridge.live = value;
    for (const cb of bridge.listeners) cb(value);
  };
  globalThis.__trainerManagers = [];
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-trainer-take-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": `export default { debug() {}, info() {}, warn() {}, error() {} };`,
    },
  });
  const { useTrainerTake } = await vite.ssrLoadModule("/hooks/useTrainerTake.ts");
  const hook = { current: null };
  function Harness() {
    hook.current = useTrainerTake();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const manager = globalThis.__trainerManagers[0];
  return { bridge, hook, root, manager };
}

test("a take resolves to the raw text and never pastes or saves history", async (t) => {
  const { bridge, hook, manager } = await setup(t);
  assert.deepEqual(await hook.current.startTake(), { ok: true });
  const done = hook.current.stopTake();
  await React.act(async () =>
    manager.callbacks.onTranscriptionComplete({
      success: true,
      text: "Cleaned.",
      rawText: "raw words",
    })
  );
  assert.deepEqual(await done, { rawText: "raw words" });
  assert.ok(!manager.calls.includes("safePaste"));
  assert.ok(!manager.calls.includes("saveTranscription"));
  assert.equal(bridge.saves, 0);
});

test("a take falls back to text when rawText is missing", async (t) => {
  const { hook, manager } = await setup(t);
  await hook.current.startTake();
  const done = hook.current.stopTake();
  await React.act(async () =>
    manager.callbacks.onTranscriptionComplete({ success: true, text: "only text" })
  );
  assert.deepEqual(await done, { rawText: "only text" });
});

test("a take is refused while global dictation is live", async (t) => {
  const { hook, manager } = await setup(t, { live: true });
  assert.deepEqual(await hook.current.startTake(), { error: "dictation is running" });
  assert.ok(!manager.calls.includes("start"));
});

test("global dictation starting mid-take discards the take", async (t) => {
  const { bridge, hook, manager } = await setup(t);
  await hook.current.startTake();
  await React.act(async () => bridge.setLive(true));
  assert.deepEqual(await hook.current.stopTake(), { discarded: true });
  assert.ok(manager.calls.includes("cancel"));
  // A late completion from the dropped take is ignored, never pasted.
  manager.callbacks.onTranscriptionComplete?.({ success: true, text: "late" });
  assert.ok(!manager.calls.includes("safePaste"));
});

test("only one take runs at a time", async (t) => {
  const { hook } = await setup(t);
  assert.deepEqual(await hook.current.startTake(), { ok: true });
  assert.deepEqual(await hook.current.startTake(), { error: "a take is already running" });
});

test("unmount cleans up the take's audio manager", async (t) => {
  const { root, manager } = await setup(t);
  await React.act(async () => root.unmount());
  root.unmounted = true;
  assert.ok(manager.calls.includes("cleanup"));
});

test("a silent take settles instead of hanging, and the next take can start", async (t) => {
  const { hook, manager } = await setup(t);
  await hook.current.startTake();
  const done = hook.current.stopTake();
  await React.act(async () => manager.callbacks.onNoAudio());
  assert.deepEqual(await done, { error: "No speech heard" });
  assert.deepEqual(await hook.current.startTake(), { ok: true });
});

test("the take recorder opts out of history persistence", async (t) => {
  const { manager } = await setup(t);
  assert.equal(manager.options?.persistHistory, false);
});

function gate() {
  let open;
  globalThis.__startGate = new Promise((resolve) => (open = resolve));
  return () => {
    delete globalThis.__startGate;
    open();
  };
}

test("cancelling while a take is starting releases the mic once the start lands", async (t) => {
  const { hook, manager } = await setup(t);
  const open = gate();
  const starting = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  hook.current.cancelTake();
  open();
  assert.ok("error" in (await starting));
  assert.equal(manager.recording, false, "the mic must not stay hot after a cancelled start");
  // The trainer is usable again: the next take starts.
  assert.deepEqual(await hook.current.startTake(), { ok: true });
});

test("a new take waits for a cancelled start instead of opening a second recorder", async (t) => {
  const { hook, manager } = await setup(t);
  const open = gate();
  const first = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  hook.current.cancelTake();
  const second = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.starting, 1, "only one start may be in flight");
  open();
  assert.ok("error" in (await first));
  assert.deepEqual(await second, { ok: true });
  assert.equal(manager.recording, true);
  // The second take is the live one: stopping it reaches the recorder.
  const done = hook.current.stopTake();
  await React.act(async () =>
    manager.callbacks.onTranscriptionComplete({ success: true, rawText: "second" })
  );
  assert.deepEqual(await done, { rawText: "second" });
});

// A take parked behind a cancelled start has not reserved itself yet, so a
// cancel or unmount while it waits must still stop it from opening the mic.
test("cancelling a take parked behind a cancelled start keeps the mic off", async (t) => {
  const { hook, manager } = await setup(t);
  const open = gate();
  const first = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  hook.current.cancelTake();
  const second = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  hook.current.cancelTake();
  open();
  assert.ok("error" in (await first));
  assert.deepEqual(await second, { error: "The take was cancelled" });
  assert.equal(manager.calls.filter((c) => c === "start").length, 1);
  assert.equal(manager.recording, false, "the mic must not stay hot");
  // The trainer is still usable: the next take starts.
  assert.deepEqual(await hook.current.startTake(), { ok: true });
});

test("stopping a take parked behind a cancelled start keeps the mic off", async (t) => {
  const { hook, manager } = await setup(t);
  const open = gate();
  const first = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  hook.current.cancelTake();
  const second = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await hook.current.stopTake(), { discarded: true });
  open();
  assert.ok("error" in (await first));
  assert.ok("error" in (await second));
  assert.equal(manager.calls.filter((c) => c === "start").length, 1);
  assert.equal(manager.recording, false);
});

test("unmounting while a take is parked never opens the mic on the dead manager", async (t) => {
  const { hook, manager, root } = await setup(t);
  const open = gate();
  const first = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  hook.current.cancelTake();
  const second = hook.current.startTake();
  await new Promise((resolve) => setImmediate(resolve));
  await React.act(async () => root.unmount());
  root.unmounted = true;
  open();
  assert.ok("error" in (await first));
  assert.ok("error" in (await second));
  assert.equal(manager.calls.filter((c) => c === "start").length, 1);
  assert.equal(manager.recording, false);
});
