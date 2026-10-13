// Shared hub harness: the real main-process hub bridge and the real preload.js,
// with only the network and the on-disk token file faked.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createHubBridge } = require("../../../src/helpers/hubSync");

// Mirrors tokenStore's contract, including that set/clear echo the token back:
// the bridge has to strip it before anything crosses to the renderer.
function createTokenStore() {
  let token = null;
  let generation = 0;
  return {
    getState: () => ({ token, generation }),
    set(next) {
      if (next === token) return { success: true, token, generation };
      token = next;
      generation += 1;
      return { success: true, token, generation };
    },
    clear() {
      token = null;
      generation += 1;
      return { success: true, token, generation };
    },
  };
}

function createMain({ hubUrl = "", respond } = {}) {
  const settings = { hubUrl };
  const tokenStore = createTokenStore();
  const fetches = [];
  const bridge = createHubBridge({
    getHubUrl: () => settings.hubUrl,
    saveHubUrl: (url) => {
      settings.hubUrl = url;
    },
    tokenStore,
    getAppVersion: () => "2.0.5",
    proxyFetch: async (url, init) => {
      fetches.push({ url, init });
      return respond ? respond(url, init) : new Response("{}", { status: 404 });
    },
    logger: { error: () => {} },
  });
  const handlers = {
    "cloud-api-request": (opts) => bridge.request(opts),
    "hub-get-url": () => bridge.getUrl(),
    "hub-get-insecure-url": () => bridge.getInsecureUrl(),
    "hub-save-url": (value) => bridge.saveUrl(value),
    "hub-get-device-key-state": () => bridge.getKeyState(),
    "hub-set-device-key": (key) => bridge.setKey(key),
    "hub-clear-device-key": () => bridge.clearKey(),
  };
  return { settings, tokenStore, fetches, handlers };
}

// Loads the real preload.js; every invoke is answered by the main-side handler
// map and structured-cloned, as Electron IPC would.
function loadPreloadApi(handlers) {
  let exposedApi;
  const invocations = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        const handler = handlers[channel];
        const result = handler ? await handler(...args) : undefined;
        invocations.push({ channel, args, result });
        return result === undefined ? undefined : structuredClone(result);
      },
      on: () => {},
      removeListener: () => {},
      send: () => {},
      sendSync: () => undefined,
    },
    webUtils: {},
  };
  const source = fs.readFileSync(path.join(__dirname, "../../../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, invocations };
}

module.exports = { createTokenStore, createMain, loadPreloadApi };
