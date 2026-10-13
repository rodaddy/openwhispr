const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const requestedMainWindowPositions = [];
const createdBrowserWindows = [];
const screenListeners = [];
const builtMenus = [];

// Same stub set as windowManagerMeetingNotification.test.js: WindowManager
// pulls in electron + sibling managers at require time.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getPrimaryDisplay: () => ({}),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        on: (event, listener) => screenListeners.push({ event, listener }),
      },
      BrowserWindow: class FakeBrowserWindow {
        constructor(options) {
          this.options = options;
          this.protectionCalls = [];
          this.closeCalls = 0;
          this.setBoundsCalls = 0;
          this.visible = false;
          this.bounds = { x: 0, y: 0, width: 0, height: 0 };
          this.windowListeners = new Map();
          this.sent = [];
          this.webContentsListeners = new Map();
          this.webContents = {
            on: (event, listener) => this.webContentsListeners.set(event, listener),
            send: (channel, payload) => this.sent.push({ channel, payload }),
          };
          createdBrowserWindows.push(this);
        }
        on(event, listener) {
          this.windowListeners.set(event, listener);
        }
        setContentProtection(value) {
          this.protectionCalls.push(value);
        }
        setIgnoreMouseEvents() {}
        loadFile() {
          return Promise.resolve();
        }
        loadURL() {
          return Promise.resolve();
        }
        isDestroyed() {
          return false;
        }
        close() {
          this.closeCalls += 1;
          this.windowListeners.get("closed")?.();
        }
        getBounds() {
          return this.bounds;
        }
        setBounds(nextBounds) {
          this.bounds = nextBounds;
          this.setBoundsCalls += 1;
        }
        isVisible() {
          return this.visible;
        }
        showInactive() {
          this.visible = true;
        }
        hide() {
          this.visible = false;
        }
        moveTop() {}
      },
      Menu: {
        buildFromTemplate: (template) => {
          const menu = {
            popupCalls: [],
            popup(options) {
              this.popupCalls.push(options);
            },
          };
          builtMenus.push({ template, menu });
          return menu;
        },
      },
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger")
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
      isInListeningMode() {
        return false;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager")
    return class {
      cleanup() {}
      async startWindowDrag() {
        return { success: true };
      }
      async stopWindowDrag() {
        return { success: true };
      }
    };
  if (request === "./menuManager") return { setupMainMenu: () => undefined };
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      AUTO_END_NOTIFICATION_WINDOW_SIZE: { width: 620, height: 116 },
      getMeetingNotificationWindowSize: () => ({ width: 392, height: 92 }),
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: (_display, size, position) => {
          requestedMainWindowPositions.push(position);
          return { x: 0, y: 0, ...size };
        },
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (s) => s,
      fitAssistantContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      fitDictationErrorWindowToWorkArea: (s) => s,
      fitDictationErrorContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function fakeWindow({ visible }) {
  const calls = [];
  let isVisible = visible;
  return {
    calls,
    window: {
      isDestroyed: () => false,
      isVisible: () => isVisible,
      isMinimized: () => false,
      showInactive: () => {
        isVisible = true;
        calls.push("showInactive");
      },
      show: () => {
        isVisible = true;
        calls.push("show");
      },
      hide: () => {
        isVisible = false;
        calls.push("hide");
      },
      focus: () => calls.push("focus"),
      blur: () => calls.push("blur"),
      setFocusable: (value) => calls.push(`focusable:${value}`),
      setContentProtection: () => undefined,
      getBounds: () => ({ x: 0, y: 0, width: 96, height: 96 }),
    },
  };
}

function makeManager(windowState) {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  const fake = fakeWindow(windowState);
  manager.mainWindow = fake.window;
  manager.enforceMainWindowOnTop = () => undefined;
  manager._notifyMainWindowHorizontalDirection = () => undefined;
  manager.showAgentDictationPill = () => undefined;
  manager.hideAgentDictationPill = () => undefined;
  return { manager, calls: fake.calls };
}

test("the Assistant response context menu exposes native Copy only for selected text", () => {
  builtMenus.length = 0;
  const manager = new WindowManager();
  const listeners = new Map();
  manager.mainWindow = {
    webContents: { on: (event, listener) => listeners.set(event, listener) },
  };
  manager._assistantPanelOpen = true;
  manager.registerAssistantSelectionContextMenu();

  const onContextMenu = listeners.get("context-menu");
  assert.ok(onContextMenu);
  onContextMenu(null, { selectionText: "selected answer" });
  onContextMenu(null, { selectionText: "   " });

  assert.equal(builtMenus.length, 1);
  assert.deepEqual(builtMenus[0].template, [{ role: "copy" }]);
  assert.deepEqual(builtMenus[0].menu.popupCalls, [{ window: manager.mainWindow }]);

  manager._assistantPanelOpen = false;
  onContextMenu(null, { selectionText: "outside Assistant" });
  assert.equal(builtMenus.length, 1);
});

test("the Agent companion follows the edge opposite the panel", () => {
  requestedMainWindowPositions.length = 0;
  const manager = new WindowManager();
  const positions = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    setBounds: (bounds) => positions.push(bounds),
  };

  manager.positionAgentDictationPill();

  assert.deepEqual(positions, [{ x: 0, y: 0, width: 96, height: 96 }]);
  assert.deepEqual(requestedMainWindowPositions, ["bottom-left"]);
});

test("held, latched, and idle activation state reaches both renderer windows", () => {
  const manager = new WindowManager();
  const mainSent = [];
  const pillSent = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => mainSent.push({ channel, payload }) },
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => pillSent.push({ channel, payload }) },
  };
  manager._agentDictationPillReady = true;

  manager.setDictationActivationState("held");
  manager.setDictationActivationState("latched");
  manager.setDictationLifecycleState("idle");

  const activationPayloads = (sent) =>
    sent
      .filter(({ channel }) => channel === "dictation-activation-state-changed")
      .map(({ payload }) => payload);
  assert.deepEqual(activationPayloads(mainSent), ["held", "latched", "idle"]);
  assert.deepEqual(activationPayloads(pillSent), ["held", "latched", "idle"]);
});

test("the companion grows for Live Transcript and returns to its pill footprint", () => {
  const manager = new WindowManager();
  let bounds = { x: 0, y: 0, width: 96, height: 96 };
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    getBounds: () => bounds,
    setBounds: (nextBounds) => {
      bounds = nextBounds;
    },
  };

  const expanded = manager.resizeAgentDictationPillToContent(240);
  const collapsed = manager.resizeAgentDictationPillToContent(null);

  assert.equal(expanded.success, true);
  assert.deepEqual(expanded.bounds, { x: 0, y: 0, width: 466, height: 240 });
  assert.equal(collapsed.success, true);
  assert.deepEqual(collapsed.bounds, { x: 0, y: 0, width: 96, height: 96 });
});

test("the Agent companion ignores Agent voice lifecycle and mirrors plain dictation", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager.setDictationLifecycleState("recording", "assistant");
  manager.setDictationLifecycleState("recording", "dictation");

  assert.deepEqual(messages, [
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "idle", interactive: false, horizontalDirection: "left" },
    },
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "recording", interactive: true, horizontalDirection: "left" },
    },
  ]);
});

test("the companion receives live audio levels only for ordinary dictation", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._assistantPanelOpen = true;
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager.setDictationLifecycleState("recording", "dictation");
  messages.length = 0;
  manager.setDictationAudioLevel(0.42);
  manager.setDictationLifecycleState("recording", "assistant");
  manager.setDictationAudioLevel(0.9);

  assert.deepEqual(messages, [
    { channel: "agent-dictation-pill-audio-level-changed", payload: 0.42 },
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "idle", interactive: false, horizontalDirection: "left" },
    },
  ]);
});

test("the companion toggles macOS click-through with hover interactivity", () => {
  const manager = new WindowManager();
  const ignoreCalls = [];
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    setIgnoreMouseEvents: (ignore, opts) => ignoreCalls.push({ ignore, opts }),
  };

  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    manager.setAgentDictationPillInteractivity(true);
    manager.setAgentDictationPillInteractivity(false);
    // Windows/Linux keep normal hit-testing (forward is unreliable/ignored).
    Object.defineProperty(process, "platform", { value: "linux" });
    manager.setAgentDictationPillInteractivity(false);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }

  assert.deepEqual(ignoreCalls, [
    { ignore: false, opts: undefined },
    { ignore: true, opts: { forward: true } },
  ]);
});

test("the Agent companion window is capturable outside an internal screen-context capture", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();

  assert.equal(createdBrowserWindows.length, 1);
  assert.deepEqual(createdBrowserWindows[0].protectionCalls, [false]);
});

test("opening the Assistant panel leaves the main bubble capturable", () => {
  const manager = new WindowManager();
  const protectionCalls = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    setFocusable: () => undefined,
    // Windows/Linux focus the pill on open (windowManager.js); macOS does not.
    focus: () => undefined,
    setContentProtection: (value) => protectionCalls.push(value),
  };
  manager.enforceMainWindowOnTop = () => undefined;
  manager.showAgentDictationPill = () => undefined;

  manager.setAssistantPanelOpen(true);

  assert.deepEqual(protectionCalls, [false]);
});

test("internal screen-context capture protects and restores every bubble window", async () => {
  const manager = new WindowManager();
  const mainProtectionCalls = [];
  const companionProtectionCalls = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    setContentProtection: (value) => mainProtectionCalls.push(value),
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    setContentProtection: (value) => companionProtectionCalls.push(value),
  };

  const result = await manager.withScreenContextProtection(async () => "captured");

  assert.equal(result, "captured");
  assert.deepEqual(mainProtectionCalls, [true, false]);
  assert.deepEqual(companionProtectionCalls, [true, false]);
});

test("internal screen-context capture restores bubble capture after an error", async () => {
  const manager = new WindowManager();
  const protectionCalls = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    setContentProtection: (value) => protectionCalls.push(value),
  };

  await assert.rejects(
    manager.withScreenContextProtection(async () => {
      throw new Error("capture failed");
    }),
    /capture failed/
  );

  assert.deepEqual(protectionCalls, [true, false]);
});

test("overlapping screen-context captures stay protected until both settle", async () => {
  const manager = new WindowManager();
  const protectionCalls = [];
  const releases = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    setContentProtection: (value) => protectionCalls.push(value),
  };

  const captures = [0, 1].map(() =>
    manager.withScreenContextProtection(() => new Promise((resolve) => releases.push(resolve)))
  );
  assert.deepEqual(protectionCalls, [true]);

  releases[0]();
  await captures[0];
  assert.deepEqual(protectionCalls, [true]);

  releases[1]();
  await captures[1];
  assert.deepEqual(protectionCalls, [true, false]);
});

test("a companion window created during internal capture starts protected", async () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
    setContentProtection: () => undefined,
  };

  await manager.withScreenContextProtection(async () => manager.showAgentDictationPill());

  assert.equal(createdBrowserWindows.length, 1);
  assert.deepEqual(createdBrowserWindows[0].protectionCalls, [true, false]);
});

test("a main window recreated during internal capture stays protected until capture settles", async () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setMainWindowInteractivity = () => undefined;
  manager.registerMainWindowEvents = () => undefined;
  manager.registerAssistantSelectionContextMenu = () => undefined;
  manager.loadMainWindow = async () => undefined;
  manager.initializeHotkey = async () => undefined;
  manager.dragManager = { setTargetWindow: () => undefined };
  let releaseCapture;

  const capture = manager.withScreenContextProtection(
    () => new Promise((resolve) => (releaseCapture = resolve))
  );
  await manager.createMainWindow();

  assert.equal(createdBrowserWindows.length, 1);
  assert.deepEqual(createdBrowserWindows[0].protectionCalls, [true]);

  releaseCapture();
  await capture;
  assert.deepEqual(createdBrowserWindows[0].protectionCalls, [true, false]);
});

test("the companion cancel control routes through the dictation renderer", () => {
  const manager = new WindowManager();
  const channels = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => channels.push(channel) },
  };

  manager.sendCancelActiveDictation();

  assert.deepEqual(channels, ["cancel-dictation"]);
});

test("live transcript events are mirrored to the companion only for plain dictation", async () => {
  const manager = new WindowManager();
  const mainMessages = [];
  const companionMessages = [];
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager._agentDictationPillReady = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive: () => undefined,
    webContents: { send: (channel, payload) => mainMessages.push({ channel, payload }) },
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => companionMessages.push({ channel, payload }),
    },
  };
  manager.enforceMainWindowOnTop = () => undefined;

  manager._dictationInputKind = "assistant";
  await manager.showTranscriptionPreview("agent");
  manager._dictationInputKind = "dictation";
  await manager.showTranscriptionPreview("plain");

  assert.deepEqual(mainMessages, [
    { channel: "preview-text", payload: "agent" },
    { channel: "preview-text", payload: "plain" },
  ]);
  assert.deepEqual(companionMessages, [{ channel: "preview-text", payload: "plain" }]);
});

test("live transcript updates do not restack an already visible dictation window", async () => {
  const manager = new WindowManager();
  const calls = [];
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive: () => calls.push("showInactive"),
    webContents: { send: () => undefined },
  };
  manager.enforceMainWindowOnTop = () => calls.push("onTop");

  await manager.showTranscriptionPreview("one");
  await manager.showTranscriptionPreview("two");

  assert.deepEqual(calls, []);
});

test("the first live transcript update still surfaces a hidden dictation window", async () => {
  const manager = new WindowManager();
  const calls = [];
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => false,
    showInactive: () => calls.push("showInactive"),
    webContents: { send: () => undefined },
  };
  manager.enforceMainWindowOnTop = () => calls.push("onTop");

  await manager.showTranscriptionPreview("hello");

  assert.deepEqual(calls, ["showInactive", "onTop"]);
});

// Both platform paths run on every runner: branching the expectation on the
// host's own process.platform would leave whichever path CI is not running
// unverified — and darwin is the one that carries the contract.
function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("opening the assistant panel surfaces a hidden pill window without activating on macOS", () => {
  withPlatform("darwin", () => {
    const { manager, calls } = makeManager({ visible: false });
    manager.setAssistantPanelOpen(true);
    // focus() answers a user-granted activation with a whole-desktop Space
    // slide when another OpenWhispr window lives on a different Space. The
    // non-activating panel becomes key on click instead.
    assert.deepEqual(calls, ["showInactive", "focusable:true"]);
  });
});

test("opening the assistant panel focuses the pill window on Windows/Linux", () => {
  for (const platform of ["win32", "linux"]) {
    withPlatform(platform, () => {
      const { manager, calls } = makeManager({ visible: false });
      manager.setAssistantPanelOpen(true);
      assert.deepEqual(calls, ["showInactive", "focusable:true", "focus"], platform);
    });
  }
});

test("closing the assistant panel blurs only where opening focused", () => {
  withPlatform("darwin", () => {
    const { manager, calls } = makeManager({ visible: true });
    manager.setAssistantPanelOpen(false);
    // Nothing was activated, so blur() would only churn key-window state.
    assert.ok(!calls.includes("blur"), "macOS must not blur the overlay");
  });
  for (const platform of ["win32", "linux"]) {
    withPlatform(platform, () => {
      const { manager, calls } = makeManager({ visible: true });
      manager.setAssistantPanelOpen(false);
      assert.ok(calls.includes("blur"), `${platform} hands the foreground back`);
    });
  }
});

test("showDictationPanel still surfaces a hidden window while the panel is open", () => {
  const { manager, calls } = makeManager({ visible: false });
  // Panel open but the window got hidden afterwards (tray Hide raced the open).
  manager._assistantPanelOpen = true;
  manager.showDictationPanel({ focus: true });
  assert.deepEqual(calls, ["showInactive", "focus"]);
});

test("hideDictationPanel refuses while an assistant command is busy or the panel is open", () => {
  const { manager, calls } = makeManager({ visible: true });
  manager.setAssistantPanelBusy(true);
  manager.hideDictationPanel();
  assert.deepEqual(calls, [], "a thinking command must not lose its window");
  manager.setAssistantPanelBusy(false);
  manager.setAssistantPanelOpen(true);
  calls.length = 0;
  manager.hideDictationPanel();
  assert.deepEqual(calls, []);
  manager.setAssistantPanelOpen(false);
  calls.length = 0;
  manager.hideDictationPanel();
  assert.deepEqual(calls, ["hide"]);
});

test("compact onboarding exposes the complete window-control contract", () => {
  const manager = new WindowManager();
  const state = {};
  const win = {
    getBounds: () => ({ x: 0, y: 0, width: 480, height: 624 }),
    setResizable: (value) => {
      state.resizable = value;
    },
    setMinimizable: (value) => {
      state.minimizable = value;
    },
    setMaximizable: (value) => {
      state.maximizable = value;
    },
    setClosable: (value) => {
      state.closable = value;
    },
    setFullScreenable: (value) => {
      state.fullScreenable = value;
    },
    setMinimumSize: (width, height) => {
      state.minimumSize = { width, height };
    },
    setWindowButtonVisibility: () => undefined,
  };

  manager._applyOnboardingWindowChrome(win, "compact");

  assert.deepEqual(state, {
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    fullScreenable: false,
    minimumSize: { width: 480, height: 624 },
  });
});

test("compact macOS onboarding shows the native traffic lights", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  try {
    const manager = new WindowManager();
    let buttonsVisible = false;
    const win = {
      getBounds: () => ({ x: 0, y: 0, width: 480, height: 624 }),
      setResizable: () => undefined,
      setMinimizable: () => undefined,
      setMaximizable: () => undefined,
      setClosable: () => undefined,
      setFullScreenable: () => undefined,
      setMinimumSize: () => undefined,
      setWindowButtonVisibility: (visible) => {
        buttonsVisible = visible;
      },
    };

    manager._applyOnboardingWindowChrome(win, "compact");

    assert.equal(buttonsVisible, true);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("native Linux push-to-talk keeps only the dictation low-level listener", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  try {
    const manager = new WindowManager();
    let reconciledKeys = null;
    manager.mainWindow = { isDestroyed: () => false };
    manager.hotkeyManager = {
      setActivationMode: async () => true,
      isInListeningMode: () => false,
      isUsingNativeShortcut: () => true,
      getNativeListenerKeys: () => ["Control+Space", "Control+Shift+Space"],
      slotHasHotkey: (slot, key) => slot === "dictation" && key === "Control+Space",
    };
    await manager.setActivationModeCache("push");
    manager.linuxKeyManager = {
      setKeys: (keys) => {
        reconciledKeys = keys;
      },
    };

    manager.reconcileNativeKeyListeners();

    assert.deepEqual(reconciledKeys, ["Control+Space"]);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("a zero-movement click does not mark the pill as manually positioned", async () => {
  const { manager } = makeManager({ visible: true });
  await manager.startWindowDrag();
  await manager.stopWindowDrag();
  assert.equal(manager._mainWindowPlacementCoordinator._hasManualPosition, false);
});

test("a real drag marks the pill as manually positioned", async () => {
  const { manager } = makeManager({ visible: true });
  let bounds = { x: 0, y: 0, width: 96, height: 96 };
  manager.mainWindow.getBounds = () => bounds;
  await manager.startWindowDrag();
  bounds = { x: 120, y: 40, width: 96, height: 96 };
  await manager.stopWindowDrag();
  assert.equal(manager._mainWindowPlacementCoordinator._hasManualPosition, true);
});

test("did-finish-load marks the companion ready, pushes state, and shows it", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  assert.equal(manager._agentDictationPillReady, false);

  pill.webContentsListeners.get("did-finish-load")();

  assert.equal(manager._agentDictationPillReady, true);
  assert.deepEqual(pill.sent, [
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "idle", interactive: true, horizontalDirection: "left" },
    },
    { channel: "dictation-activation-state-changed", payload: "idle" },
  ]);
  assert.equal(pill.visible, true);
});

test("a crashed companion renderer drops readiness and closes for recreation", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(manager._agentDictationPillReady, true);

  pill.webContentsListeners.get("render-process-gone")(null, { reason: "crashed" });

  assert.equal(manager._agentDictationPillReady, false);
  assert.equal(pill.closeCalls, 1);
  assert.equal(manager.agentDictationPillWindow, null);
  assert.equal(manager._isAgentDictationPillAvailable(), false);
});

test("a clean-exit companion renderer teardown leaves readiness untouched", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(manager._agentDictationPillReady, true);

  pill.webContentsListeners.get("render-process-gone")(null, { reason: "clean-exit" });

  assert.equal(manager._agentDictationPillReady, true);
  assert.equal(pill.closeCalls, 0);
  assert.equal(manager.agentDictationPillWindow, pill);
});

test("prepare-dictation carries the toggle's input kind to the renderer", () => {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager.hotkeyManager = { isInListeningMode: () => false };
  const sent = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };

  manager.sendPrepareDictation({ inputKind: "assistant" });
  manager.sendPrepareDictation();

  assert.deepEqual(sent, [
    { channel: "prepare-dictation", payload: { inputKind: "assistant" } },
    { channel: "prepare-dictation", payload: { inputKind: "dictation" } },
  ]);
});

test("mic preparation reaches the companion as its own lifecycle", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager.setDictationLifecycleState("preparing", "dictation");

  assert.deepEqual(messages, [
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "preparing", interactive: true, horizontalDirection: "left" },
    },
  ]);
});

test("error-recovery transcripts mirror to the companion only for plain dictation", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._assistantPanelOpen = true;
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager._dictationInputKind = "assistant";
  manager.showAgentDictationFinalTranscript("agent");
  manager._dictationInputKind = "dictation";
  manager.showAgentDictationFinalTranscript("plain");

  assert.deepEqual(messages, [
    { channel: "agent-dictation-pill-final-transcript", payload: "plain" },
  ]);
});

test("display changes reposition the companion pill", () => {
  createdBrowserWindows.length = 0;
  screenListeners.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  pill.webContentsListeners.get("did-finish-load")();
  const boundsCallsBefore = pill.setBoundsCalls;

  const metricsListener = screenListeners.find(
    (entry) => entry.event === "display-metrics-changed"
  );
  assert.ok(metricsListener, "display-metrics-changed listener registered");
  metricsListener.listener();

  assert.equal(pill.setBoundsCalls, boundsCallsBefore + 1);
  assert.deepEqual(screenListeners.map((entry) => entry.event).sort(), [
    "display-added",
    "display-metrics-changed",
    "display-removed",
  ]);
});

test("onboarding suppresses the companion pill like every popup surface", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(true);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();

  assert.equal(createdBrowserWindows.length, 0);
});

test("a ready but hidden companion never counts as an available surface", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows.at(-1);
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(pill.isVisible(), true);
  assert.equal(manager._shouldBlockDictationInput("dictation"), false);

  // Onboarding hides the pill without dropping readiness; a hidden surface
  // cannot show a recording, so dictation must fail closed rather than start
  // invisibly.
  manager.hideAgentDictationPill();
  assert.equal(pill.isVisible(), false);
  assert.equal(manager._shouldBlockDictationInput("dictation"), true);
  // The blocked press re-kicks the show, so the next press can land.
  assert.equal(pill.isVisible(), true);
});

test("entering onboarding hides an already-visible companion pill", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
    // Entering onboarding cancels any in-flight dictation before it hides
    // the normal-app surfaces.
    webContents: { send: () => undefined },
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows.at(-1);
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(pill.isVisible(), true);

  manager.setOnboardingActive(true);

  assert.equal(pill.isVisible(), false);
});

function fakeControlPanel() {
  const sent = [];
  return {
    sent,
    window: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    },
    live: () =>
      sent
        .filter(({ channel }) => channel === "dictation-live-changed")
        .map(({ payload }) => payload),
  };
}

test("a held hotkey dictation reaches the control panel as live (#80)", () => {
  const manager = new WindowManager();
  const panel = fakeControlPanel();
  manager.controlPanelWindow = panel.window;

  manager.setDictationActivationState("held");
  manager.setDictationLifecycleState("recording");
  manager.setDictationLifecycleState("idle");

  assert.deepEqual(panel.live(), [true, false]);
  assert.equal(manager.getDictationLive(), false);
});

test("a tap-mode dictation, which sets no activation state, is live too (#80)", () => {
  const manager = new WindowManager();
  const panel = fakeControlPanel();
  manager.controlPanelWindow = panel.window;

  // Tap/toggle never calls setDictationActivationState; only the renderer's
  // confirmed lifecycle says a dictation is recording.
  manager.setDictationLifecycleState("recording");
  assert.equal(manager.getDictationActivationState(), "idle");
  assert.equal(manager.getDictationLive(), true);
  manager.setDictationLifecycleState("processing");
  manager.setDictationLifecycleState("idle");

  assert.deepEqual(panel.live(), [true, false]);
});

test("a hybrid stop tap within 400 ms of the recording start is consumed without a stop (#549)", (t) => {
  let monotonic = 1_000;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const manager = new WindowManager();
  manager._cachedActivationMode = "hybrid";
  let stops = 0;
  manager.sendStopDictation = () => {
    stops += 1;
  };

  assert.equal(manager.dictationActiveForMs(), Infinity, "idle has no start time");
  manager.setDictationLifecycleState("recording", "dictation");
  monotonic += 217;
  assert.equal(manager.dictationActiveForMs(), 217);
  assert.equal(manager._consumeHybridStopPress(), true, "the early tap is consumed");
  assert.equal(stops, 0, "and does not stop the take");

  // A lifecycle report for the same take does not restart the clock, and a
  // wall-clock step back does not move it.
  manager.setDictationLifecycleState("recording", "assistant");
  t.mock.timers.setTime(1_000_000 - 120_000);
  monotonic += 183;
  assert.equal(manager.dictationActiveForMs(), 400);
  assert.equal(manager._consumeHybridStopPress(), true);
  assert.equal(stops, 1, "a tap at 400 ms stops it");

  manager.setDictationLifecycleState("idle");
  assert.equal(manager.dictationActiveForMs(), Infinity);
});

test("a hybrid tap while the take is still preparing is not a second start (#549)", (t) => {
  let monotonic = 5_000;
  t.mock.method(performance, "now", () => monotonic);
  const manager = new WindowManager();
  manager._cachedActivationMode = "hybrid";
  let stops = 0;
  manager.sendStopDictation = () => {
    stops += 1;
  };

  // 2.0.22 log: the stop tap 475 ms after the press landed before "Recording
  // started" and ran as a duplicate start.
  manager.setDictationLifecycleState("preparing", "dictation");
  monotonic += 120;
  assert.equal(manager.dictationActiveForMs(), 120, "the clock starts at preparing");
  assert.equal(manager.isDictationTakeActive(), true);
  assert.equal(manager._consumeHybridStopPress(), true, "the early tap is consumed");
  assert.equal(stops, 0, "and stops nothing");

  // Reaching recording keeps the press-time clock.
  manager.setDictationLifecycleState("recording", "dictation");
  monotonic += 355;
  assert.equal(manager.dictationActiveForMs(), 475);
  assert.equal(manager._consumeHybridStopPress(), true);
  assert.equal(stops, 1, "a tap past 400 ms stops the take");

  // A take still preparing past 400 ms stops on the tap rather than restarting.
  manager.setDictationLifecycleState("idle");
  manager.setDictationLifecycleState("preparing", "dictation");
  monotonic += 500;
  assert.equal(manager._consumeHybridStopPress(), true);
  assert.equal(stops, 2);

  manager.setDictationLifecycleState("idle");
  assert.equal(manager.isDictationTakeActive(), false);
  assert.equal(manager.dictationActiveForMs(), Infinity);
});
