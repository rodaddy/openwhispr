const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

let target;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    sessionId: "test-session",
    _autoLearnEnabled: false,
    textEditMonitor: null,
    selectionManager: null,
    platform: process.platform,
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(handlers.get("paste-text"), "paste-text must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

test("paste-text reports an onboarding demo no-op without invoking the clipboard", async () => {
  let pasteCalls = 0;
  target.windowManager = { isOnboardingDemoActive: () => true };
  target.clipboardManager = {
    pasteText: async () => {
      pasteCalls += 1;
    },
  };

  const result = await handlers.get("paste-text")({ sender: {} }, "demo transcript");

  assert.deepEqual(result, {
    success: true,
    pasted: false,
    submitted: false,
    submitPlanned: false,
  });
  assert.equal(pasteCalls, 0);
});

test("paste-text reports pasted only after the clipboard paste completes", async () => {
  const pastes = [];
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async (text, options) => {
      pastes.push({ text, options });
    },
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "normal transcript");

  assert.deepEqual(result, { success: true, pasted: true, submitted: false, submitPlanned: false });
  assert.equal(pastes.length, 1);
});

test("paste-text preserves a clipboard-only fallback as not pasted", async () => {
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async () => ({ pasted: false }),
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "manual transcript", {
    allowClipboardFallback: true,
  });

  assert.deepEqual(result, {
    success: true,
    pasted: false,
    submitted: false,
    submitPlanned: false,
  });
});

test("paste-text does not schedule AutoLearn monitoring after a clipboard-only fallback", async (t) => {
  const originalSetTimeout = global.setTimeout;
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    target._autoLearnEnabled = false;
    target.textEditMonitor = null;
  });
  global.setTimeout = (callback) => {
    callback();
    return 1;
  };
  const monitored = [];
  target._autoLearnEnabled = true;
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: (...args) => monitored.push(args),
  };
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async () => ({ pasted: false }),
  };

  const result = await handlers.get("paste-text")({ sender: { id: 1 } }, "manual transcript", {
    allowClipboardFallback: true,
  });

  assert.deepEqual(result, {
    success: true,
    pasted: false,
    submitted: false,
    submitPlanned: false,
  });
  assert.deepEqual(monitored, []);
});

// #629: the handler formats a plain dictation for its target app. Only macOS
// resolves a target in this slice, so every other platform must paste the
// text exactly as it arrived.
test("paste-text formats for the target app, strips appFormatting and monitors what it pasted", async (t) => {
  const originalSetTimeout = global.setTimeout;
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    target._autoLearnEnabled = false;
    target.textEditMonitor = null;
    target.selectionManager = null;
  });
  global.setTimeout = (callback) => {
    callback();
    return 1;
  };
  const pastes = [];
  const monitored = [];
  const reads = [];
  target._autoLearnEnabled = true;
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: (...args) => monitored.push(args),
  };
  target.selectionManager = {
    _readExecutablePath: async (pid) => {
      reads.push(pid);
      return "/Applications/iTerm.app/Contents/MacOS/iTerm2";
    },
  };
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    // The real classifier calls anything containing "st" a terminal. The
    // handler must not ask it.
    isTerminalSignature: () => {
      throw new Error("the substring terminal classifier must not be consulted");
    },
    pasteText: async (text, options) => {
      pastes.push({ text, options });
    },
  };
  const paste = handlers.get("paste-text");
  const formatted = "Run npm test";
  target.platform = "darwin";
  try {
    await paste({ sender: { id: 1 } }, "Run npm test.", {
      appFormatting: true,
      restoreClipboard: true,
    });
    assert.equal(pastes[0].text, formatted + " ");
    assert.equal("appFormatting" in pastes[0].options, false);
    assert.equal(pastes[0].options.restoreClipboard, true);
    assert.equal(monitored[0][0], formatted);
    assert.deepEqual(reads, [42]);

    // Not asked for: the same text is pasted untouched and no lookup runs.
    await paste({ sender: { id: 1 } }, "Run npm test.", { restoreClipboard: true });
    assert.equal(pastes[1].text, "Run npm test. ");
    await paste({ sender: { id: 1 } }, "Run npm test.");
    assert.equal(pastes[2].text, "Run npm test. ");
    assert.equal(reads.length, 1);
  } finally {
    target.platform = process.platform;
  }
});

// The platform gate: off macOS no target is resolved, so the text is pasted
// exactly as it arrived and the target app is never looked up.
test("paste-text leaves the text alone and reads no target app off macOS", async (t) => {
  t.after(() => {
    target.textEditMonitor = null;
    target.selectionManager = null;
  });
  const pastes = [];
  const reads = [];
  target._autoLearnEnabled = false;
  target.textEditMonitor = { lastTargetPid: 42, activateTargetPid: async () => true };
  target.selectionManager = {
    _readExecutablePath: async (pid) => {
      reads.push(pid);
      return "/Applications/iTerm.app/Contents/MacOS/iTerm2";
    },
  };
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async (text, options) => {
      pastes.push({ text, options });
    },
  };
  target.platform = "linux";
  try {
    await handlers.get("paste-text")({ sender: { id: 1 } }, "Run npm test.", {
      appFormatting: true,
    });
    assert.equal(pastes[0].text, "Run npm test. ");
    assert.deepEqual(reads, []);
  } finally {
    target.platform = process.platform;
  }
});

// #629: a stored override list is consulted before the built-in app list.
test(
  "paste-text lets an app override pick the profile, ignores a malformed list and does not forward it",
  { skip: process.platform === "darwin" ? false : "a formatting target is resolved on macOS only" },
  async (t) => {
    t.after(() => {
      target.textEditMonitor = null;
      target.selectionManager = null;
    });
    const pastes = [];
    target._autoLearnEnabled = false;
    target.textEditMonitor = { lastTargetPid: 42, activateTargetPid: async () => true };
    target.selectionManager = {
      _readExecutablePath: async () => "/System/Applications/Notes.app/Contents/MacOS/Notes",
    };
    target.windowManager = { isOnboardingDemoActive: () => false };
    target.clipboardManager = {
      pasteText: async (text, options) => {
        pastes.push({ text, options });
      },
    };
    const paste = (options) =>
      handlers.get("paste-text")({ sender: { id: 1 } }, "Git status.", options);

    await paste({ appFormatting: true, appProfiles: [{ match: "notes", profile: "terminal" }] });
    assert.equal(pastes[0].text, "git status ");
    assert.equal("appProfiles" in pastes[0].options, false);

    await paste({ appFormatting: true, appProfiles: "notes" });
    assert.equal(pastes[1].text, "Git status. ");
  }
);

// #634: paste-last repeats the last dictation, which is recorded by its own
// call: no paste can overwrite it, and it is recorded with auto-paste off.
test("remember-last-dictation alone records the last dictation, and not during an onboarding demo", async () => {
  const IPCHandlers = require(handlersModulePath);
  const lastDictation = () =>
    (IPCHandlers.default || IPCHandlers).prototype.getLastDictationText.call(target);
  const remember = (text) => handlers.get("remember-last-dictation")({ sender: { id: 1 } }, text);
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = { pasteText: async () => {} };

  assert.deepEqual(await remember("Run npm test."), { success: true });
  assert.equal(lastDictation(), "Run npm test.");

  await handlers.get("paste-text")({ sender: { id: 1 } }, "Text nobody dictated.");
  assert.equal(lastDictation(), "Run npm test.");

  target.windowManager = { isOnboardingDemoActive: () => true };
  assert.deepEqual(await remember("Demo sentence."), { success: true });
  assert.equal(lastDictation(), "Run npm test.");
});

// #634: auto-submit presses Return after a dictation pasted into a terminal.
// A wrong Return runs a command, so each guard is pinned here. Only macOS
// submits in this slice. The handler plans the submit and hands the clipboard
// one `pasteKeystroke` that pastes and presses Return in the target process;
// this fake clipboard reports its outcome the way pasteMacOS does.
function autoSubmitHarness(t, overrides = {}) {
  const {
    executablePath = "/Applications/iTerm.app/Contents/MacOS/iTerm2",
    targetPid = 42,
    targetWindow = 7,
    bundleId = "com.googlecode.iterm2",
    activated = true,
    outcome = "submitted",
  } = overrides;
  t.after(() => {
    target.textEditMonitor = null;
    target.selectionManager = null;
  });
  const calls = { pastes: [], keystrokes: [], captureWindow: [] };
  target._autoLearnEnabled = false;
  target.textEditMonitor = {
    lastTargetPid: targetPid,
    lastTargetWindow: targetWindow,
    lastTargetBundleId: bundleId,
    activateTargetPid: async () => activated,
    setCaptureTargetWindow: (enabled) => calls.captureWindow.push(enabled),
    pasteAndReturnForPid: async (...args) => {
      calls.keystrokes.push(args);
      return outcome;
    },
  };
  target.selectionManager = { _readExecutablePath: async () => executablePath };
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async (text, options) => {
      calls.pastes.push({ text, options });
      if (typeof options?.pasteKeystroke !== "function") return undefined;
      const keystrokeOutcome = await options.pasteKeystroke();
      return keystrokeOutcome === "failed"
        ? { pasted: false, keystrokeOutcome }
        : { keystrokeOutcome };
    },
  };
  return calls;
}

const autoSubmitSkip = process.platform === "darwin" ? false : "auto-submit is macOS-only";
const TEXT = "run the npm tests";

const pasteRequest = (text, options) =>
  handlers.get("paste-text")({ sender: { id: 1 } }, text, options);
const submitRequest = (text = TEXT, options = {}) =>
  pasteRequest(text, { autoSubmit: true, ...options });

function assertNotPlanned(calls, result) {
  assert.deepEqual(result, { success: true, pasted: true, submitted: false, submitPlanned: false });
  assert.equal(calls.pastes.length, 1);
  assert.equal("pasteKeystroke" in calls.pastes[0].options, false);
  assert.deepEqual(calls.keystrokes, []);
}

// [the helper's answer, pasted, submitted]
for (const [outcome, pasted, submitted] of [
  ["submitted", true, true],
  ["pasted", true, false],
  ["skipped", true, false],
  ["failed", false, false],
]) {
  test(
    `auto-submit makes one helper call and reports its answer "${outcome}"`,
    { skip: autoSubmitSkip },
    async (t) => {
      const calls = autoSubmitHarness(t, { outcome });
      const result = await submitRequest(TEXT, { autoSubmitMinWords: 3, restoreClipboard: true });

      assert.deepEqual(result, { success: true, pasted, submitted, submitPlanned: true });
      assert.deepEqual(calls.keystrokes, [[42, 7]], "one call, for this pid and window");
      assert.deepEqual(calls.captureWindow, [true]);
      assert.equal(calls.pastes.length, 1);
      const { options } = calls.pastes[0];
      assert.equal("autoSubmit" in options, false);
      assert.equal("autoSubmitMinWords" in options, false);
      assert.equal(typeof options.pasteKeystroke, "function");
      assert.equal(options.restoreClipboard, true);
      assert.equal(options.targetActivated, true);
    }
  );
}

// [why no submit is planned, harness overrides, text, request options]
const NOT_PLANNED = [
  ...[null, 0, -1, 1.5, "7"].map((targetWindow) => [
    `without a captured window number (${JSON.stringify(targetWindow)})`,
    { targetWindow },
  ]),
  [
    "without a captured target pid",
    { targetPid: null },
    "run the tests",
    { autoSubmit: true, autoSubmitMinWords: 3 },
  ],
  [
    "for a prose target",
    {
      executablePath: "/Applications/TextEdit.app/Contents/MacOS/TextEdit",
      bundleId: "com.apple.TextEdit",
    },
  ],
  // #658: the name matches the terminal formatting profile, the bundle id is not a terminal's.
  [
    "for an app only named like a terminal",
    {
      executablePath: "/Applications/Terminal Notes.app/Contents/MacOS/Terminal Notes",
      bundleId: "com.example.TerminalNotes",
    },
  ],
  ["below the word floor", {}, "npm test"],
  ["when the target was not confirmed frontmost", { activated: false }],
  ["for text with a line break in it", {}, `${TEXT}\nrm -rf build`],
  ["without autoSubmit", {}, TEXT, { appFormatting: true, autoSubmitMinWords: 3 }],
];

for (const [name, overrides, text = TEXT, options] of NOT_PLANNED) {
  test(`auto-submit is not planned ${name}`, { skip: autoSubmitSkip }, async (t) => {
    const calls = autoSubmitHarness(t, overrides);
    const request = options ?? { autoSubmit: true };

    assertNotPlanned(calls, await pasteRequest(text, request));
    assert.equal("autoSubmitMinWords" in calls.pastes[0].options, false);
    assert.deepEqual(calls.captureWindow, [request.autoSubmit === true]);
  });
}

// #658: a Return the helper withheld leaves the text on the line, and the
// renderer can only tell the user when it knows a Return was planned.
test(
  "a withheld Return reports submitPlanned, and auto-submit off reports it false",
  { skip: autoSubmitSkip },
  async (t) => {
    autoSubmitHarness(t, { outcome: "pasted" });
    assert.deepEqual(await submitRequest(), {
      success: true,
      pasted: true,
      submitted: false,
      submitPlanned: true,
    });

    autoSubmitHarness(t, { outcome: "pasted" });
    assert.deepEqual(await pasteRequest(TEXT, {}), {
      success: true,
      pasted: true,
      submitted: false,
      submitPlanned: false,
    });
  }
);

test("auto-submit honors a lowered autoSubmitMinWords", { skip: autoSubmitSkip }, async (t) => {
  const lowered = autoSubmitHarness(t);
  const result = await submitRequest("npm test", { autoSubmitMinWords: 2 });
  assert.equal(result.submitted, true);
  assert.deepEqual(lowered.keystrokes, [[42, 7]]);
});

test(
  "auto-submit pastes the formatted text, and the unformatted text without appFormatting",
  { skip: autoSubmitSkip },
  async (t) => {
    const formatted = autoSubmitHarness(t);
    const formattedResult = await submitRequest("Run npm test.", { appFormatting: true });
    assert.equal(formatted.pastes[0].text, "Run npm test ");
    assert.equal("appFormatting" in formatted.pastes[0].options, false);
    assert.deepEqual(formattedResult, {
      success: true,
      pasted: true,
      submitted: true,
      submitPlanned: true,
    });
    assert.deepEqual(formatted.keystrokes, [[42, 7]]);

    const plain = autoSubmitHarness(t);
    const plainResult = await submitRequest("Run npm test.");
    assert.equal(plain.pastes[0].text, "Run npm test. ");
    assert.deepEqual(plainResult, {
      success: true,
      pasted: true,
      submitted: true,
      submitPlanned: true,
    });
    assert.deepEqual(plain.keystrokes, [[42, 7]]);
  }
);

test(
  "auto-submit is never planned off macOS",
  { skip: process.platform === "darwin" ? "covers the other platforms" : false },
  async (t) => {
    const calls = autoSubmitHarness(t);
    assertNotPlanned(calls, await submitRequest());
  }
);
