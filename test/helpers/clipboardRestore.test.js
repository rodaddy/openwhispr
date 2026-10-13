const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const fakeClipboard = {
  text: "",
  html: "",
  rtf: "",
  image: null,
  formats: ["text/plain"],
  writes: [],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
    this.html = "";
    this.rtf = "";
    this.image = null;
    this.formats = ["text/plain"];
    this.writes.push(["writeText", text]);
  },
  readHTML() {
    return this.html;
  },
  readRTF() {
    return this.rtf;
  },
  write(payload) {
    this.text = payload.text || "";
    this.html = payload.html || "";
    this.rtf = payload.rtf || "";
    this.image = payload.image || null;
    this.formats = [];
    if (Object.hasOwn(payload, "text")) this.formats.push("text/plain");
    if (Object.hasOwn(payload, "html")) this.formats.push("text/html");
    if (Object.hasOwn(payload, "rtf")) this.formats.push("text/rtf");
    if (Object.hasOwn(payload, "image")) this.formats.push("image/png");
    this.writes.push(["write", payload]);
  },
  readImage() {
    return this.image || emptyImage;
  },
  writeImage(image) {
    this.text = "";
    this.html = "";
    this.rtf = "";
    this.image = image;
    this.formats = image && !image.isEmpty() ? ["image/png"] : [];
    this.writes.push(["writeImage", image]);
  },
};

const emptyImage = { isEmpty: () => true };
const nonEmptyImage = { isEmpty: () => false };

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");

const originalLoad = Module._load;

function loadClipboardManager({ spawn, spawnSync, debugLogger } = {}) {
  delete require.cache[clipboardModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        clipboard: fakeClipboard,
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
        },
      };
    }
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn, ...(spawnSync ? { spawnSync } : {}) };
    }
    if (request === "./debugLogger" && debugLogger) return debugLogger;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

const ClipboardManager = loadClipboardManager();
const initialExitListeners = new Set(process.listeners("exit"));

test.afterEach(() => {
  for (const listener of process.listeners("exit")) {
    if (!initialExitListeners.has(listener)) {
      process.removeListener("exit", listener);
    }
  }
});

function createSuccessfulSpawn(calls) {
  return function successfulSpawn(command, args = []) {
    calls.push({ command, args });
    const pasteProcess = new EventEmitter();
    pasteProcess.stderr = new EventEmitter();
    pasteProcess.stdout = new EventEmitter();
    process.nextTick(() => pasteProcess.emit("close", 0));
    return pasteProcess;
  };
}

function createSpawn(calls, exitCodes, { stdout = [] } = {}) {
  return function mockedSpawn(command, args = []) {
    calls.push({ command, args });
    const pasteProcess = new EventEmitter();
    pasteProcess.stderr = new EventEmitter();
    pasteProcess.stdout = new EventEmitter();
    const code = exitCodes.shift() ?? 0;
    const output = stdout.shift();
    process.nextTick(() => {
      if (output) pasteProcess.stdout.emit("data", output);
      pasteProcess.emit("close", code);
    });
    return pasteProcess;
  };
}

async function withWaylandEnvironment(desktop, callback) {
  const previous = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    HYPRLAND_INSTANCE_SIGNATURE: process.env.HYPRLAND_INSTANCE_SIGNATURE,
    DISPLAY: process.env.DISPLAY,
  };
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.WAYLAND_DISPLAY = "wayland-1";
  delete process.env.DISPLAY;
  if (desktop === "Hyprland") process.env.HYPRLAND_INSTANCE_SIGNATURE = "test";
  else delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resetClipboard({
  text = "",
  html = "",
  rtf = "",
  image = null,
  formats = ["text/plain"],
} = {}) {
  fakeClipboard.text = text;
  fakeClipboard.html = html;
  fakeClipboard.rtf = rtf;
  fakeClipboard.image = image;
  fakeClipboard.formats = formats;
  fakeClipboard.writes = [];
}

test("restore preserves rich clipboard formats atomically", () => {
  resetClipboard({
    formats: ["text/html", "text/rtf", "text/plain", "image/png"],
    text: "plain before",
    html: "<b>html before</b>",
    rtf: "{\\rtf1 before}",
    image: nonEmptyImage,
  });
  const manager = new ClipboardManager();

  const snapshot = manager._saveClipboard();
  fakeClipboard.writeText("dictated text");
  manager._restoreClipboard(snapshot);

  assert.deepEqual([...fakeClipboard.availableFormats()].sort(), [
    "image/png",
    "text/html",
    "text/plain",
    "text/rtf",
  ]);
  assert.equal(fakeClipboard.text, "plain before");
  assert.equal(fakeClipboard.html, "<b>html before</b>");
  assert.equal(fakeClipboard.rtf, "{\\rtf1 before}");
  assert.equal(fakeClipboard.image, nonEmptyImage);
  assert.equal(fakeClipboard.writes.at(-1)[0], "write");
});

test("restore runs when clipboard still contains the pasted text", async () => {
  resetClipboard();
  fakeClipboard.text = "dictated text";
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "previous clipboard");
});

test("restore is skipped when another clipboard write wins the race", async () => {
  resetClipboard();
  fakeClipboard.text = "user copied something else";
  const manager = new ClipboardManager();

  await manager._restoreClipboardAfterDelay(
    { type: "text", data: "previous clipboard" },
    { delayMs: 0, expectedText: "dictated text" }
  );

  assert.equal(fakeClipboard.text, "user copied something else");
});

test("pasteText waits for prior clipboard restoration before starting the next paste", async () => {
  const manager = new ClipboardManager();
  const events = [];
  let releaseFirstRestore;

  manager._pasteText = async (text) => {
    events.push(`start:${text}`);
    events.push(`end:${text}`);
    if (text === "first") {
      return {
        restoreComplete: new Promise((resolve) => {
          releaseFirstRestore = resolve;
        }),
      };
    }
    return { restoreComplete: Promise.resolve() };
  };

  await manager.pasteText("first");
  const secondPaste = manager.pasteText("second");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ["start:first", "end:first"]);

  releaseFirstRestore();
  await secondPaste;
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
});

test("pasteWithFastPaste passes --restore-window <hwnd> when targetWindow is set (#859)", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager._restoreClipboardAfterDelay = () => Promise.resolve();

  const result = await manager.pasteWithFastPaste(
    "/tmp/windows-fast-paste.exe",
    { type: "text", data: "previous clipboard" },
    // Hex id: the binary prints "TARGET %p" (hex) from --detect-only and parses
    // --restore-window with strtoull base 16, so the handle stays hex end to end.
    { expectedClipboardText: "dictated text", targetWindow: "1A2B3C" }
  );
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/tmp/windows-fast-paste.exe");
  assert.deepEqual(spawnCalls[0].args, ["--restore-window", "1A2B3C"]);
});

test("pasteWithFastPaste sends no args when nothing was captured", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager._restoreClipboardAfterDelay = () => Promise.resolve();

  const result = await manager.pasteWithFastPaste(
    "/tmp/windows-fast-paste.exe",
    { type: "text", data: "previous clipboard" },
    { expectedClipboardText: "dictated text" }
  );
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, []);
});

test("Hyprland paste uses the current symbolic shortcut dispatcher", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["ok\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => "kitty";

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "hyprctl",
      args: [
        "dispatch",
        'hl.dsp.send_shortcut({ mods = "CTRL SHIFT", key = "V", window = "activewindow" })',
      ],
    },
  ]);
});

test("Hyprland paste falls back to the legacy symbolic shortcut dispatcher", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0, 0], {
      stdout: ["invalid dispatcher\n", "ok\n"],
    }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "hyprctl",
      args: [
        "dispatch",
        'hl.dsp.send_shortcut({ mods = "SHIFT", key = "Insert", window = "activewindow" })',
      ],
    },
    { command: "hyprctl", args: ["dispatch", "sendshortcut", "SHIFT, Insert, activewindow"] },
  ]);
});

test("Hyprland prefers wtype over sendshortcut when installed", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl" || command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype"]
  );
});

test("failed wtype on Hyprland continues to sendshortcut", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0], { stdout: ["", "ok\n"] }),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "hyprctl" || command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;

  await withWaylandEnvironment("Hyprland", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype", "hyprctl"]
  );
});

test("wlroots tries wtype before native uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Sway", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "wtype", args: ["-M", "shift", "-k", "Insert", "-m", "shift"] },
  ]);
});

test("failed wtype continues to native Shift+Insert uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "wtype";
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Sway", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.command),
    ["wtype", "/tmp/linux-fast-paste"]
  );
  assert.deepEqual(spawnCalls[1].args, ["--uinput", "--shift-insert"]);
});

test("GNOME tries uinput before a tokenless portal", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "/tmp/linux-fast-paste", args: ["--uinput", "--shift-insert"] },
  ]);
});

test("GNOME falls back to a tokenless portal after uinput fails", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "/tmp/linux-fast-paste", args: ["--uinput", "--shift-insert"] },
    { command: "/tmp/linux-fast-paste", args: ["--portal", "--shift-insert"] },
  ]);
});

test("GNOME uses a saved portal token before uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [0], { stdout: ["rotated-token\n"] }),
  });
  const manager = new TestClipboardManager();
  const savedTokens = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._savePortalToken = (token) => savedTokens.push(token);

  await withWaylandEnvironment("GNOME", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    {
      command: "/tmp/linux-fast-paste",
      args: ["--portal", "--shift-insert", "--restore-token", "restore-token"],
    },
  ]);
  assert.deepEqual(savedTokens, ["rotated-token"]);
});

test("GNOME stops preferring a saved portal token after it fails", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";

  await withWaylandEnvironment("GNOME", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [
      ["--portal", "--shift-insert", "--restore-token", "restore-token"],
      ["--uinput", "--shift-insert"],
      ["--uinput", "--shift-insert"],
    ]
  );
});

test("KDE tries portal before uinput", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => null;

  await withWaylandEnvironment("KDE", () => manager.pasteLinux(null));

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [
      ["--portal", "--shift-insert"],
      ["--uinput", "--shift-insert"],
    ]
  );
});

test("portal exit zero succeeds with or without a restore token", async () => {
  const calls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(calls, [0, 0], { stdout: ["", "rotated-token\n"] }),
  });
  const manager = new TestClipboardManager();
  const saved = [];
  const restoreTokens = [null, "restore-token"];
  manager._readPortalToken = () => restoreTokens.shift();
  manager._savePortalToken = (token) => saved.push(token);

  assert.equal(await manager._runPortalPaste("/tmp/linux-fast-paste"), null);
  assert.equal(await manager._runPortalPaste("/tmp/linux-fast-paste"), "rotated-token");
  assert.deepEqual(
    calls.map((call) => call.args),
    [["--portal"], ["--portal", "--restore-token", "restore-token"]]
  );
  assert.deepEqual(saved, ["rotated-token"]);
});

test("portal symbolic input failure is suppressed for the process", async () => {
  const manager = new ClipboardManager();
  const attempts = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._runPortalPaste = async () => {
    attempts.push("portal");
    throw new Error("portal symbolic keyboard input unavailable");
  };
  manager._runLinuxPasteCommand = async () => attempts.push("uinput");

  await withWaylandEnvironment("GNOME", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  assert.deepEqual(attempts, ["portal", "uinput", "uinput"]);
});

test("portal denial is attempted once per process", async () => {
  const manager = new ClipboardManager();
  const attempts = [];
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
  manager._readPortalToken = () => "restore-token";
  manager._runPortalPaste = async () => {
    attempts.push("portal");
    throw new Error("portal-denied");
  };
  manager._runLinuxPasteCommand = async () => attempts.push("uinput");

  await withWaylandEnvironment("GNOME", async () => {
    await manager.pasteLinux(null);
    await manager.pasteLinux(null);
  });

  assert.deepEqual(attempts, ["portal", "uinput", "uinput"]);
});

test("portal exit six reports unavailable symbolic input", async () => {
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn([], [6]),
  });
  const manager = new TestClipboardManager();

  await assert.rejects(
    manager._runPortalPaste("/tmp/linux-fast-paste"),
    /portal symbolic keyboard input unavailable/
  );
});

test("Wayland ydotool uses raw Shift+Insert keycodes", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "ydotool";
  manager._isYdotoolDaemonRunning = () => true;
  manager._isYdotoolLegacy = () => false;
  manager.resolveLinuxFastPasteBinary = () => null;

  await withWaylandEnvironment("Unknown", () => manager.pasteLinux(null));

  assert.deepEqual(spawnCalls, [
    { command: "ydotool", args: ["key", "42:1", "110:1", "110:0", "42:0"] },
  ]);
});

test("successful Wayland dispatch starts clipboard restoration", async () => {
  const manager = new ClipboardManager();
  let restoreCalled = false;
  manager.commandExists = (command) => command === "hyprctl";
  manager.resolveLinuxFastPasteBinary = () => null;
  manager._detectHyprlandWindowClass = () => null;
  manager._runLinuxPasteCommand = async () => {};
  manager._restoreClipboardAfterDelay = () => {
    restoreCalled = true;
    return Promise.resolve();
  };

  const result = await withWaylandEnvironment("Hyprland", () =>
    manager.pasteLinux({ type: "text", data: "previous" }, { expectedClipboardText: "dictated" })
  );
  await result.restoreComplete;

  assert.equal(restoreCalled, true);
});

test("XWayland fallback remains reachable after native Wayland failure", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSpawn(spawnCalls, [1, 0]),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = () => false;
  manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";

  await withWaylandEnvironment("Unknown", async () => {
    process.env.DISPLAY = ":0";
    await manager.pasteLinux(null);
  });

  assert.deepEqual(
    spawnCalls.map((call) => call.args),
    [["--uinput", "--shift-insert"], ["--shift-insert"]]
  );
});

test("the xdotool type fallback types the text and keeps it out of the logs", async (t) => {
  const TEXT = "dictated secret sentence";
  const spawnCalls = [];
  const logCalls = [];
  const TestClipboardManager = loadClipboardManager({
    // The key press fails, then the type fallback fails: every log site runs.
    spawn: createSpawn(spawnCalls, [1, 1]),
    spawnSync: (_command, args) => {
      const stdout = args.includes("getwindowclassname")
        ? "gnome-terminal"
        : args.includes("getwindowpid")
          ? ""
          : "4242";
      return { status: stdout ? 0 : 1, stdout: Buffer.from(stdout) };
    },
    debugLogger: new Proxy(
      {},
      {
        get:
          (_target, level) =>
          (...args) =>
            logCalls.push([level, ...args]),
      }
    ),
  });
  const manager = new TestClipboardManager();
  manager.commandExists = (command) => command === "xdotool";
  manager.resolveLinuxFastPasteBinary = () => null;
  const previous = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.XDG_SESSION_TYPE = "x11";
  delete process.env.WAYLAND_DISPLAY;
  resetClipboard({ text: TEXT });

  await assert.rejects(manager.pasteLinux(null));

  assert.deepEqual(spawnCalls[1], {
    command: "xdotool",
    args: ["windowactivate", "--sync", "4242", "type", "--clearmodifiers", "--", TEXT],
  });
  assert.ok(logCalls.length > 0);
  assert.equal(JSON.stringify(logCalls).includes(TEXT), false);
});

test("pasteMacOS restores clipboard after the short macOS delay on successful fast paste", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const originalClipboard = { type: "text", data: "previous clipboard" };
  let restoreCall;

  manager.resolveFastPasteBinary = () => "/tmp/openwhispr-fast-paste";
  manager._restoreClipboardAfterDelay = (original, options) => {
    restoreCall = { original, options };
    return Promise.resolve();
  };

  const result = await manager.pasteMacOS(originalClipboard, {
    expectedClipboardText: "dictated text",
    fromStreaming: true,
  });
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/tmp/openwhispr-fast-paste");
  assert.equal(restoreCall.original, originalClipboard);
  assert.deepEqual(restoreCall.options, {
    delayMs: 450,
    expectedText: "dictated text",
  });
});

// Records the delay of every setTimeout scheduled while `run` is in flight.
// The first entry is the pre-keystroke wait (#565).
async function recordTimeoutDelays(run) {
  const delays = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    delays.push(ms);
    return originalSetTimeout(fn, ms, ...args);
  };
  try {
    await run();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  return delays;
}

function macPasteManager({ fastPasteBinary, spawnCalls }) {
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  manager.resolveFastPasteBinary = () => fastPasteBinary;
  manager._restoreClipboardAfterDelay = () => Promise.resolve();
  return manager;
}

test("dictation paste via the CGEvent helper waits 15 ms before the keystroke (#565)", async () => {
  const spawnCalls = [];
  const manager = macPasteManager({ fastPasteBinary: "/fake/fast-paste", spawnCalls });

  const delays = await recordTimeoutDelays(() =>
    manager.pasteMacOS(null, { expectedClipboardText: "dictated text", targetActivated: true })
  );

  assert.equal(delays[0], 15);
  assert.equal(spawnCalls[0].command, "/fake/fast-paste");
});

test("dictation paste via the resident Globe listener waits 15 ms before the keystroke (#565)", async () => {
  const spawnCalls = [];
  const manager = macPasteManager({ fastPasteBinary: "/fake/fast-paste", spawnCalls });
  let residentPastes = 0;
  manager.setResidentPaste(async () => {
    residentPastes += 1;
  });

  const delays = await recordTimeoutDelays(() =>
    manager.pasteMacOS(null, { expectedClipboardText: "dictated text", targetActivated: true })
  );

  assert.deepEqual(delays, [15]);
  assert.equal(residentPastes, 1);
  assert.equal(spawnCalls.length, 0);
});

// Pre-push review: the 120 ms sleep was the only grace a late activation got.
// Without a confirmed frontmost target, keep it.
test("CGEvent and resident pastes keep 120 ms when the target was not confirmed frontmost (#565)", async () => {
  const spawnCalls = [];
  const helper = macPasteManager({ fastPasteBinary: "/fake/fast-paste", spawnCalls });
  const helperDelays = await recordTimeoutDelays(() =>
    helper.pasteMacOS(null, { expectedClipboardText: "dictated text", targetActivated: false })
  );
  assert.equal(helperDelays[0], 120);

  const resident = macPasteManager({ fastPasteBinary: "/fake/fast-paste", spawnCalls: [] });
  resident.setResidentPaste(async () => {});
  const residentDelays = await recordTimeoutDelays(() =>
    resident.pasteMacOS(null, { expectedClipboardText: "dictated text" })
  );
  assert.deepEqual(residentDelays, [120], "no activation info keeps the old wait");
});

test("dictation paste via osascript keeps the 120 ms wait before the keystroke (#565)", async () => {
  const spawnCalls = [];
  const manager = macPasteManager({ fastPasteBinary: null, spawnCalls });

  const delays = await recordTimeoutDelays(() =>
    manager.pasteMacOS(null, { expectedClipboardText: "dictated text" })
  );

  assert.equal(delays[0], 120);
  assert.equal(spawnCalls[0].command, "osascript");
});

test("pasteMacOSWithOsascript fallback uses the short macOS restore delay", async () => {
  const spawnCalls = [];
  const TestClipboardManager = loadClipboardManager({
    spawn: createSuccessfulSpawn(spawnCalls),
  });
  const manager = new TestClipboardManager();
  const originalClipboard = { type: "text", data: "previous clipboard" };
  let restoreCall;

  manager._restoreClipboardAfterDelay = (original, options) => {
    restoreCall = { original, options };
    return Promise.resolve();
  };

  const result = await manager.pasteMacOSWithOsascript(originalClipboard, {
    expectedClipboardText: "dictated text",
  });
  await result.restoreComplete;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "osascript");
  assert.deepEqual(spawnCalls[0].args, [
    "-e",
    'tell application "System Events" to key code 9 using command down',
  ]);
  assert.equal(restoreCall.original, originalClipboard);
  assert.deepEqual(restoreCall.options, {
    delayMs: 450,
    expectedText: "dictated text",
  });
});

// #634: auto-submit hands pasteMacOS a `pasteKeystroke` that pastes and
// presses Return in the target process. It replaces the normal paste keystroke
// unless it reports that it sent nothing.
const PREVIOUS_CLIPBOARD = { type: "text", data: "previous clipboard" };

function keystrokeManager({ fastPasteBinary = "/fake/fast-paste", spawn } = {}) {
  const calls = { spawns: [], resident: 0, restores: [], keystrokes: 0 };
  const TestClipboardManager = loadClipboardManager({
    spawn: spawn ? spawn(calls.spawns) : createSuccessfulSpawn(calls.spawns),
  });
  const manager = new TestClipboardManager();
  manager.resolveFastPasteBinary = () => fastPasteBinary;
  manager.checkAccessibilityPermissions = async () => true;
  manager._restoreClipboardAfterDelay = (original, options) => {
    calls.restores.push({ original, options });
    return Promise.resolve();
  };
  const residentPaste = async () => {
    calls.resident += 1;
  };
  const options = (pasteKeystroke) => ({
    expectedClipboardText: "dictated text",
    targetActivated: true,
    pasteKeystroke: () => {
      calls.keystrokes += 1;
      return pasteKeystroke();
    },
  });
  return { manager, calls, options, residentPaste };
}

const crash = () => {
  throw new Error("helper crashed");
};
// [what the pasteKeystroke does, the outcome pasteMacOS reports]
for (const [name, pasteKeystroke, outcome] of [
  ['answering "submitted"', async () => "submitted", "submitted"],
  ['answering "pasted"', async () => "pasted", "pasted"],
  ['answering "failed"', async () => "failed", "failed"],
  ["that throws", crash, "failed"],
  ["that rejects", async () => crash(), "failed"],
  ["answering an unknown value", async () => true, "failed"],
]) {
  test(`a pasteKeystroke ${name} is the only keystroke sent`, async () => {
    resetClipboard({ text: "dictated text" });
    const { manager, calls, options, residentPaste } = keystrokeManager();
    manager.setResidentPaste(residentPaste);
    const sent = outcome !== "failed";

    const delays = await recordTimeoutDelays(async () => {
      const result = await manager.pasteMacOS(PREVIOUS_CLIPBOARD, options(pasteKeystroke));
      await result.restoreComplete;
      assert.equal(result.keystrokeOutcome, outcome);
      assert.equal(result.pasted !== false, sent);
    });

    assert.deepEqual(delays, [15], "one pre-keystroke wait");
    assert.equal(calls.keystrokes, 1);
    assert.equal(calls.spawns.length, 0);
    assert.equal(calls.resident, 0);
    // A sent paste schedules the clipboard restore; an unknown outcome leaves
    // the dictated text on the clipboard for a manual paste.
    const restore = { delayMs: 450, expectedText: "dictated text" };
    const restores = sent ? [{ original: PREVIOUS_CLIPBOARD, options: restore }] : [];
    assert.deepEqual(calls.restores, restores);
    assert.equal(fakeClipboard.text, "dictated text");
    assert.deepEqual(fakeClipboard.writes, []);
  });
}

test('a pasteKeystroke answering "skipped" runs the normal keystroke path once', async () => {
  const { manager, calls, options, residentPaste } = keystrokeManager();
  const skipped = options(async () => "skipped");

  const helper = await manager.pasteMacOS(PREVIOUS_CLIPBOARD, skipped);
  await helper.restoreComplete;

  assert.equal(helper.keystrokeOutcome, "skipped");
  assert.notEqual(helper.pasted, false);
  assert.equal(calls.keystrokes, 1);
  assert.equal(calls.spawns.length, 1);
  assert.equal(calls.spawns[0].command, "/fake/fast-paste");

  // The resident listener is the normal path when it is available.
  manager.setResidentPaste(residentPaste);
  const resident = await manager.pasteMacOS(null, skipped);

  assert.equal(resident.keystrokeOutcome, "skipped");
  assert.equal(calls.keystrokes, 2);
  assert.equal(calls.resident, 1);
  assert.equal(calls.spawns.length, 1);
});

const macPasteTextSkip = process.platform === "darwin" ? false : "exercises the macOS paste path";

// The paste and its Return are one queued operation, so another paste cannot
// land on the same command line in between.
test(
  "a second pasteText does not start its paste while the first pasteKeystroke is pending",
  { skip: macPasteTextSkip },
  async () => {
    resetClipboard({ text: "previous clipboard" });
    const events = [];
    const { manager, calls } = keystrokeManager({
      spawn: (spawnCalls) => {
        const successfulSpawn = createSuccessfulSpawn(spawnCalls);
        return (...args) => {
          events.push(`spawn:${fakeClipboard.text}`);
          return successfulSpawn(...args);
        };
      },
    });
    let releaseKeystroke;

    const first = manager.pasteText("first", {
      targetActivated: true,
      pasteKeystroke: () =>
        new Promise((resolve) => {
          events.push(`keystroke:start:${fakeClipboard.text}`);
          releaseKeystroke = () => {
            events.push("keystroke:end");
            resolve("submitted");
          };
        }),
    });
    const second = manager.pasteText("second", { targetActivated: true });
    // Bounded: if pasteKeystroke is never called this fails instead of hanging.
    for (let waited = 0; !releaseKeystroke && waited < 2000; waited += 5) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(typeof releaseKeystroke, "function", "pasteKeystroke was called");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(events, ["keystroke:start:first"]);
    assert.equal(fakeClipboard.text, "first", "the second paste has not touched the clipboard");

    releaseKeystroke();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(events, ["keystroke:start:first", "keystroke:end", "spawn:second"]);
    assert.equal(firstResult.keystrokeOutcome, "submitted");
    assert.equal("keystrokeOutcome" in secondResult, false);
    assert.equal(calls.spawns.length, 1);
  }
);

test(
  "the macOS retry after a failed paste does not call pasteKeystroke a second time",
  { skip: macPasteTextSkip },
  async () => {
    resetClipboard({ text: "previous clipboard" });
    // No fast-paste binary: osascript fails once, then the retry succeeds.
    const { manager, calls, options } = keystrokeManager({
      fastPasteBinary: null,
      spawn: (spawnCalls) => createSpawn(spawnCalls, [1, 0]),
    });

    const result = await manager.pasteText(
      "dictated text",
      options(async () => "skipped")
    );

    assert.equal(calls.keystrokes, 1);
    assert.equal(calls.spawns.length, 2);
    assert.notEqual(result.pasted, false);
    assert.equal("keystrokeOutcome" in result, false);
  }
);

// Terminal detection serves two callers: the Linux paste path, which matches
// window classes by substring, and macOS selection capture, which matches whole
// tokens of the app and executable name (#645: "st" is a Linux window class).
test("terminal detection matches window classes and macOS app names alike", () => {
  const manager = new ClipboardManager();

  for (const signature of ["konsole", "org.kde.konsole", "Ghostty", "kitty", "WezTerm"]) {
    assert.equal(manager.isTerminalSignature(signature, "linux"), true, signature);
  }
  assert.equal(manager.isLinuxTerminalWindowClass("konsole"), true);
  assert.equal(manager.isLinuxTerminalWindowClass("org.mozilla.firefox"), false);
  assert.equal(manager.isLinuxTerminalWindowClass(null), false);

  for (const signature of [
    "iTerm iTerm2",
    // The app's own name, with no "iTerm" token beside it.
    "iTerm2",
    "Terminal Terminal",
    "Ghostty ghostty",
    "Warp stable",
    "kitty kitty",
  ]) {
    assert.equal(manager.isTerminalSignature(signature, "darwin"), true, signature);
  }

  for (const signature of [
    "Raycast Raycast",
    "Fantastical Fantastical",
    "iStat Menus Menubar",
    "System Settings System Settings",
    "Postman Postman",
    "Microsoft Teams MSTeams",
    "Dia",
    "Google Chrome",
    "Mail",
    "",
    null,
    undefined,
  ]) {
    assert.equal(manager.isTerminalSignature(signature, "darwin"), false, String(signature));
  }
});
