const test = require("node:test");
const assert = require("node:assert/strict");

const LEVEL_ENV_KEYS = ["OPENWHISPR_LOG_LEVEL", "LOG_LEVEL"];

function loadLogger(t, { argv = [], env = {} } = {}) {
  const electronPath = require.resolve("electron");
  const debugLoggerPath = require.resolve("../../src/helpers/debugLogger.js");
  const originalElectronCache = require.cache[electronPath];
  const originalLoggerCache = require.cache[debugLoggerPath];
  const originalArgv = process.argv;
  const envSnapshot = LEVEL_ENV_KEYS.map((key) => [
    key,
    Object.hasOwn(process.env, key),
    process.env[key],
  ]);

  t.after(() => {
    process.argv = originalArgv;
    for (const [key, present, value] of envSnapshot) {
      if (present) process.env[key] = value;
      else delete process.env[key];
    }
    delete require.cache[debugLoggerPath];
    if (originalLoggerCache) require.cache[debugLoggerPath] = originalLoggerCache;
    if (originalElectronCache) require.cache[electronPath] = originalElectronCache;
    else delete require.cache[electronPath];
  });

  for (const key of LEVEL_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  process.argv = ["electron", "main.js", ...argv];
  require.cache[electronPath] = {
    exports: { app: { isReady: () => false, isPackaged: false } },
  };
  delete require.cache[debugLoggerPath];
  return require(debugLoggerPath);
}

// Rico ruling 2026-10-13: debug logging stays on until the app is production-ready.
test("log level defaults to debug with no env or arg", (t) => {
  const debugLogger = loadLogger(t);
  assert.equal(debugLogger.DEFAULT_LOG_LEVEL, "debug");
  assert.equal(debugLogger.getLevel(), "debug");
  assert.equal(debugLogger.isEnabled(), true);
});

test("an explicit OPENWHISPR_LOG_LEVEL still overrides the default", (t) => {
  const debugLogger = loadLogger(t, { env: { OPENWHISPR_LOG_LEVEL: "info" } });
  assert.equal(debugLogger.getLevel(), "info");
  assert.equal(debugLogger.isEnabled(), false);
});

test("an explicit --log-level arg overrides the env", (t) => {
  const debugLogger = loadLogger(t, {
    argv: ["--log-level=warn"],
    env: { OPENWHISPR_LOG_LEVEL: "debug" },
  });
  assert.equal(debugLogger.getLevel(), "warn");
});
