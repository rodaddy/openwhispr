const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    globalThis.__clipboardPersistenceAudioManager = this;
  }
  getState() {
    return globalThis.__clipboardPersistenceManagerState ?? {};
  }
  stopRecording() {
    return true;
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  complete(result) {
    return this.callbacks.onTranscriptionComplete(result);
  }
  saveTranscription(...args) {
    return globalThis.__saveClipboardPersistenceTranscription(...args);
  }
  async safePaste(text, options) {
    globalThis.__clipboardPersistencePastes.push({ text, options });
    this.lastPasteOutcome = globalThis.__clipboardPersistencePasteOutcome ?? null;
    return globalThis.__clipboardPersistencePasteSucceeds !== false;
  }
  shouldUseStreaming() {
    return false;
  }
  cleanup() {}
}
`;

const SETTINGS_STORE_SOURCE = `
export const getSettings = () => globalThis.__clipboardPersistenceSettings;
`;

const POLICY_STORE_SOURCE = `
export const usePolicyStore = {
  getState: () => ({}),
  subscribe: () => () => {},
};
`;

const LOGGER_SOURCE = `
const record = (level, message, meta, scope) => {
  globalThis.__clipboardPersistenceLogs.push({ level, message, meta, scope });
};
export default {
  trace: (message, meta, scope) => record("trace", message, meta, scope),
  debug: (message, meta, scope) => record("debug", message, meta, scope),
  info: (message, meta, scope) => record("info", message, meta, scope),
  warn: (message, meta, scope) => record("warn", message, meta, scope),
  error: (message, meta, scope) => record("error", message, meta, scope),
  fatal: (message, meta, scope) => record("fatal", message, meta, scope),
  logReasoning: (message, meta) => record("debug", message, meta, "reasoning"),
};
`;

const TRANSLATION_SOURCE = `
const translate = (key) => key;
export const useTranslation = () => ({ t: translate });
`;

const NOOP = () => {};

async function mountCompletionHarness(
  t,
  {
    settings,
    writeClipboard = async () => ({ success: true }),
    replaceSelectedText = async () => ({ success: true }),
    saveTranscription = async () => true,
    pasteSucceeds = true,
    pasteOutcome = null,
  }
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const navigatorWrites = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        async writeText(text) {
          navigatorWrites.push(text);
          throw new Error("renderer clipboard should not be used");
        },
      },
    },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });

  const bridgeWrites = [];
  const remembered = [];
  const saves = [];
  let savesResolved = 0;
  const latencyRecords = [];
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
        dictationLifecycleStateChanged: NOOP,
        completeDictationPreview: NOOP,
        hideDictationPreview: NOOP,
        setScreenContextEnabled: NOOP,
        async writeClipboard(text) {
          bridgeWrites.push(text);
          return writeClipboard(text);
        },
        replaceSelectedText,
        async rememberLastDictation(text) {
          remembered.push(text);
          return { success: true };
        },
        async recordDictationLatency(input) {
          latencyRecords.push({ input, savesResolved });
          return { success: true, updated: true };
        },
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__clipboardPersistenceSettings = {
    autoPasteEnabled: false,
    keepTranscriptionInClipboard: true,
    showTranscriptionPreview: false,
    snippets: [],
    useLocalWhisper: false,
    pauseMediaOnDictation: false,
    voiceAgentScreenContext: false,
    ...settings,
  };
  globalThis.__clipboardPersistenceLogs = [];
  globalThis.__clipboardPersistencePastes = [];
  globalThis.__clipboardPersistencePasteSucceeds = pasteSucceeds;
  globalThis.__clipboardPersistencePasteOutcome = pasteOutcome;
  globalThis.__clipboardPersistenceManagerState = {};
  globalThis.__saveClipboardPersistenceTranscription = async (...args) => {
    saves.push(args);
    const persisted = await saveTranscription(...args);
    savesResolved += 1;
    return persisted;
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-clipboard-persistence-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/stores/settingsStore": SETTINGS_STORE_SOURCE,
      "/stores/policyStore": POLICY_STORE_SOURCE,
      "/utils/logger": LOGGER_SOURCE,
      "react-i18next": TRANSLATION_SOURCE,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const toasts = [];
  let hook = null;
  function Harness() {
    hook = useAudioRecording((toast) => toasts.push(toast), { onDemoEvent: NOOP });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  return {
    bridgeWrites,
    complete: async (result) => {
      await React.act(async () => {
        await globalThis.__clipboardPersistenceAudioManager.complete(result);
      });
    },
    // Releases the hotkey on a live take. The second stop ends the release
    // tail at once, as a second press does.
    release: async () => {
      globalThis.__clipboardPersistenceManagerState = { isRecording: true };
      await React.act(async () => {
        const stopped = hook.stopRecording();
        void hook.stopRecording();
        await stopped;
      });
      globalThis.__clipboardPersistenceManagerState = {};
    },
    // A stop with no live take: the manager is already transcribing.
    stopNothing: async () => {
      let stopped;
      await React.act(async () => {
        stopped = await hook.stopRecording();
      });
      return stopped;
    },
    toasts,
    readout: () => hook.latencyReadout,
    latencyRecords,
    logs: globalThis.__clipboardPersistenceLogs,
    navigatorWrites,
    pastes: globalThis.__clipboardPersistencePastes,
    remembered,
    saves,
  };
}

test("clipboard-only rejection cannot cancel non-preview transcription persistence", async (t) => {
  const harness = await mountCompletionHarness(t, {
    writeClipboard: async () => {
      throw new Error("main-process clipboard rejected");
    },
  });

  await harness.complete({
    success: true,
    text: "Final non-preview text",
    rawText: "Raw non-preview text",
    clientTranscriptionId: "client-non-preview",
    source: "openai",
  });

  assert.deepEqual(harness.saves, [
    [
      "Final non-preview text",
      "Raw non-preview text",
      { clientTranscriptionId: "client-non-preview" },
    ],
  ]);
  assert.ok(
    harness.logs.some(
      ({ level, message, meta, scope }) =>
        level === "warn" &&
        message === "Failed to keep transcription in clipboard" &&
        meta.delivery === "clipboard-only" &&
        scope === "clipboard"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("clipboard-only unsuccessful bridge response is logged without cancelling persistence", async (t) => {
  const harness = await mountCompletionHarness(t, {
    writeClipboard: async () => ({ success: false }),
  });

  await harness.complete({
    success: true,
    text: "Text with an unsuccessful clipboard response",
    rawText: "Raw text with an unsuccessful clipboard response",
    clientTranscriptionId: "client-clipboard-unsuccessful",
    source: "openai",
  });

  assert.deepEqual(harness.saves, [
    [
      "Text with an unsuccessful clipboard response",
      "Raw text with an unsuccessful clipboard response",
      { clientTranscriptionId: "client-clipboard-unsuccessful" },
    ],
  ]);
  assert.ok(
    harness.logs.some(
      ({ level, message, meta, scope }) =>
        level === "warn" &&
        message === "Failed to keep transcription in clipboard" &&
        meta.delivery === "clipboard-only" &&
        scope === "clipboard"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("clipboard-only delivery uses the main-process bridge for a streaming-capable result", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { showTranscriptionPreview: true },
  });

  await harness.complete({
    success: true,
    text: "Final streaming text",
    rawText: "Raw streaming text",
    clientTranscriptionId: "client-streaming",
    source: "deepgram-streaming",
  });

  assert.deepEqual(harness.bridgeWrites, ["Final streaming text"]);
  assert.deepEqual(harness.saves, [
    ["Final streaming text", "Raw streaming text", { clientTranscriptionId: "client-streaming" }],
  ]);
  assert.deepEqual(harness.navigatorWrites, []);
});

test("failed selection-edit clipboard rejection cannot cancel persistence", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true },
    replaceSelectedText: async () => ({ success: false, code: "paste_failed" }),
    writeClipboard: async () => {
      throw new Error("main-process clipboard rejected");
    },
  });

  await harness.complete({
    success: true,
    text: "Edited selection text",
    rawText: "Raw selection instruction",
    clientTranscriptionId: "client-selection",
    source: "openai",
    selectionEdit: { sessionId: "selection-session" },
  });

  assert.deepEqual(harness.bridgeWrites, ["Edited selection text"]);
  assert.deepEqual(harness.saves, [
    [
      "Edited selection text",
      "Raw selection instruction",
      { clientTranscriptionId: "client-selection" },
    ],
  ]);
  assert.ok(
    harness.logs.some(
      ({ level, message, meta, scope }) =>
        level === "warn" &&
        message === "Failed to keep transcription in clipboard" &&
        meta.delivery === "selection-edit-fallback" &&
        scope === "clipboard"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("a false persistence result is logged instead of silently ignored", async (t) => {
  const harness = await mountCompletionHarness(t, {
    saveTranscription: async () => false,
  });

  await harness.complete({
    success: true,
    text: "Text with a storage failure",
    rawText: "Raw text with a storage failure",
    clientTranscriptionId: "client-storage-failure",
    source: "openai",
  });

  assert.equal(harness.saves.length, 1);
  assert.ok(
    harness.logs.some(
      ({ level, message, scope }) =>
        level === "error" && message === "Failed to persist transcription" && scope === "audio"
    )
  );
  assert.deepEqual(harness.navigatorWrites, []);
});

test("the Insights timestamp rides along on the persistence call", async (t) => {
  // Persistence moved ahead of the paste so history survives a failed
  // clipboard delivery (#1979). The analytics timestamp has to travel with it:
  // recordAnalyticsEvent reads it from these options, and losing it here would
  // silently backdate every counter to the write time instead of the moment
  // the recording started.
  const harness = await mountCompletionHarness(t, {});

  await harness.complete({
    success: true,
    text: "Final text",
    rawText: "Raw text",
    clientTranscriptionId: "client-analytics",
    analyticsOccurredAt: "2026-09-04T09:00:00.000Z",
    source: "openai",
  });

  assert.deepEqual(harness.saves, [
    [
      "Final text",
      "Raw text",
      {
        clientTranscriptionId: "client-analytics",
        analyticsOccurredAt: "2026-09-04T09:00:00.000Z",
      },
    ],
  ]);
});

test("a normal dictation paste carries the auto-submit setting and its word floor", async (t) => {
  const result = { success: true, text: "run the test suite", source: "openai" };
  const harness = await mountCompletionHarness(t, {
    settings: {
      autoPasteEnabled: true,
      dictationAutoSubmit: true,
      dictationAutoSubmitMinWords: 5,
    },
  });

  await harness.complete(result);
  globalThis.__clipboardPersistenceSettings.dictationAutoSubmit = false;
  await harness.complete(result);

  assert.deepEqual(
    harness.pastes.map(({ options }) => [options.autoSubmit, options.autoSubmitMinWords]),
    [
      [true, 5],
      [false, 5],
    ]
  );
});

test("a dictation is remembered for paste-last with auto-paste off, as the clipboard keeps it", async (t) => {
  const harness = await mountCompletionHarness(t, { settings: { autoPasteEnabled: false } });

  await harness.complete({
    success: true,
    text: "Final text",
    rawText: "Raw text",
    source: "openai",
  });

  assert.deepEqual(harness.remembered, ["Final text"]);
  assert.deepEqual(harness.pastes, []);
});

const LATENCY_TITLE = / ms$/;
const dictation = { success: true, text: "run the test suite", source: "openai" };

test("a pasted dictation's release-to-pasted time is the hook's readout, with no toast", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true, dictationShowLatency: true },
  });

  await harness.release();
  await harness.complete(dictation);

  const readout = harness.readout();
  assert.ok(Number.isInteger(readout.lastMs));
  assert.equal(readout.lastMs, harness.latencyRecords[0].input.latencyMs);
  assert.equal(readout.sampleCount, 1);
  assert.deepEqual(
    harness.toasts.filter(({ title }) => LATENCY_TITLE.test(title)),
    []
  );
});

test("a second stop while a take is transcribed keeps its latency readout", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true, dictationShowLatency: true },
  });

  await harness.release();
  assert.equal(await harness.stopNothing(), false);
  await harness.complete(dictation);

  assert.ok(Number.isInteger(harness.readout().lastMs));
});

test("a failed paste leaves the latency readout empty", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true, dictationShowLatency: true },
    pasteSucceeds: false,
  });

  await harness.release();
  await harness.complete(dictation);

  assert.deepEqual(harness.pastes.length, 1);
  assert.equal(harness.readout(), null);
});

test("a pasted dictation's latency is stored on its Insights row once the save has resolved", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true },
    // Slower than the paste: a record sent before the save would see 0 saves.
    saveTranscription: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    },
  });

  await harness.release();
  await harness.complete({ ...dictation, clientTranscriptionId: "client-latency" });

  assert.equal(harness.latencyRecords.length, 1);
  const [{ input, savesResolved }] = harness.latencyRecords;
  assert.equal(input.eventId, "client-latency");
  assert.ok(Number.isInteger(input.latencyMs));
  assert.equal(savesResolved, 1);
});

// Local and BYOK results arrive with no id: the save and the latency must
// still name the same Insights row.
test("a dictation with no id of its own is saved and timed under one id", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true },
  });

  await harness.release();
  await harness.complete(dictation);

  assert.equal(harness.latencyRecords.length, 1);
  const { eventId } = harness.latencyRecords[0].input;
  assert.ok(typeof eventId === "string" && eventId.length > 0);
  assert.equal(harness.saves[0][2].clientTranscriptionId, eventId);
});

test("a failed paste stores no latency", async (t) => {
  const harness = await mountCompletionHarness(t, {
    settings: { autoPasteEnabled: true },
    pasteSucceeds: false,
  });

  await harness.release();
  await harness.complete({ ...dictation, clientTranscriptionId: "client-latency" });

  assert.equal(harness.pastes.length, 1);
  assert.deepEqual(harness.latencyRecords, []);
});

// #658: a planned Return that was withheld leaves the text on the command
// line; the next auto-submitted dictation would send both.
const WITHHELD_TITLE = "hooks.audioRecording.autoSubmit.withheldTitle";

for (const [name, outcome, expected] of [
  [
    "a withheld Return shows the text-on-the-line toast",
    { submitted: false, submitPlanned: true },
    1,
  ],
  ["a sent Return shows no withheld toast", { submitted: true, submitPlanned: true }, 0],
  ["no planned Return shows no withheld toast", { submitted: false, submitPlanned: false }, 0],
]) {
  test(name, async (t) => {
    const harness = await mountCompletionHarness(t, {
      settings: { autoPasteEnabled: true, dictationAutoSubmit: true },
      pasteOutcome: { pasted: true, ...outcome },
    });

    await harness.complete(dictation);

    const shown = harness.toasts.filter(({ title }) => title === WITHHELD_TITLE);
    assert.equal(shown.length, expected);
    if (expected) assert.equal(shown[0].duration, 4000);
  });
}
