const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const electronStub = {
  app: {
    getPath: () =>
      require("node:path").join(require("node:os").tmpdir(), "openwhispr-crm-verification", "ipc"),
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

// The connector and its store are stubbed so this test pins the IPC wiring only.
class CrmError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "CrmError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const connectorStub = { CrmError, createCrmConnector: () => ({}) };
class CrmStoreStub {}

Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./crmConnector") return connectorStub;
    if (request === "./crmStore") return CrmStoreStub;
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
  target = { sessionId: "crm-ipc-test", crmConnector: {} };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args);

test("registers only the seven GoHighLevel CRM invoke channels", () => {
  const crmChannels = [...handlers.keys()].filter((channel) => channel.startsWith("crm-"));
  assert.deepEqual(crmChannels.sort(), [
    "crm-get-settings",
    "crm-get-sync-state",
    "crm-list-opportunities",
    "crm-save-settings",
    "crm-search-contacts",
    "crm-sync-note",
    "crm-test-connection",
  ]);
});

test("each channel calls its connector method and wraps the result in its key", async () => {
  const calls = [];
  const record =
    (name, value) =>
    async (...args) => {
      calls.push([name, ...args]);
      return value;
    };
  const settings = { configured: true, hasToken: true, locationId: "loc-1" };
  const contact = { id: "c-1", name: "Ada" };
  const opportunity = {
    id: "o-1",
    name: "Deal",
    status: "open",
    pipelineId: "p-1",
    pipelineStageId: "s-1",
  };
  const state = {
    noteId: "gn-1",
    contactId: "c-1",
    opportunityId: "o-1",
    syncedAt: "2026-10-07T00:00:00.000Z",
    url: "https://app.gohighlevel.com/v2/location/loc-1/contacts/detail/c-1",
  };
  Object.assign(target.crmConnector, {
    getSettings: record("getSettings", settings),
    saveSettings: record("saveSettings", settings),
    testConnection: record("testConnection", { locationName: "rTech" }),
    searchContacts: record("searchContacts", [contact]),
    listOpportunities: record("listOpportunities", [opportunity]),
    syncNote: record("syncNote", state),
    getSyncState: record("getSyncState", null),
  });

  const syncTarget = { contactId: "c-1", opportunityId: "o-1" };
  assert.deepEqual(await invoke("crm-get-settings"), { success: true, settings });
  assert.deepEqual(await invoke("crm-save-settings", { token: "pit" }), {
    success: true,
    settings,
  });
  assert.deepEqual(await invoke("crm-test-connection"), { success: true, locationName: "rTech" });
  assert.deepEqual(await invoke("crm-search-contacts", "Ada"), {
    success: true,
    contacts: [contact],
  });
  assert.deepEqual(await invoke("crm-list-opportunities", "c-1"), {
    success: true,
    opportunities: [opportunity],
  });
  assert.deepEqual(await invoke("crm-sync-note", 7, syncTarget), { success: true, state });
  assert.deepEqual(await invoke("crm-get-sync-state", 7), { success: true, state: null });
  assert.deepEqual(calls, [
    ["getSettings"],
    ["saveSettings", { token: "pit" }],
    ["testConnection"],
    ["searchContacts", "Ada"],
    ["listOpportunities", "c-1"],
    ["syncNote", 7, syncTarget],
    ["getSyncState", 7],
  ]);
});

test("unknown main-process failures are sanitized", async () => {
  target.crmConnector.searchContacts = async () => {
    throw new Error("upstream body included pit-secret and private details");
  };
  assert.deepEqual(await invoke("crm-search-contacts", "Ada"), {
    success: false,
    error: "CRM operation failed",
  });
  target.crmConnector.testConnection = async () => {
    throw new Error("pit-secret");
  };
  assert.deepEqual(await invoke("crm-test-connection"), {
    success: false,
    error: "CRM operation failed",
  });
});

test("CrmError code and status pass through without raw response data", async () => {
  const leakyToken = "fake-private-integration-token-marker";
  target.crmConnector.listOpportunities = async () => {
    const error = new CrmError("GoHighLevel rejected the token (401)", "AUTH_FAILED", 401);
    // A raw SDK failure can carry the response body and request headers; none may cross IPC.
    error.body = { message: "Invalid JWT", token: leakyToken };
    error.response = {
      status: 401,
      headers: { authorization: `Bearer ${leakyToken}` },
      data: { leakyToken },
    };
    throw error;
  };
  const envelope = await invoke("crm-list-opportunities", "c-1");
  assert.deepEqual(envelope, {
    success: false,
    error: "GoHighLevel rejected the token (401)",
    code: "AUTH_FAILED",
    status: 401,
  });
  assert.deepEqual(Object.keys(envelope).sort(), ["code", "error", "status", "success"]);
  assert.ok(!("body" in envelope));
  assert.ok(!("response" in envelope));
  assert.ok(!JSON.stringify(envelope).includes(leakyToken));
  target.crmConnector.syncNote = async () => {
    throw new CrmError("This note is linked to a different contact", "TARGET_CHANGED");
  };
  assert.deepEqual(await invoke("crm-sync-note", 7, { contactId: "c-2", opportunityId: "o" }), {
    success: false,
    error: "This note is linked to a different contact",
    code: "TARGET_CHANGED",
  });
});
