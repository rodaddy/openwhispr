const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const HOTKEY_ENV_KEYS = ["PASTE_LAST_KEY"];

function snapshotEnvironment() {
  return new Map(
    HOTKEY_ENV_KEYS.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
}

function restoreEnvironment(snapshot) {
  for (const [name, { present, value }] of snapshot) {
    if (present) process.env[name] = value;
    else delete process.env[name];
  }
}

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

function installDotenvStub(t) {
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }) },
  };
  t.after(() => {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
  });
}

test("a saved paste-last hotkey is persisted and read back", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-paste-last-hotkey-"));
  const environmentSnapshot = snapshotEnvironment();
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.PASTE_LAST_KEY;

  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  const saveAllKeysToEnvFile = environmentManager.saveAllKeysToEnvFile.bind(environmentManager);
  let persistence;
  environmentManager.saveAllKeysToEnvFile = () => {
    persistence = saveAllKeysToEnvFile();
    return persistence;
  };

  assert.equal(environmentManager.getPasteLastKey(), "");
  environmentManager.savePasteLastKey("Control+Alt+V");
  await persistence;

  assert.equal(environmentManager.getPasteLastKey(), "Control+Alt+V");
  const persistedEnv = fs.readFileSync(path.join(userDataDirectory, ".env"), "utf8");
  assert.match(persistedEnv, /^PASTE_LAST_KEY=Control\+Alt\+V$/m);
});
