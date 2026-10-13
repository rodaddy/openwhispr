const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("a settings change during refresh publishes only the latest tray microphone state", async (t) => {
  let state = { microphoneSelectionMode: "automatic", selectedMicDeviceId: "old" };
  let listener;
  let finishFirst;
  const published = [];
  const originalNavigator = globalThis.navigator;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        updateTrayMicrophoneState: async (value) => published.push(value),
        onTrayMicrophoneSelection: () => () => {},
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "mic", groupId: "g", label: "Mic" },
        ],
        addEventListener() {},
        removeEventListener() {},
      },
    },
  });
  t.after(() =>
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator })
  );

  globalThis.__trayMicState = () => state;
  globalThis.__trayMicSubscribe = (next) => {
    listener = next;
  };
  globalThis.__trayMicResolve = () =>
    new Promise((resolve) => {
      finishFirst = resolve;
    });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tray-mic-state-test-",
    mockModules: {
      "/stores/settingsStore": `export const useSettingsStore = {
        getState: () => globalThis.__trayMicState(),
        subscribe: (listener) => { globalThis.__trayMicSubscribe(listener); return () => {}; }
      };`,
      "/helpers/microphoneSelection": `let calls = 0; export async function resolvePreferredMicrophone() {
        calls += 1;
        if (calls === 1) return globalThis.__trayMicResolve();
        return { device: { deviceId: "new", label: "New Mic" } };
      }`,
      "/utils/logger": `export default { debug() {} };`,
    },
  });
  t.after(() => {
    delete globalThis.__trayMicState;
    delete globalThis.__trayMicSubscribe;
    delete globalThis.__trayMicResolve;
  });
  const { useTrayMicrophoneState } = await vite.ssrLoadModule("/hooks/useTrayMicrophoneState.ts");
  const container = installHookDom(t);
  const root = createRoot(container);
  function Harness() {
    useTrayMicrophoneState(false);
    return null;
  }

  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  state = { ...state, microphoneSelectionMode: "system", selectedMicDeviceId: "new" };
  listener();
  finishFirst({ device: { deviceId: "old", label: "Old Mic" } });
  await React.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(published.length, 1);
  assert.equal(published[0].mode, "system");
  assert.equal(published[0].selectedMicDeviceId, "new");
  assert.equal(published[0].resolvedActiveLabel, "New Mic");
  await React.act(async () => root.unmount());
});

test("the automatic-mode tick reads the cached system default; only change signals force a refresh", async (t) => {
  let state = { microphoneSelectionMode: "automatic", selectedMicDeviceId: "", theme: "dark" };
  let listener;
  const larkRefreshFlags = [];
  const originalNavigator = globalThis.navigator;
  const originalSetTimeout = globalThis.setTimeout;
  const ticks = [];

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        updateTrayMicrophoneState: async () => {},
        onTrayMicrophoneSelection: () => () => {},
        getLarkM2Status: async (options) => {
          larkRefreshFlags.push(options?.refresh === true);
          return { status: "unknown" };
        },
      },
    },
  });
  let deviceChange;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [],
        addEventListener(name, handler) {
          if (name === "devicechange") deviceChange = handler;
        },
        removeEventListener() {},
      },
    },
  });
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 2000) {
      ticks.push(fn);
      return 0;
    }
    return originalSetTimeout(fn, ms);
  };
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    globalThis.setTimeout = originalSetTimeout;
  });

  globalThis.__trayMicState = () => state;
  globalThis.__trayMicRefreshFlags = [];
  globalThis.__trayMicSubscribe = (next) => {
    listener = next;
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tray-mic-tick-test-",
    mockModules: {
      "/stores/settingsStore": `export const useSettingsStore = {
        getState: () => globalThis.__trayMicState(),
        subscribe: (listener) => { globalThis.__trayMicSubscribe(listener); return () => {}; }
      };`,
      "/helpers/microphoneSelection": `export async function resolvePreferredMicrophone({ refreshSystemDefault, getWirelessStatus }) {
        globalThis.__trayMicRefreshFlags.push(refreshSystemDefault);
        await getWirelessStatus();
        return { device: null };
      }`,
      "/utils/logger": `export default { debug() {} };`,
    },
  });
  t.after(() => {
    delete globalThis.__trayMicState;
    delete globalThis.__trayMicRefreshFlags;
    delete globalThis.__trayMicSubscribe;
  });
  const { useTrayMicrophoneState } = await vite.ssrLoadModule("/hooks/useTrayMicrophoneState.ts");
  const container = installHookDom(t);
  const root = createRoot(container);
  function Harness() {
    useTrayMicrophoneState(false);
    return null;
  }

  const settle = () =>
    React.act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  await settle();
  assert.deepEqual(globalThis.__trayMicRefreshFlags, [true], "first run forces a refresh");

  assert.equal(ticks.length, 1, "automatic mode arms the 2s tick");
  ticks.shift()();
  await settle();
  assert.deepEqual(globalThis.__trayMicRefreshFlags, [true, false], "the tick uses the cache");

  ticks.shift()();
  await settle();
  assert.deepEqual(globalThis.__trayMicRefreshFlags, [true, false, false]);
  assert.deepEqual(larkRefreshFlags, [true, false, false], "the tick reads the cached Lark status");

  const change = async (patch) => {
    const prev = state;
    state = { ...state, ...patch };
    listener(state, prev);
    await settle();
  };
  await change({ theme: "light" });
  assert.equal(globalThis.__trayMicRefreshFlags.length, 3, "an unrelated setting does not refresh");
  // Every setting resolvePreferredMicrophone reads must force a refresh. The
  // list is spelled out here so dropping a key from the hook fails the test.
  const micSettingKeys = [
    "microphoneSelectionMode",
    "preferBuiltInMic",
    "selectedMicDeviceId",
    "selectedMicDeviceLabel",
    "preferredMicDeviceId",
    "preferredMicDeviceLabel",
    "fallbackMicDeviceId",
    "fallbackMicDeviceLabel",
  ];
  for (const key of micSettingKeys) {
    const before = globalThis.__trayMicRefreshFlags.length;
    await change({ [key]: `changed-${key}` });
    assert.deepEqual(
      globalThis.__trayMicRefreshFlags.slice(before),
      [true],
      `${key} forces a refresh`
    );
  }
  ticks.length = 0;

  deviceChange();
  await settle();
  const forced = Array(micSettingKeys.length + 1).fill(true);
  assert.deepEqual(
    globalThis.__trayMicRefreshFlags,
    [true, false, false, ...forced],
    "a device change forces a refresh"
  );
  assert.deepEqual(larkRefreshFlags, [true, false, false, ...forced]);
  await React.act(async () => root.unmount());
});
