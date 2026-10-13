const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/grillListen.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A mic whose getUserMedia waits until the test opens it; counts what gets built.
function fakeBrowser() {
  const built = { audioContexts: 0, recorders: 0 };
  const stopped = [];
  let open;
  const tracks = [{ stop: () => stopped.push("audio-0") }, { stop: () => stopped.push("audio-1") }];
  const stream = { getTracks: () => tracks };
  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    AudioContext: globalThis.AudioContext,
    MediaRecorder: globalThis.MediaRecorder,
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => new Promise((resolve) => (open = () => resolve(stream))),
      },
    },
  });
  globalThis.AudioContext = class {
    constructor() {
      built.audioContexts += 1;
      throw new Error("an aborted take must not build an audio graph");
    }
  };
  globalThis.MediaRecorder = class {
    constructor() {
      built.recorders += 1;
      throw new Error("an aborted take must not record");
    }
  };
  const restore = () => {
    if (originals.navigator) Object.defineProperty(globalThis, "navigator", originals.navigator);
    else delete globalThis.navigator;
    globalThis.AudioContext = originals.AudioContext;
    globalThis.MediaRecorder = originals.MediaRecorder;
  };
  return { built, stopped, open: () => open(), restore };
}

test("an abort while the mic is opening returns aborted and stops every track at once", async (t) => {
  const { recordGrillAnswer } = await load();
  const browser = fakeBrowser();
  t.after(browser.restore);
  const controller = new AbortController();
  let settled = null;
  const take = recordGrillAnswer({ signal: controller.signal }).then((r) => (settled = r));

  await tick();
  controller.abort();
  await tick();
  assert.deepEqual(settled, { kind: "aborted" }, "the abort answers without waiting for the mic");

  browser.open();
  await take;
  await tick();
  assert.deepEqual(browser.stopped, ["audio-0", "audio-1"]);
  assert.deepEqual(browser.built, { audioContexts: 0, recorders: 0 }, "nothing records");
});

test("an abort that lands as the mic opens stops the tracks and records nothing", async (t) => {
  const { recordGrillAnswer } = await load();
  const browser = fakeBrowser();
  t.after(browser.restore);
  const controller = new AbortController();
  const take = recordGrillAnswer({ signal: controller.signal });
  await tick();
  browser.open();
  controller.abort();
  assert.deepEqual(await take, { kind: "aborted" });
  await tick();
  assert.deepEqual(browser.stopped, ["audio-0", "audio-1"]);
  assert.deepEqual(browser.built, { audioContexts: 0, recorders: 0 });
});
