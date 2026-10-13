const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ENV_KEYS = ["OPENWHISPR_LOG_LEVEL", "PASTE_LAST_KEY"];

function loadEnvironmentManager(t, userDataDirectory) {
  const environmentPath = require.resolve("../../src/helpers/environment");
  const originalEnvironmentModule = require.cache[environmentPath];
  const originalLoad = Module._load;
  delete require.cache[environmentPath];

  Module._load = function loadWithTestDependencies(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDirectory,
          getAppPath: () => userDataDirectory,
          isReady: () => false,
        },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "./secretCrypto") return { isAvailable: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(environmentPath);
  } finally {
    Module._load = originalLoad;
    t.after(() => {
      if (originalEnvironmentModule) require.cache[environmentPath] = originalEnvironmentModule;
      else delete require.cache[environmentPath];
    });
  }
}

// Regression: every saveAllKeysToEnvFile() regenerated .env from PERSISTED_KEYS
// and dropped OPENWHISPR_LOG_LEVEL, so a hotkey save silently turned debug
// logging off at the next launch and a lost meeting left no log.
test(".env rewrite keeps OPENWHISPR_LOG_LEVEL=debug", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-log-level-"));
  const snapshot = ENV_KEYS.map((key) => [key, Object.hasOwn(process.env, key), process.env[key]]);
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;

  t.after(() => {
    for (const [key, present, value] of snapshot) {
      if (present) process.env[key] = value;
      else delete process.env[key];
    }
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  const envPath = path.join(userDataDirectory, ".env");
  fs.writeFileSync(envPath, "# Debug logging setting\nOPENWHISPR_LOG_LEVEL=debug\n", "utf8");
  delete process.env.OPENWHISPR_LOG_LEVEL;
  delete process.env.PASTE_LAST_KEY;

  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  assert.equal(process.env.OPENWHISPR_LOG_LEVEL, "debug");

  process.env.PASTE_LAST_KEY = "Control+Alt+V";
  await environmentManager.saveAllKeysToEnvFile();

  const persistedEnv = fs.readFileSync(envPath, "utf8");
  assert.match(persistedEnv, /^OPENWHISPR_LOG_LEVEL=debug$/m);
  assert.match(persistedEnv, /^PASTE_LAST_KEY=Control\+Alt\+V$/m);
});

// Debug is the default, so an explicit OFF must survive a later save and a
// restart, or the Settings toggle silently flips back on.
test(".env rewrite keeps an explicit OPENWHISPR_LOG_LEVEL=info across a restart", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-log-level-"));
  const snapshot = ENV_KEYS.map((key) => [key, Object.hasOwn(process.env, key), process.env[key]]);
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;

  t.after(() => {
    for (const [key, present, value] of snapshot) {
      if (present) process.env[key] = value;
      else delete process.env[key];
    }
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  const envPath = path.join(userDataDirectory, ".env");
  delete process.env.OPENWHISPR_LOG_LEVEL;
  delete process.env.PASTE_LAST_KEY;

  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();

  // What the set-debug-logging handler does when the toggle goes off.
  process.env.OPENWHISPR_LOG_LEVEL = "info";
  await environmentManager.saveAllKeysToEnvFile();

  process.env.PASTE_LAST_KEY = "Control+Alt+V";
  await environmentManager.saveAllKeysToEnvFile();
  assert.match(fs.readFileSync(envPath, "utf8"), /^OPENWHISPR_LOG_LEVEL=info$/m);

  delete process.env.OPENWHISPR_LOG_LEVEL;
  new EnvironmentManager();
  assert.equal(process.env.OPENWHISPR_LOG_LEVEL, "info");
});
