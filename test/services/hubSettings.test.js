// Hub settings and key rejection (review of the hub-mode merges):
// #129 a hub 401 is recorded for the key and backs ambient passes off,
// #133 blurring the URL field never saves before load or without a change,
// #136 a failed key save keeps the draft.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  installBrowserGlobals,
  resetBrowserGlobals,
  stopSyncTimers,
  dispatchWindowEvent,
  windowListenerCount,
  window: windowStub,
} = require("../helpers/harness/browserGlobals.js");
const hubMode = require("../../src/lib/hubMode.ts");
const { cloudGet } = require("../../src/services/cloudApi.ts");
const {
  INITIAL_HUB_SETTINGS_FORM,
  hubSettingsReducer,
  hubSettingsLoadEvent,
  clearHubDeviceKey,
  hubUrlNeedsSave,
  onHubSettingsChanged,
  loadHubSettings,
  readHubKeyRejected,
  saveHubDeviceKey,
  saveHubUrl,
  testHubConnection,
} = require("../../src/services/hubConnection.ts");

installBrowserGlobals();

function enterHubMode(t, generation = 3) {
  resetBrowserGlobals();
  installBrowserGlobals();
  hubMode.setHubModeState({ hasUrl: true, hasKey: true, generation });
  t.after(() => hubMode.resetHubModeForTests());
}

test("#129: a hub 401 marks the current key rejected until a success", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = {
    cloudApiRequest: async () => ({ success: false, status: 401, code: "AUTH_EXPIRED" }),
  };
  await assert.rejects(cloudGet("/api/notes/list"));
  assert.equal(hubMode.isHubAuthRejected(), true);
  assert.equal(hubMode.isHubAuthBackingOff(), true);
  assert.equal(hubMode.isHubAuthBackingOff(Date.now() + hubMode.HUB_AUTH_BACKOFF_MS + 1), false);

  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: true, data: {} }) };
  await cloudGet("/api/notes/list");
  assert.equal(hubMode.isHubAuthRejected(), false);
});

test("#129: a new device key is not held back by the old key's rejection", async (t) => {
  enterHubMode(t, 3);
  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  hubMode.setHubModeState({ hasUrl: true, hasKey: true, generation: 4 });
  assert.equal(hubMode.isHubAuthRejected(), false);
  assert.equal(hubMode.isHubAuthBackingOff(), false);
});

test("#129: ambient passes skip while the key is rejected; manual passes still run", async (t) => {
  enterHubMode(t);
  const { SyncService } = require("../../src/services/SyncService.ts");
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  let passes = 0;
  service.canSync = () => true;
  service.syncAll = async () => void (passes += 1);

  service.requestSyncAllNow("focus");
  assert.equal(passes, 1, "no rejection: the ambient pass runs");

  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  localStorage.removeItem("lastSyncedAt");
  service.requestSyncAllNow("focus");
  service.requestSyncAllNow("interval");
  assert.equal(passes, 1, "a rejected key holds ambient passes back");
  service.requestSyncAllNow("manual");
  assert.equal(passes, 2, "a manual pass is never held back");
});

test("#133: the URL field saves only after load and only on a change", () => {
  assert.equal(hubUrlNeedsSave(null, ""), false, "blur before load must not store off");
  assert.equal(hubUrlNeedsSave("https://hub.example", "https://hub.example"), false);
  assert.equal(hubUrlNeedsSave("https://hub.example", ""), true, "clearing it is a change");
  assert.equal(hubUrlNeedsSave("", "https://hub.example"), true);
});

test("#136: a refused or failed key save reports not saved", async (t) => {
  resetBrowserGlobals();
  installBrowserGlobals();
  windowStub.electronAPI = {
    hubSetDeviceKey: async () => ({ success: false, hasKey: false, generation: 1 }),
  };
  assert.deepEqual(await saveHubDeviceKey("whk_x"), { saved: false, hasKey: null });

  windowStub.electronAPI = {
    hubSetDeviceKey: async () => {
      throw new Error("ipc down");
    },
  };
  assert.deepEqual(await saveHubDeviceKey("whk_x"), { saved: false, hasKey: null });

  windowStub.electronAPI = {
    hubSetDeviceKey: async () => ({ success: true, hasKey: true, generation: 2 }),
  };
  assert.deepEqual(await saveHubDeviceKey("whk_x"), { saved: true, hasKey: true });
  t.after(() => resetBrowserGlobals());
});

// A stand-in for the main process's device-key store, numbering generations
// as tokenStore does (rtech-whisper#208): saving a different key or clearing
// is a new generation; re-saving the stored key keeps it.
function keyStore(generation) {
  const state = { hasKey: true, generation };
  let key = "whk_old";
  return {
    hubGetUrl: async () => "https://hub.example",
    hubGetDeviceKeyState: async () => ({ ...state }),
    hubSetDeviceKey: async (draft) => {
      if (draft === key) return { success: true, ...state };
      key = draft;
      state.hasKey = true;
      state.generation += 1;
      return { success: true, ...state };
    },
    hubClearDeviceKey: async () => {
      key = "";
      state.hasKey = false;
      state.generation += 1;
      return { success: true, ...state };
    },
    cloudApiRequest: async () => ({ success: false, status: 401 }),
  };
}

// rtech-whisper#164: the save and clear paths the settings page runs
// (saveHubDeviceKey or clearHubDeviceKey, then onHubSettingsChanged). Both
// clear the rejection directly (#215): saveHubDeviceKey when the generation
// changed, clearHubDeviceKey when no key is left. The generation check pins the
// fence that re-reads hub mode.
test("#129: saving a new key lifts the old key's rejection through its new generation", async (t) => {
  enterHubMode(t, 3);
  windowStub.electronAPI = keyStore(3);
  await assert.rejects(cloudGet("/api/notes/list"));
  assert.equal(await readHubKeyRejected(), true);

  await saveHubDeviceKey("whk_old");
  assert.equal(await readHubKeyRejected(), true, "re-saving the stored key keeps its verdict");

  const requested = [];
  assert.deepEqual(await saveHubDeviceKey("whk_new"), { saved: true, hasKey: true });
  assert.equal(localStorage.getItem("hubSync.authRejected"), null, "the record is removed");
  assert.equal(await onHubSettingsChanged({ requestSyncAll: (r) => requested.push(r) }), true);

  assert.equal(hubMode.getHubModeGeneration(), 4, "hub mode re-reads the new key's generation");
  assert.equal(hubMode.isHubAuthRejected(), false);
  assert.equal(hubMode.isHubAuthBackingOff(), false, "ambient passes are not held back");
  assert.equal(await readHubKeyRejected(), false, "the settings row stops saying rejected");
  assert.deepEqual(requested, ["manual"], "the new key syncs at once");
});

test("#129: clearing the key leaves no rejected key behind", async (t) => {
  enterHubMode(t, 3);
  const api = keyStore(3);
  windowStub.electronAPI = api;
  await assert.rejects(cloudGet("/api/notes/list"));
  assert.equal(hubMode.isHubAuthRejected(), true);

  assert.equal(await clearHubDeviceKey(), false);
  assert.equal(localStorage.getItem("hubSync.authRejected"), null, "the record is removed");
  assert.equal(await onHubSettingsChanged({ requestSyncAll: () => assert.fail("no sync") }), false);

  assert.equal(hubMode.getHubModeGeneration(), null, "hub mode is off without a key");
  assert.equal(hubMode.isHubAuthRejected(), false);
  assert.equal(hubMode.isHubAuthBackingOff(), false);
  assert.equal(await readHubKeyRejected(), false);
});

test("#129: clearHubAuthRejection drops the record and notifies subscribers", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  assert.equal(hubMode.isHubAuthRejected(), true);
  let changes = 0;
  t.after(hubMode.subscribeHubAuthRejection(() => void (changes += 1)));
  hubMode.clearHubAuthRejection();
  assert.equal(hubMode.isHubAuthRejected(), false);
  assert.equal(changes, 1);
});

// rtech-whisper#178: another window's 401 or success reaches this one only
// through the storage event.
test("#129: a storage event for the rejection key notifies subscribers; others do not", (t) => {
  enterHubMode(t);
  let changes = 0;
  const unsubscribe = hubMode.subscribeHubAuthRejection(() => void (changes += 1));
  assert.equal(windowListenerCount("storage"), 1, "subscribing listens for storage events");

  dispatchWindowEvent("storage", { key: "hubSync.authRejected" });
  assert.equal(changes, 1, "a change to the rejection record in another window notifies");
  dispatchWindowEvent("storage", { key: "other" });
  assert.equal(changes, 1, "an unrelated key does not");
  dispatchWindowEvent("storage", { key: null });
  assert.equal(changes, 2, "localStorage.clear() in another window (key null) notifies");

  unsubscribe();
  assert.equal(windowListenerCount("storage"), 0, "unsubscribe removes the storage listener");
  dispatchWindowEvent("storage", { key: "hubSync.authRejected" });
  assert.equal(changes, 2, "no notification after unsubscribe");
});

test("#129: a rejection recorded after mount reaches subscribers, and a success clears it live", async (t) => {
  enterHubMode(t, 5);
  let changes = 0;
  const unsubscribe = hubMode.subscribeHubAuthRejection(() => void (changes += 1));
  t.after(unsubscribe);
  windowStub.electronAPI = {
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 5 }),
    cloudApiRequest: async () => ({ success: false, status: 401 }),
  };
  await assert.rejects(cloudGet("/api/notes/list"));
  assert.equal(changes, 1, "the 401 from a sync pass notifies the settings page");
  assert.equal(await readHubKeyRejected(), true);

  windowStub.electronAPI.cloudApiRequest = async () => ({ success: true, data: {} });
  await cloudGet("/api/notes/list");
  assert.equal(changes, 2, "a later success notifies too");
  assert.equal(await readHubKeyRejected(), false);
});

test("#129: Test's whoami answer records and clears the rejection", async (t) => {
  enterHubMode(t, 6);
  windowStub.electronAPI = {
    hubGetUrl: async () => "https://hub.example",
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 6 }),
    cloudApiRequest: async () => ({ success: false, status: 401 }),
  };
  assert.equal((await testHubConnection()).reason, "unauthorized");
  assert.equal(hubMode.isHubAuthRejected(), true, "a Test 401 records the rejection");
  assert.equal(hubMode.isHubAuthBackingOff(), true);

  windowStub.electronAPI.cloudApiRequest = async () => ({
    success: true,
    data: { device: { id: "d1", name: "Mac" } },
  });
  assert.equal((await testHubConnection()).ok, true);
  assert.equal(hubMode.isHubAuthRejected(), false, "a Test success lifts the rejection");
  assert.equal(hubMode.isHubAuthBackingOff(), false, "and the ambient backoff with it");
});

test("#129: the rejected state is judged by the key's current generation", async (t) => {
  enterHubMode(t, 7);
  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  windowStub.electronAPI.hubGetDeviceKeyState = async () => ({ hasKey: true, generation: 8 });
  assert.equal(await readHubKeyRejected(), false, "a newly saved key is not the rejected one");
  windowStub.electronAPI.hubGetDeviceKeyState = async () => ({ hasKey: true, generation: 7 });
  assert.equal(await readHubKeyRejected(), true);
});

test("#176: a failing localStorage write still surfaces the 401", async (t) => {
  enterHubMode(t, 12);
  const { setItem } = localStorage;
  t.after(() => (localStorage.setItem = setItem));
  localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  windowStub.electronAPI = {
    hubGetUrl: async () => "https://hub.example",
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 12 }),
    cloudApiRequest: async () => ({ success: false, status: 401 }),
  };
  await assert.rejects(cloudGet("/api/notes/list"), (err) => err.status === 401);
  assert.equal((await testHubConnection()).reason, "unauthorized");
});

test("#188: Test records the 401 against the key it sent, not the hub-mode generation", async (t) => {
  enterHubMode(t, 3);
  hubMode.resetHubModeForTests();
  windowStub.electronAPI = {
    hubGetUrl: async () => "https://hub.example",
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 9 }),
    cloudApiRequest: async () => ({ success: false, status: 401 }),
  };
  assert.equal((await testHubConnection()).reason, "unauthorized");
  assert.equal(hubMode.isHubAuthRejected(9), true);
});

test("#148: a failed settings load unlocks the URL field and reports the failure", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = {
    hubGetUrl: async () => {
      throw new Error("ipc down");
    },
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 3 }),
  };
  assert.deepEqual(await loadHubSettings(), {
    url: "",
    hasKey: true,
    keyUnknown: false,
    failed: true,
    insecure: false,
  });
  windowStub.electronAPI.hubGetUrl = async () => "https://hub.example";
  assert.deepEqual(await loadHubSettings(), {
    url: "https://hub.example",
    hasKey: true,
    keyUnknown: false,
    failed: false,
    insecure: false,
  });

  let form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, { type: "loadFailed", hasKey: true });
  assert.equal(form.savedUrl, "", "the field is editable");
  assert.equal(form.urlError, "loadFailed");
});

test("#149: clearing the key or editing the draft drops a stale key-save error", () => {
  const failed = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, {
    type: "keySaved",
    saved: false,
    hasKey: null,
  });
  assert.equal(failed.keyError, true);
  assert.equal(hubSettingsReducer(failed, { type: "keyCleared", hasKey: false }).keyError, false);
  assert.equal(hubSettingsReducer(failed, { type: "keyEdited", value: "whk_y" }).keyError, false);
});

test("#167: editing the URL after a failed save drops the stale error", () => {
  let form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, {
    type: "loaded",
    url: "https://hub.example",
    hasKey: true,
  });
  form = hubSettingsReducer(form, { type: "urlEdited", value: "not a url" });
  form = hubSettingsReducer(form, { type: "urlSaved", success: false });
  assert.equal(form.urlError, "invalid");
  form = hubSettingsReducer(form, { type: "urlEdited", value: "https://hub.example" });
  assert.equal(form.urlError, null, "retyping the stored URL leaves no error behind");
  assert.equal(hubUrlNeedsSave(form.savedUrl, form.hubUrl), false);
});

test("#175: saving a different hub URL clears the auth rejection; the same URL keeps it", async (t) => {
  enterHubMode(t, 13);
  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  windowStub.electronAPI.hubSaveUrl = async (value) => ({ success: true, url: value });

  assert.deepEqual(await saveHubUrl("https://a.example", "https://a.example"), {
    success: true,
    url: "https://a.example",
  });
  assert.equal(hubMode.isHubAuthRejected(), true, "the same hub keeps its verdict");
  await saveHubUrl("https://b.example", "https://a.example");
  assert.equal(hubMode.isHubAuthRejected(), false, "a new hub has not rejected the key");
});

test("#187: re-saving the same key keeps its rejection; a new key clears it", async (t) => {
  enterHubMode(t, 14);
  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  let generation = 14;
  windowStub.electronAPI.hubGetDeviceKeyState = async () => ({ hasKey: true, generation });
  windowStub.electronAPI.hubSetDeviceKey = async (key) => {
    if (key !== "whk_same") generation += 1;
    return { success: true, hasKey: true, generation };
  };

  assert.deepEqual(await saveHubDeviceKey("whk_same"), { saved: true, hasKey: true });
  assert.equal(hubMode.isHubAuthRejected(14), true, "an identical key is still rejected");
  await saveHubDeviceKey("whk_new");
  assert.equal(hubMode.isHubAuthRejected(14), false, "a replaced key forgets the rejection");
});

const needsSave = (form) => hubUrlNeedsSave(form.savedUrl, form.hubUrl, form.urlUnknown);

test("#200: a URL load failure keeps a loaded key state and lets an edited empty field save", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = {
    hubGetUrl: async () => {
      throw new Error("ipc down");
    },
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 3 }),
  };
  const loaded = await loadHubSettings();
  assert.equal(loaded.failed, true);
  assert.equal(loaded.hasKey, true, "the key state that did load still shows Clear key");

  let form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, { type: "loadFailed", hasKey: true });
  assert.equal(form.hasKey, true);
  assert.equal(needsSave(form), false, "a blur alone never stores off");
  form = hubSettingsReducer(form, { type: "urlEdited", value: "x" });
  form = hubSettingsReducer(form, { type: "urlEdited", value: "" });
  assert.equal(needsSave(form), true, "an emptied field can store off");
  form = hubSettingsReducer(form, { type: "urlSaved", success: true, url: "" });
  assert.equal(needsSave(form), false, "once saved, the stored URL is known");
});

test("#201: re-entering the stored URL after a load failure keeps the rejection", async (t) => {
  enterHubMode(t, 17);
  windowStub.electronAPI = { cloudApiRequest: async () => ({ success: false, status: 401 }) };
  await assert.rejects(cloudGet("/api/notes/list"));
  let stored = "https://a.example";
  windowStub.electronAPI.hubGetUrl = async () => stored;
  windowStub.electronAPI.hubSaveUrl = async (value) => (
    (stored = value),
    { success: true, url: value }
  );

  await saveHubUrl("https://a.example", null);
  assert.equal(hubMode.isHubAuthRejected(), true, "the same hub keeps its verdict");
  await saveHubUrl("https://b.example", null);
  assert.equal(hubMode.isHubAuthRejected(), false, "a new hub has not rejected the key");
});

// The simplified rule (stop rule on the #217 review): a 401 records the
// rejection at arrival, a same-generation success clears it. Stale-response
// races are accepted (bounded by one pass or one backoff window).
test("#217: a 401 records the rejection at its arrival time", (t) => {
  enterHubMode(t, 20);
  const before = Date.now();
  hubMode.noteHubAuthResult({ success: false, status: 401 });
  const record = JSON.parse(localStorage.getItem("hubSync.authRejected"));
  assert.equal(record.generation, 20);
  assert.ok(record.at >= before && record.at <= Date.now(), "at is the arrival time");
  assert.equal(hubMode.isHubAuthRejected(), true);
  assert.equal(hubMode.isHubAuthBackingOff(), true);
});

test("#217: a success with the same generation clears the rejection", (t) => {
  enterHubMode(t, 21);
  hubMode.noteHubAuthResult({ success: false, status: 401 });
  hubMode.noteHubAuthResult({ success: true });
  assert.equal(localStorage.getItem("hubSync.authRejected"), null);
  assert.equal(hubMode.isHubAuthRejected(), false);
});

test("#217: a success for an older generation keeps a newer generation's rejection", (t) => {
  enterHubMode(t, 23);
  hubMode.noteHubAuthResult({ success: false, status: 401 }, 23);
  hubMode.noteHubAuthResult({ success: true }, 22);
  assert.equal(
    hubMode.isHubAuthRejected(23),
    true,
    "the old key's success says nothing of the new key"
  );
  assert.equal(hubMode.isHubAuthBackingOff(), true);
});

test("#177: a rejection stamped in the future is not treated as backing off", (t) => {
  enterHubMode(t, 24);
  localStorage.setItem(
    "hubSync.authRejected",
    JSON.stringify({ generation: 24, at: Date.now() + 60 * 60_000 })
  );
  assert.equal(hubMode.isHubAuthRejected(), true);
  assert.equal(hubMode.isHubAuthBackingOff(), false);
  const now = Date.now();
  localStorage.setItem("hubSync.authRejected", JSON.stringify({ generation: 24, at: now }));
  assert.equal(hubMode.isHubAuthBackingOff(now), true);
  assert.equal(hubMode.isHubAuthBackingOff(now - 60_000), false);
});

test("#221: clearing the key keeps the rejection while a key is still stored", async (t) => {
  enterHubMode(t, 25);
  hubMode.noteHubAuthResult({ success: false, status: 401 });
  windowStub.electronAPI = {
    // A failed clear still bumps the generation of the unchanged key (#233).
    hubClearDeviceKey: async () => ({ success: false, hasKey: true, generation: 26 }),
    hubGetUrl: async () => "https://hub.example",
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 26 }),
  };
  assert.equal(await clearHubDeviceKey(), true);
  assert.equal(await hubMode.refreshHubMode(), true);
  assert.equal(hubMode.isHubAuthRejected(), true, "a still-stored key keeps its verdict");
  assert.equal(hubMode.isHubAuthBackingOff(), true, "and its backoff");

  windowStub.electronAPI.hubClearDeviceKey = async () => {
    throw new Error("ipc down");
  };
  await assert.rejects(clearHubDeviceKey());
  assert.equal(hubMode.isHubAuthRejected(), true, "a failed clear keeps the verdict");
});

test("#220 #229: a failed key-state read keeps Clear key and says the state is unknown", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = {
    hubGetUrl: async () => "https://hub.example",
    hubGetDeviceKeyState: async () => {
      throw new Error("ipc down");
    },
  };
  const loaded = await loadHubSettings();
  assert.deepEqual(loaded, {
    url: "https://hub.example",
    hasKey: true,
    keyUnknown: true,
    failed: false,
    insecure: false,
  });
  let form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, { type: "loaded", ...loaded });
  assert.equal(form.hasKey, true, "Clear key stays available");
  assert.equal(form.keyUnknown, true, "the row does not claim a saved key");
  form = hubSettingsReducer(form, { type: "keyCleared", hasKey: false });
  assert.equal(form.keyUnknown, false, "a clear answer makes the state known");
});

test("#144: a refused LAN http URL and a stored one both show the https message", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = {
    hubGetUrl: async () => "https://hub.example",
    hubSaveUrl: async () => ({ success: false, code: "INSECURE_HUB_URL", error: "x" }),
  };
  const saved = await saveHubUrl("http://192.168.1.5", "https://hub.example");
  assert.equal(saved.success, false);
  let form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, {
    type: "loaded",
    url: "https://hub.example",
    hasKey: true,
  });
  form = hubSettingsReducer(form, { type: "urlEdited", value: "http://192.168.1.5" });
  form = hubSettingsReducer(form, { type: "urlSaved", ...saved });
  assert.equal(form.urlError, "insecure");
  form = hubSettingsReducer(form, { type: "urlSaved", success: false });
  assert.equal(form.urlError, "invalid", "any other refusal keeps the generic message");

  windowStub.electronAPI = {
    hubGetUrl: async () => "",
    hubGetInsecureUrl: async () => "http://192.168.1.5:8787",
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 3 }),
  };
  const loaded = await loadHubSettings();
  assert.equal(loaded.url, "http://192.168.1.5:8787", "the field shows what is stored");
  assert.equal(loaded.insecure, true);
  form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, { type: "loaded", ...loaded });
  assert.equal(form.urlError, "insecure");
  assert.equal(hubUrlNeedsSave(form.savedUrl, form.hubUrl), false, "a blur alone saves nothing");
});

test("#144: the page load event carries insecure, so a stored http URL shows the https message", async (t) => {
  enterHubMode(t);
  windowStub.electronAPI = {
    hubGetUrl: async () => "",
    hubGetInsecureUrl: async () => "http://192.168.1.5:8787",
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 3 }),
  };
  const event = hubSettingsLoadEvent(await loadHubSettings());
  assert.equal(event.type, "loaded");
  assert.equal(event.insecure, true);
  const form = hubSettingsReducer(INITIAL_HUB_SETTINGS_FORM, event);
  assert.equal(form.hubUrl, "http://192.168.1.5:8787");
  assert.equal(form.urlError, "insecure");

  windowStub.electronAPI = {
    hubGetUrl: async () => {
      throw new Error("ipc down");
    },
    hubGetDeviceKeyState: async () => ({ hasKey: true, generation: 3 }),
  };
  const failedEvent = hubSettingsLoadEvent(await loadHubSettings());
  assert.deepEqual(failedEvent, { type: "loadFailed", hasKey: true, keyUnknown: false });
});
