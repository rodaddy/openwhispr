// Hub by default: a Mac that never set a hub URL uses the
// build's RTECH_WHISPER_HUB_URL; an explicit empty save still means off.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultHubUrl,
  readHubUrlSetting,
  hubUrlToStore,
} = require("../../src/helpers/hubUrlSetting");
const { createHubBridge } = require("../../src/helpers/hubSync");

test("the default hub URL comes from RTECH_WHISPER_HUB_URL and applies only when the setting was never set", (t) => {
  const saved = process.env.RTECH_WHISPER_HUB_URL;
  t.after(() => {
    if (saved === undefined) delete process.env.RTECH_WHISPER_HUB_URL;
    else process.env.RTECH_WHISPER_HUB_URL = saved;
  });
  delete process.env.RTECH_WHISPER_HUB_URL;
  assert.equal(readHubUrlSetting(undefined), "", "no configured default means sync is off");
  process.env.RTECH_WHISPER_HUB_URL = "https://hub.example.org";
  assert.equal(defaultHubUrl(), "https://hub.example.org");
  assert.equal(readHubUrlSetting(undefined), "https://hub.example.org");
  assert.equal(readHubUrlSetting(""), "https://hub.example.org");
  assert.equal(readHubUrlSetting("https://hub.example.com"), "https://hub.example.com");
});

test("an explicit empty hub URL is stored as off and reads back as off", () => {
  const stored = hubUrlToStore("");
  assert.ok(stored, "an empty save must persist a value, or it would read back as unset");
  assert.equal(readHubUrlSetting(stored), "");
  assert.equal(
    readHubUrlSetting(hubUrlToStore("https://hub.example.com")),
    "https://hub.example.com"
  );
});

test("the bridge round-trips unset, off, and a custom URL through the stored setting", () => {
  let stored;
  const bridge = createHubBridge({
    getHubUrl: () => readHubUrlSetting(stored),
    saveHubUrl: (url) => {
      stored = hubUrlToStore(url);
    },
    tokenStore: { getState: () => ({ token: null, generation: 0 }) },
    getAppVersion: () => "0.0.0",
    proxyFetch: async () => {
      throw new Error("no network in this test");
    },
  });
  assert.equal(bridge.getUrl(), defaultHubUrl());
  assert.deepEqual(bridge.saveUrl("  "), { success: true, url: "" });
  assert.equal(bridge.getUrl(), "");
  bridge.saveUrl("https://hub.example.com/");
  assert.equal(bridge.getUrl(), "https://hub.example.com");
});
