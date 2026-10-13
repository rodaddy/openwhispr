const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("fresh renderer profiles use hybrid activation and growing previews", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-ux-defaults-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  assert.equal(state.activationMode, "hybrid");
  assert.equal(state.transcriptionPreviewLayout, "grow");
});

test("renderer profiles preserve explicit activation and preview layout choices", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { activationMode: "tap", transcriptionPreviewLayout: "fixed2lines" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-ux-stored-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  assert.equal(state.activationMode, "tap");
  assert.equal(state.transcriptionPreviewLayout, "fixed2lines");
});

test("a paste-last key the main process no longer has is cleared at startup", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { pasteLastKey: "Control+Shift+V" },
    window: {
      electronAPI: {
        getPasteLastKey: async () => "",
        getDictionary: async () => [],
        setDictionary: async () => ({ success: true }),
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-paste-last-sync-" });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  assert.equal(useSettingsStore.getState().pasteLastKey, "Control+Shift+V");

  await initializeSettings();

  assert.equal(useSettingsStore.getState().pasteLastKey, "");
});

test("an auto-submit word floor outside 2 to 12 reads back as 3", async (t) => {
  for (const stored of ["0", "99", "x"]) {
    installBrowserGlobals(t, { initialStorage: { dictationAutoSubmitMinWords: stored } });
    const vite = await createRendererServer(t, { cachePrefix: "openwhispr-auto-submit-floor-" });
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    assert.equal(useSettingsStore.getState().dictationAutoSubmitMinWords, 3, stored);
  }
});

test("the dictation latency readout is off until it is turned on", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-show-latency-default-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.equal(useSettingsStore.getState().dictationShowLatency, false);
});

test("the per-app formatting overrides start empty", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-app-profiles-default-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.deepEqual(useSettingsStore.getState().dictationAppProfiles, []);
});
