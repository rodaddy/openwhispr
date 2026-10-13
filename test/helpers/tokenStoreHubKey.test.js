// The hub device key must never be read from an upstream sign-in's
// auth-token.bin: hub mode is on by default, so a stale bearer left there would
// be sent to the hub, answered 401 (final, no fallback), and break dictation.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const storePath = require.resolve("../../src/helpers/tokenStore");
const scratchRoot = path.join(__dirname, "..", "..", "node_modules", ".cache", "tokenStoreHubKey");

function loadStore(userData) {
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (parent?.filename === storePath) {
      if (request === "electron") return { app: { getPath: () => userData } };
      if (request === "./debugLogger") return { error() {} };
      if (request === "./secretCrypto") return { isAvailable: () => false };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[storePath];
    return require(storePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[storePath];
  }
}

function freshUserData(name) {
  const dir = path.join(scratchRoot, `${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("a legacy auth-token.bin is not used as the hub device key and is removed", () => {
  const userData = freshUserData("legacy");
  const legacy = path.join(userData, "auth-token.bin");
  fs.writeFileSync(legacy, "stale-upstream-bearer");

  const store = loadStore(userData);
  assert.ok(!store.getState().token, "no hub key is inferred from the legacy file");
  assert.equal(fs.existsSync(legacy), false, "the stale bearer file is cleared");
  fs.rmSync(userData, { recursive: true, force: true });
});

test("the hub device key persists in its own file across restarts", () => {
  const userData = freshUserData("persist");
  const first = loadStore(userData);
  assert.equal(first.set("whk_device-key").success, true);
  assert.equal(fs.existsSync(path.join(userData, "auth-token.bin")), false);

  const second = loadStore(userData);
  assert.equal(second.getState().token, "whk_device-key");
  assert.equal(second.clear().success, true);
  assert.ok(!loadStore(userData).getState().token);
  fs.rmSync(userData, { recursive: true, force: true });
});

// rtech-whisper#143 #225: a clear that reaches neither the unlink nor the
// empty-value fallback leaves the key on disk, so the store keeps reporting it
// to every reader (not only the clear reply) and the user can retry.
test("a failed clear keeps reporting the key that is still on disk", () => {
  const { createHubBridge } = require("../../src/helpers/hubSync");
  const userData = freshUserData("failed-clear");
  const store = loadStore(userData);
  assert.equal(store.set("whk_device-key").success, true);
  const before = store.getState().generation;
  // A directory at the key path makes both rmSync (no recursive) and
  // writeFileSync throw, like a locked or read-only userData.
  const keyFile = path.join(userData, "hub-device-key.bin");
  fs.rmSync(keyFile);
  fs.mkdirSync(keyFile);

  const bridge = createHubBridge({
    getHubUrl: () => "https://hub.example.test",
    saveHubUrl() {},
    tokenStore: store,
    getAppVersion: () => "0.0.0",
    proxyFetch: async () => new Response("{}"),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const cleared = bridge.clearKey();
  assert.equal(cleared.success, false);
  assert.equal(cleared.hasKey, true);
  assert.equal(store.getState().token, "whk_device-key");
  assert.equal(bridge.getKeyState().hasKey, true, "the next mount still sees the key");
  assert.ok(store.getState().generation > before, "in-flight requests are still fenced");
  fs.rmSync(userData, { recursive: true, force: true });
});

// A guard, not a regression proof for #231: it passes without that fix too
// (#234). The proof is the test above.
test("guard: a failed clear with no key stored reports no key", () => {
  const userData = freshUserData("failed-clear-empty");
  const store = loadStore(userData);
  assert.ok(!store.getState().token);
  fs.mkdirSync(path.join(userData, "hub-device-key.bin"));
  const cleared = store.clear();
  assert.equal(cleared.success, false);
  assert.ok(!cleared.token);
  fs.rmSync(userData, { recursive: true, force: true });
});
