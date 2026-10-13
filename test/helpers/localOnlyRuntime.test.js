const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("managed OpenWhispr inference is absent from the runtime registry", async (t) => {
  installBrowserGlobals(t, { initialStorage: { _providerSettingsMigrated: "1" } });
  const vite = await createRendererServer(t, { cachePrefix: "local-only-provider-registry-" });
  const { PROVIDER_REGISTRY } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/index.ts"
  );

  assert.equal(PROVIDER_REGISTRY.openwhispr, undefined);
  assert.ok(PROVIDER_REGISTRY.local);
  assert.ok(PROVIDER_REGISTRY.openai);
  assert.ok(PROVIDER_REGISTRY.custom);
  assert.ok(PROVIDER_REGISTRY.lan);
});

test("persisted managed selections normalize to local routes before store construction", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      transcriptionMode: "openwhispr",
      cloudTranscriptionMode: "openwhispr",
      cleanupMode: "openwhispr",
      cleanupCloudMode: "openwhispr",
      chatAgentMode: "openwhispr",
      chatAgentCloudMode: "openwhispr",
      dictationAgentMode: "openwhispr",
      dictationAgentCloudMode: "openwhispr",
      translationMode: "openwhispr",
      translationCloudMode: "openwhispr",
      uploadTranscriptionMode: "openwhispr",
      uploadCloudTranscriptionMode: "openwhispr",
      noteFormattingMode: "openwhispr",
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "local-only-settings-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();

  for (const key of [
    "transcriptionMode",
    "cleanupMode",
    "chatAgentMode",
    "dictationAgentMode",
    "translationMode",
    "uploadTranscriptionMode",
    "noteFormattingMode",
  ]) {
    assert.equal(state[key], "local", key);
    assert.equal(storage.getItem(key), "local", `${key} persisted`);
  }
  assert.equal(state.useLocalWhisper, true);
  assert.equal(storage.getItem("useLocalWhisper"), "true");
});

test("already-migrated managed upload settings normalize mode and execution together", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      uploadTranscriptionMode: "openwhispr",
      uploadUseLocalWhisper: "false",
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "local-only-upload-migrated-" });
  const { selectResolvedUploadTranscription, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const selection = selectResolvedUploadTranscription(useSettingsStore.getState());

  assert.equal(selection.transcriptionMode, "local");
  assert.equal(selection.useLocalWhisper, true);
  assert.equal(storage.getItem("uploadTranscriptionMode"), "local");
  assert.equal(storage.getItem("uploadUseLocalWhisper"), "true");
});

test("explicit BYOK upload settings remain remote", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      uploadTranscriptionMode: "providers",
      uploadUseLocalWhisper: "false",
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "local-only-upload-byok-" });
  const { selectResolvedUploadTranscription, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const selection = selectResolvedUploadTranscription(useSettingsStore.getState());

  assert.equal(selection.transcriptionMode, "providers");
  assert.equal(selection.useLocalWhisper, false);
});

test("auth compatibility hook is permanently loaded and signed out", async (t) => {
  installBrowserGlobals(t, { initialStorage: { isSignedIn: "true" } });
  const vite = await createRendererServer(t, { cachePrefix: "local-only-auth-" });
  const source = await vite.ssrLoadModule("/hooks/useAuth.ts");

  assert.deepEqual(source.LOCAL_ONLY_AUTH_STATE, {
    isSignedIn: false,
    isGracePeriodOnly: false,
    isLoaded: true,
    session: null,
    user: null,
  });
});
