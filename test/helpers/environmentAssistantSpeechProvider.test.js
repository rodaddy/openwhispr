const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

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

function createEnvironmentManager(t) {
  const userDataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-assistant-speech-provider-")
  );
  const hadProvider = Object.hasOwn(process.env, "ASSISTANT_SPEECH_PROVIDER");
  const originalProvider = process.env.ASSISTANT_SPEECH_PROVIDER;
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.ASSISTANT_SPEECH_PROVIDER;

  t.after(() => {
    if (hadProvider) process.env.ASSISTANT_SPEECH_PROVIDER = originalProvider;
    else delete process.env.ASSISTANT_SPEECH_PROVIDER;
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

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

  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  const saveAllKeysToEnvFile = environmentManager.saveAllKeysToEnvFile.bind(environmentManager);
  const persistence = { last: null };
  environmentManager.saveAllKeysToEnvFile = () => {
    persistence.last = saveAllKeysToEnvFile();
    return persistence.last;
  };
  return { environmentManager, persistence, envPath: path.join(userDataDirectory, ".env") };
}

test("saving the local speech provider sets the env var and writes it to the env file", async (t) => {
  const { environmentManager, persistence, envPath } = createEnvironmentManager(t);

  environmentManager.saveAssistantSpeechProvider("local");

  assert.equal(process.env.ASSISTANT_SPEECH_PROVIDER, "local");
  assert.equal(environmentManager.getAssistantSpeechProvider(), "local");
  await persistence.last;
  assert.match(fs.readFileSync(envPath, "utf8"), /^ASSISTANT_SPEECH_PROVIDER=local$/m);
});

test("saving an unknown speech provider stores the hub", async (t) => {
  const { environmentManager, persistence, envPath } = createEnvironmentManager(t);

  environmentManager.saveAssistantSpeechProvider("cloud");

  assert.equal(process.env.ASSISTANT_SPEECH_PROVIDER, "hub");
  await persistence.last;
  assert.match(fs.readFileSync(envPath, "utf8"), /^ASSISTANT_SPEECH_PROVIDER=hub$/m);
});

test("a speech provider that was never saved is not written to the env file", async (t) => {
  const { environmentManager, envPath } = createEnvironmentManager(t);
  const hadStartMinimized = Object.hasOwn(process.env, "START_MINIMIZED");
  const originalStartMinimized = process.env.START_MINIMIZED;
  process.env.START_MINIMIZED = "true";
  t.after(() => {
    if (hadStartMinimized) process.env.START_MINIMIZED = originalStartMinimized;
    else delete process.env.START_MINIMIZED;
  });

  await environmentManager.saveAllKeysToEnvFile();

  const persistedEnv = fs.readFileSync(envPath, "utf8");
  assert.match(persistedEnv, /^START_MINIMIZED=true$/m);
  assert.doesNotMatch(persistedEnv, /^ASSISTANT_SPEECH_PROVIDER=/m);
});
