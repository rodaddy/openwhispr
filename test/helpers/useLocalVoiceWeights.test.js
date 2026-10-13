const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

async function mountHook(t, { status, holdFirstRead = false }) {
  // Registered before the browser globals so the root unmounts while they exist.
  let root = null;
  const unmount = async () => {
    if (!root) return;
    const mounted = root;
    root = null;
    await React.act(async () => mounted.unmount());
  };
  t.after(unmount);

  const api = {
    downloadCalls: 0,
    profileReads: 0,
    subscribed: 0,
    subscribedBeforeFirstRead: null,
    releaseFirstRead: null,
    unsubscribed: 0,
    progress: null,
    finish: null,
  };
  let currentStatus = status;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        async getAssistantSpeechProfile() {
          api.profileReads += 1;
          if (api.profileReads === 1) {
            api.subscribedBeforeFirstRead = api.progress !== null;
            if (holdFirstRead) {
              return new Promise((resolve) => {
                api.releaseFirstRead = resolve;
              });
            }
          }
          return currentStatus;
        },
        downloadAssistantSpeechWeights() {
          api.downloadCalls += 1;
          return new Promise((resolve) => {
            api.finish = resolve;
          });
        },
        cancelAssistantSpeechWeightsDownload: async () => ({ success: true }),
        onAssistantSpeechWeightsProgress(callback) {
          api.subscribed += 1;
          api.progress = callback;
          return () => {
            api.unsubscribed += 1;
            api.progress = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-local-voice-weights-" });
  const { useLocalVoiceWeights } = await vite.ssrLoadModule(
    "/components/settings/useLocalVoiceWeights.ts"
  );

  let hook = null;
  function Harness() {
    hook = useLocalVoiceWeights();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  return {
    api,
    hook: () => hook,
    setStatus: (next) => {
      currentStatus = next;
    },
    start: async () => {
      await React.act(async () => {
        void hook.start();
      });
    },
    finish: async (result) => {
      await React.act(async () => {
        api.finish(result);
      });
    },
    releaseFirstRead: async (profile) => {
      await React.act(async () => {
        api.releaseFirstRead(profile);
      });
    },
    refresh: async () => {
      await React.act(async () => {
        await hook.refresh();
      });
    },
    emitProgress: async (progress) => {
      await React.act(async () => {
        api.progress(progress);
      });
    },
    unmount,
  };
}

const MISSING = { localAvailable: false, engineInstalled: true, weightsInstalled: false };
const INSTALLED = { localAvailable: true, engineInstalled: true, weightsInstalled: true };
const RUNNING = { ...MISSING, weightsDownloading: true, weightsPercentage: 37 };

test("mounting reads the status and downloads nothing", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  assert.equal(harness.api.downloadCalls, 0);
  assert.equal(harness.api.subscribedBeforeFirstRead, true);
  assert.equal(harness.hook().downloading, false);
  assert.deepEqual(harness.hook().status, MISSING);
});

test("a download that ends while the first status read is pending is noticed", async (t) => {
  const harness = await mountHook(t, { status: INSTALLED, holdFirstRead: true });

  await harness.emitProgress({ downloadedBytes: 400, totalBytes: 1000, percentage: 40 });
  assert.equal(harness.hook().downloading, true);
  await harness.emitProgress({ done: true, success: true });
  await harness.releaseFirstRead(INSTALLED);

  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().status.weightsInstalled, true);
});

test("a followed download the status no longer knows is cleared by a refresh", async (t) => {
  const harness = await mountHook(t, { status: RUNNING });
  assert.equal(harness.hook().downloading, true);

  harness.setStatus(MISSING);
  await harness.refresh();

  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().errorCode, null);
});

test("a progress event with no click shows another window's download", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.emitProgress({ downloadedBytes: 550, totalBytes: 1000, percentage: 55 });

  assert.equal(harness.api.downloadCalls, 0);
  assert.equal(harness.hook().downloading, true);
  assert.equal(harness.hook().percentage, 55);
});

test("a click answered in-progress keeps the percentage already shown", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  await harness.emitProgress({ downloadedBytes: 420, totalBytes: 1000, percentage: 42 });
  await harness.finish({ success: false, code: "cancelled" });

  await harness.start();
  await harness.finish({ success: false, code: "in-progress" });

  assert.equal(harness.hook().downloading, true);
  assert.equal(harness.hook().percentage, 42);
});

test("start downloads, follows progress, then re-reads the status on success", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  assert.equal(harness.api.downloadCalls, 1);
  assert.equal(harness.hook().downloading, true);

  await harness.emitProgress({ downloadedBytes: 420, totalBytes: 1000, percentage: 42 });
  assert.equal(harness.hook().percentage, 42);

  harness.setStatus(INSTALLED);
  await harness.finish({ success: true });
  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().errorCode, null);
  assert.deepEqual(harness.hook().status, INSTALLED);
});

test("a full disk is reported and a cancel is not", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  await harness.finish({ success: false, code: "disk-full" });
  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().errorCode, "disk-full");

  await harness.start();
  await harness.finish({ success: false, code: "cancelled" });
  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().errorCode, null);
});

test("one subscription lasts from mount to unmount", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  await harness.finish({ success: false, code: "cancelled" });
  await harness.start();
  assert.equal(harness.api.subscribed, 1);
  assert.equal(harness.api.unsubscribed, 0);

  await harness.unmount();
  assert.equal(harness.api.unsubscribed, 1);
});

test("mounting while a download runs shows it and follows it to its end", async (t) => {
  const harness = await mountHook(t, { status: RUNNING });

  assert.equal(harness.hook().downloading, true);
  assert.equal(harness.hook().percentage, 37);
  assert.equal(harness.api.downloadCalls, 0);

  // The status read after the end fails: the button must not come back.
  harness.setStatus(undefined);
  await harness.emitProgress({ done: true, success: true });
  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().status.weightsInstalled, true);
});

test("a start answered in-progress keeps following the download that runs", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  await harness.start();
  assert.equal(harness.api.downloadCalls, 1, "a second start while one runs calls the API once");

  await harness.finish({ success: false, code: "in-progress" });
  assert.equal(harness.hook().downloading, true);
  assert.equal(harness.hook().errorCode, null);

  await harness.emitProgress({ done: true, success: false, code: "checksum" });
  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().errorCode, "checksum");
});

test("the end of a download is handled once", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  const readsBefore = harness.api.profileReads;
  const finishOwn = harness.api.finish;
  await harness.emitProgress({ done: true, success: true });
  await React.act(async () => finishOwn({ success: true }));

  assert.equal(harness.api.profileReads, readsBefore + 1);
  assert.equal(harness.hook().downloading, false);
});

test("a status read that outlives a download does not revive it", async (t) => {
  const harness = await mountHook(t, { status: MISSING, holdFirstRead: true });

  await harness.emitProgress({ downloadedBytes: 400, totalBytes: 1000, percentage: 40 });
  await harness.emitProgress({ done: true, success: false, code: "cancelled" });
  await harness.releaseFirstRead({ ...INSTALLED, weightsDownloading: true, weightsPercentage: 37 });

  assert.equal(harness.hook().downloading, false);
  assert.equal(harness.hook().status.weightsInstalled, true);
});

test("a click right after a cancelled download starts a new one the late reply cannot end", async (t) => {
  const harness = await mountHook(t, { status: MISSING });

  await harness.start();
  const replyToFirstClick = harness.api.finish;
  await harness.emitProgress({ done: true, success: false, code: "cancelled" });
  await harness.start();
  assert.equal(harness.api.downloadCalls, 2);

  await React.act(async () => replyToFirstClick({ success: false, code: "cancelled" }));
  assert.equal(harness.hook().downloading, true);
  assert.equal(harness.hook().errorCode, null);
});
