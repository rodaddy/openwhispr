const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const connectorModulePath = require.resolve("../../src/helpers/pipelineConnector");
const originalLoad = Module._load;
const handlers = new Map();
const electronStub = {
  app: {
    getPath: () =>
      require("node:path").join(
        require("node:os").tmpdir(),
        "openwhispr-pipeline-verification",
        "ipc"
      ),
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} },
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
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
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
let PipelineError;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  ({ PipelineError } = require(connectorModulePath));
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = { sessionId: "pipeline-ipc-test", pipelineConnector: {} };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

test("registers the narrow pipeline invoke channels", () => {
  const channels = [...handlers.keys()].filter((channel) => channel.startsWith("pipeline-"));
  assert.deepEqual(channels.sort(), [
    "pipeline-get-questions",
    "pipeline-get-settings",
    "pipeline-get-sync-state",
    "pipeline-save-settings",
    "pipeline-send-note",
    "pipeline-submit-grill-note",
    "pipeline-test-connection",
  ]);
});

test("the renderer settings payload never carries the token", async () => {
  const settings = { baseUrl: "https://smp.example.test", hasToken: true, configured: true };
  target.pipelineConnector.getSettings = async () => settings;
  target.pipelineConnector.saveSettings = async () => settings;
  assert.deepEqual(await handlers.get("pipeline-get-settings")({ sender: {} }), {
    success: true,
    settings,
  });
  const saved = await handlers.get("pipeline-save-settings")(
    { sender: {} },
    { baseUrl: "https://smp.example.test", token: "smp-secret" }
  );
  assert.equal(JSON.stringify(saved).includes("smp-secret"), false);
});

test("pipeline IPC keeps bounded error metadata and hides unknown failures", async () => {
  target.pipelineConnector.sendNote = async () => {
    throw new PipelineError("Pipeline rejected the session", { code: "BAD_REQUEST", status: 400 });
  };
  assert.deepEqual(await handlers.get("pipeline-send-note")({ sender: {} }, 42), {
    success: false,
    error: "Pipeline rejected the session",
    code: "BAD_REQUEST",
    status: 400,
  });
  target.pipelineConnector.fetchQuestions = async () => {
    throw new Error("raw body with smp-secret");
  };
  assert.deepEqual(await handlers.get("pipeline-get-questions")({ sender: {} }), {
    success: false,
    error: "Pipeline operation failed",
  });
  target.pipelineConnector.fetchQuestions = async () => ({
    configured: true,
    questions: [{ id: "fq-1", question: "Q?" }],
  });
  assert.deepEqual(await handlers.get("pipeline-get-questions")({ sender: {} }), {
    success: true,
    configured: true,
    questions: [{ id: "fq-1", question: "Q?" }],
  });
});
