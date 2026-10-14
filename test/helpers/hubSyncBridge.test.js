// Hub transport: the real preload bridge wired to the
// real main-process hub bridge and cloud request handler, with only the network
// and the on-disk token file faked.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHubBridge, normalizeHubUrl } = require("../../src/helpers/hubSync");
const { createMain, loadPreloadApi } = require("./harness/hubBridge.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const hubMode = require("../../src/lib/hubMode.ts");
const accountScope = require("../../src/lib/authAccountScope.ts");

const DEVICE_KEY = "whk_device-key-secret-value";

const whoami = (status, body) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("hub URL normalization keeps a path prefix and rejects unusable URLs", () => {
  assert.equal(normalizeHubUrl(""), "");
  assert.equal(normalizeHubUrl("   "), "");
  assert.equal(normalizeHubUrl(undefined), "");
  assert.equal(normalizeHubUrl(" https://hub.example.test/ "), "https://hub.example.test");
  assert.equal(
    normalizeHubUrl("https://hub.example.test/whisper//"),
    "https://hub.example.test/whisper"
  );
  assert.equal(normalizeHubUrl("ftp://hub.example.test"), null);
  assert.equal(normalizeHubUrl("https://hub.example.test/?token=x"), null);
  assert.equal(normalizeHubUrl("https://user:pw@hub.example.test"), null);
  assert.equal(normalizeHubUrl("not a url"), null);
  assert.equal(normalizeHubUrl(42), null);
});

// D13: the hub URL is https://; plain http:// only for this machine.
test("#144: an https hub URL and a loopback http URL are accepted", () => {
  assert.equal(normalizeHubUrl("https://hub.example.test"), "https://hub.example.test");
  assert.equal(normalizeHubUrl("http://localhost:8787/"), "http://localhost:8787");
  assert.equal(normalizeHubUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeHubUrl("http://[::1]:8787"), "http://[::1]:8787");
});

test("#144: a LAN http hub URL is refused on save and the stored URL is unchanged", async () => {
  const main = createMain({ hubUrl: "https://hub.example.test" });
  const { api } = loadPreloadApi(main.handlers);

  for (const value of ["http://192.168.1.5", "http://192.168.1.5:8787/", "http://hub.lan"]) {
    const result = await api.hubSaveUrl(value);
    assert.equal(result.success, false, value);
    assert.equal(result.code, "INSECURE_HUB_URL", value);
  }
  assert.equal(normalizeHubUrl("http://10.0.0.5:8787"), null);
  assert.equal(await api.hubGetUrl(), "https://hub.example.test");
  assert.equal(await api.hubGetInsecureUrl(), "");
});

test("#144: a stored LAN http URL is hub off: no request, and Settings can name it", async (t) => {
  const main = createMain({ hubUrl: "http://192.168.1.5:8787" });
  const { api } = loadPreloadApi(main.handlers);
  resetBrowserGlobals();
  installBrowserGlobals();
  hubMode.resetHubModeForTests();
  windowStub.electronAPI = api;
  t.after(() => {
    hubMode.resetHubModeForTests();
    resetBrowserGlobals();
  });
  const { generation } = (await api.hubSetDeviceKey(DEVICE_KEY)) ?? {};

  assert.equal(await api.hubGetUrl(), "", "the stored URL reads as hub off");
  assert.equal(await api.hubGetInsecureUrl(), "http://192.168.1.5:8787");
  assert.equal(await hubMode.refreshHubMode(), false);
  const res = await api.cloudApiRequest({
    path: "/api/notes/list",
    expectedAuthGeneration: generation,
  });
  assert.equal(res.success, false);
  assert.equal(main.fetches.length, 0, "nothing is sent over plain http");
});

test("cloud-api-request resolves the hub URL at request time, not at startup", async () => {
  const main = createMain({ respond: whoami(200, { device: { id: "d1", name: "mac" } }) });
  const { api } = loadPreloadApi(main.handlers);
  const { generation } = (await api.hubSetDeviceKey(DEVICE_KEY)) ?? {};

  const off = await api.cloudApiRequest({
    path: "/api/whoami",
    expectedAuthGeneration: generation,
  });
  assert.equal(off.success, false);
  assert.equal(main.fetches.length, 0, "an empty hub URL means sync is off: no request");

  assert.deepEqual(await api.hubSaveUrl("https://hub-a.example.test/"), {
    success: true,
    url: "https://hub-a.example.test",
  });
  await api.cloudApiRequest({ path: "/api/whoami", expectedAuthGeneration: generation });
  await api.hubSaveUrl("https://hub-b.example.test/base");
  await api.cloudApiRequest({ path: "/api/whoami", expectedAuthGeneration: generation });

  assert.deepEqual(
    main.fetches.map((f) => f.url),
    ["https://hub-a.example.test/api/whoami", "https://hub-b.example.test/base/api/whoami"]
  );
  assert.equal(main.fetches[0].init.headers.Authorization, `Bearer ${DEVICE_KEY}`);
});

test("an invalid hub URL is refused and the stored URL is unchanged", async () => {
  const main = createMain({ hubUrl: "https://hub.example.test" });
  const { api } = loadPreloadApi(main.handlers);

  const result = await api.hubSaveUrl("javascript:alert(1)");

  assert.equal(result.success, false);
  assert.equal(result.code, "INVALID_HUB_URL");
  assert.equal(await api.hubGetUrl(), "https://hub.example.test");
});

test("whoami through the bridge maps success to the device name", async () => {
  const main = createMain({
    hubUrl: "https://hub.example.test",
    respond: whoami(200, { device: { id: "dev-1", name: "Rico's MacBook" } }),
  });
  const { api } = loadPreloadApi(main.handlers);
  installBrowserGlobals();
  windowStub.electronAPI = api;
  await api.hubSetDeviceKey(DEVICE_KEY);
  const { testHubConnection } = await import("../../src/services/hubConnection.ts");

  const result = await testHubConnection();

  assert.deepEqual(result, { ok: true, deviceName: "Rico's MacBook", deviceId: "dev-1" });
  assert.equal(main.fetches.length, 1);
  assert.equal(main.fetches[0].url, "https://hub.example.test/api/whoami");
  assert.equal(main.fetches[0].init.method, "GET");
  assert.equal(main.fetches[0].init.headers.Authorization, `Bearer ${DEVICE_KEY}`);
  resetBrowserGlobals();
});

test("whoami through the bridge maps 401 to unauthorized", async () => {
  const main = createMain({
    hubUrl: "https://hub.example.test",
    respond: whoami(401, { error: "unauthorized" }),
  });
  const { api } = loadPreloadApi(main.handlers);
  installBrowserGlobals();
  windowStub.electronAPI = api;
  await api.hubSetDeviceKey("revoked-key");
  const { testHubConnection } = await import("../../src/services/hubConnection.ts");

  assert.deepEqual(await testHubConnection(), { ok: false, reason: "unauthorized" });
  resetBrowserGlobals();
});

test("whoami is not attempted without a URL or a key", async () => {
  const { testHubConnection } = await import("../../src/services/hubConnection.ts");
  installBrowserGlobals();

  const noUrl = createMain();
  windowStub.electronAPI = loadPreloadApi(noUrl.handlers).api;
  await windowStub.electronAPI.hubSetDeviceKey(DEVICE_KEY);
  assert.deepEqual(await testHubConnection(), { ok: false, reason: "noUrl" });

  const noKey = createMain({ hubUrl: "https://hub.example.test" });
  windowStub.electronAPI = loadPreloadApi(noKey.handlers).api;
  assert.deepEqual(await testHubConnection(), { ok: false, reason: "noKey" });

  assert.equal(noUrl.fetches.length + noKey.fetches.length, 0);
  resetBrowserGlobals();
});

test("no hub key IPC ever returns the device key to the renderer", async () => {
  const main = createMain({ hubUrl: "https://hub.example.test" });
  const { api, invocations } = loadPreloadApi(main.handlers);

  const set = await api.hubSetDeviceKey(`  ${DEVICE_KEY}  `);
  const state = await api.hubGetDeviceKeyState();
  const cleared = await api.hubClearDeviceKey();
  const after = await api.hubGetDeviceKeyState();
  const rejected = await api.hubSetDeviceKey("   ");

  assert.deepEqual(set, { success: true, hasKey: true, generation: 1 });
  assert.deepEqual(state, { hasKey: true, generation: 1 });
  assert.deepEqual(cleared, { success: true, hasKey: false, generation: 2 });
  assert.deepEqual(after, { hasKey: false, generation: 2 });
  assert.equal(rejected.success, false);
  // The key was stored trimmed, and nothing the renderer received contains it.
  assert.equal(invocations.length, 5);
  for (const { result } of invocations) {
    assert.equal(JSON.stringify(result).includes(DEVICE_KEY), false);
  }
  // The preload exposes no getter for the key itself.
  for (const name of Object.keys(api)) {
    assert.equal(/hub.*get.*key$/i.test(name), false, name);
  }
});

// Step 4: hub mode (URL + device key) opens the sync consent gate, and bypasses
// the account-scope reconcile whose "purge" deletes local rows.
function enterHub(t, { hubUrl = "https://hub.example.test" } = {}) {
  const main = createMain({ hubUrl });
  const { api, invocations } = loadPreloadApi(main.handlers);
  resetBrowserGlobals();
  installBrowserGlobals();
  hubMode.resetHubModeForTests();
  windowStub.electronAPI = api;
  t.after(() => {
    hubMode.resetHubModeForTests();
    resetBrowserGlobals();
  });
  return { main, api, invocations };
}

const DESTRUCTIVE_CHANNEL = /delete|purge|clear-?all|wipe/i;

test("hub mode on (URL and key) gives backup consent", async (t) => {
  const { api } = enterHub(t);
  await api.hubSetDeviceKey(DEVICE_KEY);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();

  assert.equal(await hubMode.refreshHubMode(), true);
  assert.equal(service.canSync(), true);
  // No sign-in flag was written to get there.
  assert.equal(localStorage.getItem("isSignedIn"), null);
});

test("hub mode off gives no consent: URL alone, key alone, or neither", async (t) => {
  const { SyncService } = require("../../src/services/SyncService.ts");
  const urlOnly = enterHub(t);
  assert.equal(await hubMode.refreshHubMode(), false);
  assert.equal(new SyncService().canSync(), false);

  const keyOnly = enterHub(t, { hubUrl: "" });
  await keyOnly.api.hubSetDeviceKey(DEVICE_KEY);
  assert.equal(await hubMode.refreshHubMode(), false);
  assert.equal(new SyncService().canSync(), false);
  assert.equal(urlOnly.main.fetches.length + keyOnly.main.fetches.length, 0);
});

test("in hub mode the account-scope reconcile never runs and keeps its keys", async (t) => {
  const { api } = enterHub(t);
  await api.hubSetDeviceKey(DEVICE_KEY);
  // A state that WOULD purge: a previous user who is now gone.
  localStorage.setItem("openwhispr:accountScopeUserId", "old-user");
  localStorage.setItem("openwhispr:accountScopeValidated", "true");
  localStorage.setItem("isSignedIn", "true");
  assert.equal(accountScope.getAccountScopeAction(null), "purge");
  await hubMode.refreshHubMode();
  let purges = 0;
  let verifies = 0;

  await accountScope.reconcileAccountScope(null, {
    purge: async () => void (purges += 1),
    verify: async () => void (verifies += 1),
  });

  assert.equal(purges + verifies, 0);
  assert.equal(localStorage.getItem("openwhispr:accountScopeUserId"), "old-user");
  assert.equal(localStorage.getItem("openwhispr:accountScopePurgeRequired"), null);
});

test("clearing the key turns sync off and deletes nothing", async (t) => {
  const { api, invocations } = enterHub(t);
  await api.hubSetDeviceKey(DEVICE_KEY);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  assert.equal(await hubMode.refreshHubMode(), true);
  assert.equal(service.canSync(), true);

  await api.hubClearDeviceKey();

  assert.equal(await hubMode.refreshHubMode(), false);
  assert.equal(service.canSync(), false);
  assert.equal(
    invocations.some(({ channel }) => DESTRUCTIVE_CHANNEL.test(channel)),
    false,
    "turning hub mode off invoked a destructive channel"
  );
});

// Part 3: the main window starts auto-sync, and a hub settings change asks for
// a pass once hub mode is on. Rendering MainApp needs the whole renderer, so
// the startup call is pinned in source.
const fs = require("node:fs");
const path = require("node:path");

test("the main window's startup starts auto-sync", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/AppRouter.jsx"), "utf8");
  const mainApp = source.slice(source.indexOf("function MainApp()"));
  assert.match(mainApp, /syncService\.startAutoSync\(\)/);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("hub mode off: a requested pass makes no cloud-api-request call", async (t) => {
  const { invocations } = enterHub(t);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  assert.equal(await hubMode.refreshHubMode(), false);

  service.requestSyncAll("manual");
  await settle();

  assert.equal(
    invocations.some(({ channel }) => channel === "cloud-api-request"),
    false,
    "hub mode off still reached the cloud request bridge"
  );
});

test("startAutoSync reads hub mode before its first kick", async (t) => {
  const { api } = enterHub(t);
  await api.hubSetDeviceKey(DEVICE_KEY);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  const reasons = [];
  service.requestSyncAll = (reason) => reasons.push([reason, hubMode.isHubMode()]);

  service.startAutoSync();
  await settle();

  assert.deepEqual(reasons, [["start", true]]);
});

test("saving a key with a URL present requests a manual pass", async (t) => {
  const { api } = enterHub(t);
  const { onHubSettingsChanged } = await import("../../src/services/hubConnection.ts");
  const reasons = [];
  const sync = { requestSyncAll: (reason) => reasons.push(reason) };

  assert.equal(await onHubSettingsChanged(sync), false);
  assert.deepEqual(reasons, [], "URL alone is not hub mode: no pass");

  await api.hubSetDeviceKey(DEVICE_KEY);
  assert.equal(await onHubSettingsChanged(sync), true);
  assert.deepEqual(reasons, ["manual"]);

  await api.hubClearDeviceKey();
  assert.equal(await onHubSettingsChanged(sync), false);
  assert.deepEqual(reasons, ["manual"], "clearing the key requests nothing");
  assert.equal(hubMode.isHubMode(), false);
});

// Part 4: every trigger re-reads hub mode, so a hub URL or key change made in
// another window (straight through the bridge, no onHubSettingsChanged in this
// one) takes effect here without a restart.
// Records each pass started; runPass keeps the real pass so its requests show.
function countPasses(service, { runPass = false } = {}) {
  const passes = [];
  const syncAll = service.syncAll.bind(service);
  service.syncAll = (...args) => {
    passes.push(hubMode.isHubMode());
    return runPass ? syncAll(...args) : Promise.resolve();
  };
  return passes;
}

test("hub mode turned on in another window: the next focus trigger starts a pass", async (t) => {
  const { api } = enterHub(t);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  const passes = countPasses(service);
  assert.equal(await hubMode.refreshHubMode(), false);

  await api.hubSetDeviceKey(DEVICE_KEY);
  service.requestSyncAll("focus");
  await settle();

  assert.deepEqual(passes, [true], "the focus trigger ran on a stale hub-mode-off cache");
});

test("hub mode turned off in another window: the next interval trigger makes no request", async (t) => {
  const { api, invocations } = enterHub(t);
  await api.hubSetDeviceKey(DEVICE_KEY);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  const passes = countPasses(service, { runPass: true });
  assert.equal(await hubMode.refreshHubMode(), true);

  await api.hubClearDeviceKey();
  service.requestSyncAll("interval");
  await settle();

  assert.deepEqual(passes, [], "the interval trigger ran on a stale hub-mode-on cache");
  assert.equal(
    invocations.some(({ channel }) => channel === "cloud-api-request"),
    false,
    "hub mode off still reached the cloud request bridge"
  );
});

test("the hub mode re-read is throttled: two triggers within 5 s read once", async (t) => {
  const { invocations } = enterHub(t);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  const urlReads = () => invocations.filter(({ channel }) => channel === "hub-get-url").length;

  service.requestSyncAll("focus");
  await settle();
  service.requestSyncAll("interval");
  await settle();

  assert.equal(urlReads(), 1);
});

// TokenStore.clear() keeps the key when the key file
// could not be removed or overwritten, and the bridge reports the store's
// state, so the reply and every later read agree (the real store is covered in
// tokenStoreHubKey.test.js).
// A guard on the bridge reply, not a regression proof for the failed-clear fix: the fake store
// hard-codes clear() and getState().
test("guard: a failed key clear reports the key as still stored", () => {
  const bridge = createHubBridge({
    getHubUrl: () => "https://hub.example.test",
    saveHubUrl() {},
    tokenStore: {
      getState: () => ({ token: "whk_still-on-disk", generation: 4 }),
      clear: () => ({ success: false, token: "whk_still-on-disk", generation: 4 }),
    },
    getAppVersion: () => "0.0.0",
    proxyFetch: async () => new Response("{}"),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  assert.deepEqual(bridge.clearKey(), { success: false, hasKey: true, generation: 4 });
  assert.deepEqual(bridge.getKeyState(), { hasKey: true, generation: 4 });
});
