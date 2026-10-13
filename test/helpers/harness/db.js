const REQUIRED_DB_FAILURE =
  "DB-backed tests were required (REQUIRE_DB_TESTS is set) but the better-sqlite3 native " +
  "binding could not be loaded, so this test would have been skipped instead of run. In CI " +
  "this almost always means the step that rebuilds better-sqlite3 for the runner's Node " +
  '("npm rebuild better-sqlite3", right after "npm ci --ignore-scripts") is missing or ' +
  "failed. Restore that step instead of deleting this check: without it every DB test " +
  "skips and the suite stays green with no database coverage. Underlying error: ";

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file") ||
    message.includes("ERR_DLOPEN_FAILED") ||
    error?.code === "ERR_DLOPEN_FAILED"
  );
}

// Locally the binding is built for Electron's ABI (postinstall runs install-app-deps), so a plain
// `node` run must skip. Run `npm run test:db` locally instead: it runs the suite under the repo's
// Electron as Node, whose ABI matches, with REQUIRE_DB_TESTS set. In CI the rebuild step makes
// the binding loadable under Node, so a skip there means that step vanished and must fail.
function skipOrFail(t, error) {
  if (!isNativeBindingUnavailable(error)) {
    throw error;
  }
  if (process.env.REQUIRE_DB_TESTS) {
    throw new Error(REQUIRED_DB_FAILURE + String(error?.message || error), { cause: error });
  }
  t.skip(
    "better-sqlite3 native binding is not available for this Node runtime (run `npm run test:db`)"
  );
}

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installElectronStub, setUserDataDir } = require("./electronStub.js");

installElectronStub();
const DatabaseManager = require("../../../src/helpers/database.js");

// A real DatabaseManager over a private tmpdir. Returns null when the caller
// must bail because skipOrFail marked the test skipped.
function createDb(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-sync-harness-"));
  setUserDataDir(userDataDir);

  // Probe first: a binding failure here is the loader's, not schema setup's.
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    skipOrFail(t, error);
    return null;
  }

  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    skipOrFail(t, error);
    return null;
  }

  t.after(() => {
    try {
      db.db?.close();
    } catch {
      // an already-closed handle must not mask the test's own failure
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  return db;
}

module.exports = { isNativeBindingUnavailable, skipOrFail, createDb };
