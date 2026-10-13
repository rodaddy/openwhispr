const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const sends = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: (...args) => sends.push(args),
    sendSync: () => undefined,
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposedApi = api;
      },
    },
    ipcRenderer,
    webUtils: {},
  };
  const source = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, invocations, listeners, sends };
}

test("preload exposes the assistant speech barge-in surface", () => {
  const { api } = loadPreloadApi();
  assert.equal(typeof api.stopAssistantSpeech, "function");
  assert.equal(typeof api.onAssistantSpeechStop, "function");
  assert.equal(typeof api.setAssistantSpeechPlaying, "function");
});

test("stopAssistantSpeech sends the barge-in request to main", () => {
  const { api, sends } = loadPreloadApi();
  api.stopAssistantSpeech();
  assert.deepEqual(sends.at(-1), ["stop-assistant-speech"]);
});

test("setAssistantSpeechPlaying reports the boolean playback state", () => {
  const { api, sends } = loadPreloadApi();
  api.setAssistantSpeechPlaying(true);
  assert.deepEqual(sends.at(-1), ["assistant-speech-playing", true]);
  api.setAssistantSpeechPlaying(false);
  assert.deepEqual(sends.at(-1), ["assistant-speech-playing", false]);
});

test("onAssistantSpeechStop subscribes and returns an unsubscribe", () => {
  const { api, listeners } = loadPreloadApi();
  let calls = 0;
  const unsubscribe = api.onAssistantSpeechStop(() => {
    calls++;
  });
  const listener = listeners.get("assistant-speech:stop");
  assert.equal(typeof listener, "function");
  listener({}, undefined);
  assert.equal(calls, 1);
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(listeners.has("assistant-speech:stop"), false);
});
