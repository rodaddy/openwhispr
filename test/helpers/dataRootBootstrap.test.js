const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  POINTER_FILE,
  MARKER_FILE,
  BOOT_LIMBO_DIR,
  CACHE_ROOT_FILE,
  resolveBootDataRoot,
  applyBootDataRoot,
  adoptExistingStore,
  runBlockedBootDialog,
  runBootGate,
} = require("../../src/helpers/dataRootBootstrap");

const STORE_ID = "3f1c2a9e-0000-4000-8000-000000000001";

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function fakeApp() {
  const paths = {};
  return { paths, setPath: (name, value) => (paths[name] = value) };
}

describe("data-root boot resolver (#257)", () => {
  let tempRoot;
  let defaultUserData;
  let dataRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-data-root-"));
    defaultUserData = path.join(tempRoot, "default");
    dataRoot = path.join(tempRoot, "external", "OpenWhispr");
    fs.mkdirSync(defaultUserData, { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
  });

  afterEach(() => {
    fs.chmodSync(dataRoot, 0o755);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writePointer(overrides = {}) {
    writeJson(path.join(defaultUserData, POINTER_FILE), {
      version: 1,
      dataRoot,
      storeId: STORE_ID,
      movedAt: "2026-09-30T00:00:00.000Z",
      ...overrides,
    });
  }

  function writeMarker(overrides = {}) {
    writeJson(path.join(dataRoot, MARKER_FILE), {
      storeId: STORE_ID,
      channel: "production",
      createdAt: "2026-09-30T00:00:00.000Z",
      ...overrides,
    });
  }

  function resolve(extra = {}) {
    return resolveBootDataRoot({ defaultUserData, channel: "production", ...extra });
  }

  it("uses the channel default when there is no pointer", () => {
    assert.deepEqual(resolve(), { kind: "default", userData: defaultUserData });
  });

  it("resolves a valid pointer to its data root", () => {
    writePointer();
    writeMarker();
    assert.deepEqual(resolve(), { kind: "pointer", dataRoot, storeId: STORE_ID });
  });

  it("puts every store path under the data root and loads .env from there", () => {
    const app = fakeApp();
    const env = {};
    const result = applyBootDataRoot(app, { kind: "pointer", dataRoot }, env);
    assert.equal(app.paths.userData, dataRoot);
    assert.equal(app.paths.sessionData, dataRoot);
    assert.equal(app.paths.logs, path.join(dataRoot, "logs"));
    assert.equal(app.paths.crashDumps, path.join(dataRoot, "crashes"));
    assert.equal(env.OPENWHISPR_CACHE_ROOT, path.join(dataRoot, "cache"));
    assert.equal(env.OPENWHISPR_YTDLP_CACHE_DIR, path.join(dataRoot, "cache", "yt-dlp"));
    assert.equal(result.dotenvPath, path.join(dataRoot, ".env"));
  });

  it("default mode uses the cache a move home left on the drive", () => {
    const cacheRoot = path.join(dataRoot, "cache");
    fs.mkdirSync(cacheRoot);
    writeJson(path.join(defaultUserData, CACHE_ROOT_FILE), { version: 1, cacheRoot });
    const resolution = resolve();
    assert.deepEqual(resolution, { kind: "default", userData: defaultUserData, cacheRoot });
    const app = fakeApp();
    const env = {};
    applyBootDataRoot(app, resolution, env);
    assert.equal(app.paths.userData, defaultUserData);
    assert.equal(env.OPENWHISPR_CACHE_ROOT, cacheRoot);
  });

  it("default mode boots without the drive cache when its folder is missing", () => {
    const cacheRoot = path.join(tempRoot, "unmounted", "Whisper", "cache");
    writeJson(path.join(defaultUserData, CACHE_ROOT_FILE), { version: 1, cacheRoot });
    const resolution = resolve();
    assert.deepEqual(resolution, { kind: "default", userData: defaultUserData });
    const env = {};
    const result = applyBootDataRoot(fakeApp(), resolution, env);
    assert.equal(env.OPENWHISPR_CACHE_ROOT, undefined);
    assert.equal(result.dotenvPath, path.join(defaultUserData, ".env"));
  });

  it("keeps cache overrides that are already set", () => {
    const env = { OPENWHISPR_CACHE_ROOT: "/elsewhere" };
    applyBootDataRoot(fakeApp(), { kind: "pointer", dataRoot }, env);
    assert.equal(env.OPENWHISPR_CACHE_ROOT, "/elsewhere");
  });

  it("blocks when the data root is missing", () => {
    writePointer({ dataRoot: path.join(tempRoot, "unmounted", "OpenWhispr") });
    assert.equal(resolve().reason, "missing");
  });

  it("blocks when the data root is not writable", { skip: process.getuid?.() === 0 }, () => {
    writePointer();
    writeMarker();
    fs.chmodSync(dataRoot, 0o555);
    assert.equal(resolve().reason, "not-writable");
  });

  it("blocks when the data root is empty with no marker", () => {
    writePointer();
    assert.equal(resolve().reason, "no-marker");
  });

  it("blocks when the marker belongs to a different store", () => {
    writePointer();
    writeMarker({ storeId: "someone-else" });
    assert.equal(resolve().reason, "store-mismatch");
  });

  it("blocks when the marker belongs to a different channel", () => {
    writePointer();
    writeMarker({ channel: "development" });
    assert.equal(resolve().reason, "channel-mismatch");
  });

  it("blocks when the pointer file is unreadable", () => {
    fs.writeFileSync(path.join(defaultUserData, POINTER_FILE), "{not json");
    assert.equal(resolve().reason, "pointer-corrupt");
  });

  it("prefers --user-data-dir, then OPENWHISPR_DATA_DIR, over a pointer", () => {
    writePointer({ dataRoot: path.join(tempRoot, "missing") });
    assert.deepEqual(resolve({ hasUserDataDirSwitch: true, envDataDir: "/x" }), {
      kind: "switch",
    });
    assert.deepEqual(resolve({ envDataDir: dataRoot }), { kind: "env", dataRoot });
  });

  // Resolver + apply only: a missing pointer target resolves to boot-limbo and
  // leaves the default folder untouched. That main.js never reaches startApp on
  // a blocked boot is proven by the "boot gate" tests below.
  it("a pointer to a missing drive blocks and never touches the default store", () => {
    writePointer({ dataRoot: "/mnt/NoSuchDrive-257/OpenWhispr" });
    const before = fs.readdirSync(defaultUserData).sort();

    const resolution = resolve();
    const app = fakeApp();
    const result = applyBootDataRoot(app, resolution, {});

    assert.equal(resolution.kind, "blocked");
    assert.equal(resolution.reason, "missing");
    assert.equal(app.paths.userData, path.join(defaultUserData, BOOT_LIMBO_DIR));
    assert.equal(result.dotenvPath, null);
    assert.deepEqual(fs.readdirSync(defaultUserData).sort(), before);
  });

  describe("Choose folder adopts only a matching store", () => {
    it("adopts a store whose marker matches the channel and rewrites the pointer", () => {
      writePointer({ dataRoot: path.join(tempRoot, "old") });
      writeMarker();
      const now = new Date("2026-10-01T00:00:00.000Z");
      assert.deepEqual(
        adoptExistingStore({ defaultUserData, channel: "production", folder: dataRoot, now }),
        {
          ok: true,
        }
      );
      const pointer = JSON.parse(fs.readFileSync(path.join(defaultUserData, POINTER_FILE), "utf8"));
      assert.deepEqual(pointer, {
        version: 1,
        dataRoot,
        storeId: STORE_ID,
        movedAt: now.toISOString(),
      });
      assert.equal(resolve().kind, "pointer");
    });

    it("refuses a folder with no store and leaves the pointer alone", () => {
      writePointer();
      const before = fs.readFileSync(path.join(defaultUserData, POINTER_FILE), "utf8");
      const result = adoptExistingStore({
        defaultUserData,
        channel: "production",
        folder: dataRoot,
      });
      assert.deepEqual(result, { ok: false, reason: "no-marker" });
      assert.equal(fs.readFileSync(path.join(defaultUserData, POINTER_FILE), "utf8"), before);
    });

    it("refuses a store from another channel", () => {
      writeMarker({ channel: "staging" });
      const result = adoptExistingStore({
        defaultUserData,
        channel: "production",
        folder: dataRoot,
      });
      assert.deepEqual(result, { ok: false, reason: "channel-mismatch", markerChannel: "staging" });
    });
  });
});

describe("OPENWHISPR_DATA_DIR is checked before it is trusted (review of #259)", () => {
  let tempRoot;
  let defaultUserData;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-data-root-env-"));
    defaultUserData = path.join(tempRoot, "default");
    fs.mkdirSync(defaultUserData, { recursive: true });
  });

  afterEach(() => {
    fs.chmodSync(tempRoot, 0o755);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function resolveEnv(envDataDir) {
    return resolveBootDataRoot({ defaultUserData, channel: "production", envDataDir });
  }

  it("blocks when the env folder does not exist, even over a valid default", () => {
    const envDir = path.join(tempRoot, "unmounted", "OpenWhispr");
    assert.deepEqual(resolveEnv(envDir), {
      kind: "blocked",
      reason: "missing",
      dataRoot: envDir,
      defaultUserData,
      source: "env",
    });
    assert.equal(fs.existsSync(envDir), false);
  });

  it("blocks when the env folder is not writable", { skip: process.getuid?.() === 0 }, () => {
    const envDir = path.join(tempRoot, "readonly");
    fs.mkdirSync(envDir);
    fs.chmodSync(envDir, 0o555);
    try {
      assert.equal(resolveEnv(envDir).reason, "not-writable");
    } finally {
      fs.chmodSync(envDir, 0o755);
    }
  });

  it("accepts an existing writable env folder with no marker yet", () => {
    const envDir = path.join(tempRoot, "dev-store");
    fs.mkdirSync(envDir);
    assert.deepEqual(resolveEnv(envDir), { kind: "env", dataRoot: envDir });
  });
});

describe("blocked-boot dialog (review of #259)", () => {
  let tempRoot;
  let defaultUserData;
  let storeDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-data-root-dialog-"));
    defaultUserData = path.join(tempRoot, "default");
    storeDir = path.join(tempRoot, "store");
    fs.mkdirSync(defaultUserData, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function blocked(reason, extra = {}) {
    return {
      kind: "blocked",
      reason,
      dataRoot: "/mnt/Gone/OpenWhispr",
      defaultUserData,
      ...extra,
    };
  }

  // responses: a button index, or a function (box) => index. The dialog throws
  // when the script runs out, so a loop that never exits fails the test.
  function harness({ responses, picks = [] }) {
    const calls = { boxes: [], opens: 0, relaunch: 0, exit: [] };
    const dialog = {
      showMessageBoxSync: (box) => {
        calls.boxes.push(box);
        if (responses.length === 0) throw new Error("dialog shown more times than scripted");
        const next = responses.shift();
        return typeof next === "function" ? next(box) : next;
      },
      showOpenDialogSync: () => {
        calls.opens += 1;
        return picks.shift();
      },
    };
    const app = {
      relaunch: () => (calls.relaunch += 1),
      exit: (code) => calls.exit.push(code),
    };
    const t = (key) => key;
    return { calls, dialog, app, t };
  }

  function run(resolution, h, resolveAgain = () => resolution) {
    runBlockedBootDialog({
      resolution,
      channel: "production",
      resolveAgain,
      dialog: h.dialog,
      app: h.app,
      t: h.t,
    });
  }

  const buttons = (box) => box.buttons.map((key) => key.replace("dataFolderDialog.", ""));

  it("Quit exits without relaunching", () => {
    const h = harness({ responses: [2] });
    run(blocked("missing"), h);
    assert.deepEqual(buttons(h.calls.boxes[0]), ["retry", "choose", "quit"]);
    assert.deepEqual(h.calls.exit, [0]);
    assert.equal(h.calls.relaunch, 0);
  });

  it("maps the cancelId response and any unknown response to Quit", () => {
    const cancel = harness({ responses: [(box) => box.cancelId] });
    run(blocked("no-marker"), cancel);
    assert.deepEqual(buttons(cancel.calls.boxes[0]), ["choose", "quit"]);
    assert.equal(cancel.calls.boxes[0].cancelId, 1);
    assert.deepEqual(cancel.calls.exit, [0]);
    assert.equal(cancel.calls.relaunch, 0);

    const unknown = harness({ responses: [7] });
    run(blocked("missing"), unknown);
    assert.deepEqual(unknown.calls.exit, [0]);
    assert.equal(unknown.calls.relaunch, 0);
  });

  it("Retry while still blocked loops without relaunching", () => {
    const h = harness({ responses: [0, 2] });
    let resolves = 0;
    run(blocked("missing"), h, () => {
      resolves += 1;
      return blocked("missing");
    });
    assert.equal(resolves, 1);
    assert.equal(h.calls.boxes.length, 2);
    assert.equal(h.calls.relaunch, 0);
    assert.deepEqual(h.calls.exit, [0]);
  });

  it("Retry that resolves relaunches", () => {
    const h = harness({ responses: [0] });
    run(blocked("missing"), h, () => ({ kind: "pointer", dataRoot: storeDir, storeId: "x" }));
    assert.equal(h.calls.relaunch, 1);
    assert.deepEqual(h.calls.exit, [0]);
  });

  it("Choose cancelled loops back to the dialog", () => {
    const h = harness({ responses: [1, 2], picks: [undefined] });
    run(blocked("missing"), h);
    assert.equal(h.calls.opens, 1);
    assert.equal(h.calls.boxes.length, 2);
    assert.equal(h.calls.relaunch, 0);
  });

  it("Choose refused shows the refusal notice and loops", () => {
    const h = harness({ responses: [0, 1], picks: [[storeDir]] });
    run(blocked("no-marker"), h);
    assert.match(h.calls.boxes[1].detail, /dataFolderDialog\.refused\.noMarker/);
    assert.equal(h.calls.relaunch, 0);
    assert.deepEqual(h.calls.exit, [0]);
    assert.equal(fs.existsSync(path.join(defaultUserData, POINTER_FILE)), false);
  });

  it("Choose adopting a matching store relaunches", () => {
    writeJson(path.join(storeDir, MARKER_FILE), { storeId: STORE_ID, channel: "production" });
    const h = harness({ responses: [0], picks: [[storeDir]] });
    run(blocked("no-marker"), h);
    assert.equal(h.calls.relaunch, 1);
    assert.deepEqual(h.calls.exit, [0]);
  });

  // A pointer write failure (ENOSPC, EACCES, EPERM) must keep the dialog up;
  // before the fix it escaped whenReady and left a windowless zombie.
  it("a pointer write failure shows a notice and keeps Retry/Choose/Quit", () => {
    writeJson(path.join(storeDir, MARKER_FILE), { storeId: STORE_ID, channel: "production" });
    // A non-empty directory where the pointer goes makes the rename fail.
    fs.mkdirSync(path.join(defaultUserData, POINTER_FILE, "occupied"), { recursive: true });
    const h = harness({ responses: [1, 2], picks: [[storeDir]] });
    assert.doesNotThrow(() => run(blocked("missing"), h));
    assert.match(h.calls.boxes[1].detail, /dataFolderDialog\.refused\.writeFailed/);
    assert.deepEqual(buttons(h.calls.boxes[1]), ["retry", "choose", "quit"]);
    assert.equal(h.calls.relaunch, 0);
    assert.deepEqual(h.calls.exit, [0]);
  });

  it("an env-var block offers no Choose, since a pointer cannot override the env var", () => {
    const h = harness({ responses: [1] });
    run(blocked("missing", { source: "env" }), h);
    assert.deepEqual(buttons(h.calls.boxes[0]), ["retry", "quit"]);
    assert.equal(h.calls.opens, 0);
    assert.deepEqual(h.calls.exit, [0]);
  });
});

describe("boot gate (review of #259)", () => {
  function gate(resolution, { throwInBlocked = null } = {}) {
    const calls = { blocked: 0, move: 0, start: 0, errors: [] };
    const outcome = runBootGate({
      resolution,
      runBlocked: () => {
        calls.blocked += 1;
        if (throwInBlocked) throw throwInBlocked;
      },
      runMove: async () => {
        calls.move += 1;
        if (throwInBlocked) throw throwInBlocked;
      },
      start: () => (calls.start += 1),
      onBlockedError: (error) => calls.errors.push(error),
    });
    return { calls, outcome };
  }

  it("a blocked resolution never reaches startApp", () => {
    const { calls, outcome } = gate({ kind: "blocked", reason: "missing" });
    assert.equal(outcome, "blocked");
    assert.equal(calls.blocked, 1);
    assert.equal(calls.start, 0);
  });

  it("a throw in the blocked dialog is handed to onBlockedError, still without startApp", () => {
    const failure = new Error("ENOSPC");
    const { calls } = gate({ kind: "blocked", reason: "missing" }, { throwInBlocked: failure });
    assert.deepEqual(calls.errors, [failure]);
    assert.equal(calls.start, 0);
  });

  it("a pending move runs before any store opens and never reaches startApp (PR B)", async () => {
    const { calls, outcome } = gate({ kind: "move", from: "/old", defaultUserData: "/d" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome, "move");
    assert.equal(calls.move, 1);
    assert.equal(calls.start, 0);
    assert.equal(calls.blocked, 0);
  });

  it("a throw during the move is handed to onBlockedError (PR B)", async () => {
    const failure = new Error("EIO");
    const { calls } = gate({ kind: "move" }, { throwInBlocked: failure });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.errors, [failure]);
    assert.equal(calls.start, 0);
  });

  for (const kind of ["default", "pointer", "env", "switch"]) {
    it(`a ${kind} resolution starts the app and skips the dialog`, () => {
      const { calls, outcome } = gate({ kind });
      assert.equal(outcome, "started");
      assert.equal(calls.start, 1);
      assert.equal(calls.blocked, 0);
    });
  }
});
