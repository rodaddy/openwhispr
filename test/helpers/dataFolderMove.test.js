const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  POINTER_FILE,
  MARKER_FILE,
  PENDING_MOVE_FILE,
  BOOT_LIMBO_DIR,
  CACHE_ROOT_FILE,
  PREVIOUS_ROOT_FILE,
  resolveBootDataRoot,
} = require("../../src/helpers/dataRootBootstrap");
const {
  checkDestination,
  copyTree,
  requestMove,
  runPendingMove,
  removeOldCopy,
  integrityCheck,
} = require("../../src/helpers/dataFolderMove");
const { skipOrFail } = require("./harness/db");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("data folder move", () => {
  let tempRoot;
  let defaultUserData;
  let cacheRoot;
  let to;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-move-"));
    defaultUserData = path.join(tempRoot, "default");
    cacheRoot = path.join(tempRoot, "home-cache");
    to = path.join(tempRoot, "drive", "Whisper");
    write(path.join(defaultUserData, "settings.json"), "{}");
    write(path.join(defaultUserData, "audio", "a.webm"), "0123456789");
    write(path.join(defaultUserData, "Cache", "junk"), "rebuildable");
    write(path.join(defaultUserData, "Code Cache", "js", "junk"), "rebuildable");
    write(path.join(defaultUserData, "SingletonLock"), "lock");
    write(path.join(cacheRoot, "whisper-models", "ggml-base.bin"), "model-bytes");
    fs.mkdirSync(to, { recursive: true });
  });

  afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  function request(extra = {}) {
    const result = requestMove({ defaultUserData, from: defaultUserData, to, cacheRoot, ...extra });
    assert.deepEqual(result, { ok: true });
  }

  function move(options = {}) {
    return runPendingMove({
      defaultUserData,
      from: defaultUserData,
      channel: "production",
      ...options,
    });
  }

  it("copies a seeded tree plus the model cache, verifies it, and switches the pointer", async () => {
    request();
    const result = await move({ checkDb: () => "ok" });

    assert.deepEqual(result, { ok: true, to });
    assert.equal(fs.readFileSync(path.join(to, "audio", "a.webm"), "utf8"), "0123456789");
    assert.equal(
      fs.readFileSync(path.join(to, "cache", "whisper-models", "ggml-base.bin"), "utf8"),
      "model-bytes"
    );
    // Exact names: on a case-insensitive disk "Cache" would match the copied "cache".
    assert.deepEqual(fs.readdirSync(to).sort(), [MARKER_FILE, "audio", "cache", "settings.json"]);
    const marker = JSON.parse(fs.readFileSync(path.join(to, MARKER_FILE), "utf8"));
    const pointer = JSON.parse(fs.readFileSync(path.join(defaultUserData, POINTER_FILE), "utf8"));
    assert.equal(pointer.dataRoot, to);
    assert.equal(pointer.storeId, marker.storeId);
    assert.equal(pointer.previousDataRoot, defaultUserData);
    assert.equal(fs.existsSync(path.join(defaultUserData, PENDING_MOVE_FILE)), false);
    // The old folder is never deleted.
    assert.ok(fs.existsSync(path.join(defaultUserData, "audio", "a.webm")));
    // The next boot lands on the new store.
    assert.deepEqual(resolveBootDataRoot({ defaultUserData, channel: "production" }), {
      kind: "pointer",
      dataRoot: to,
      storeId: marker.storeId,
    });
  });

  for (const [label, damage] of [
    ["a missing file", (dest) => fs.rmSync(path.join(dest, "audio", "a.webm"))],
    ["a changed file", (dest) => fs.appendFileSync(path.join(dest, "settings.json"), " ")],
  ]) {
    it(`${label} fails verification and leaves the pointer unchanged`, async () => {
      request();
      const result = await move({
        checkDb: () => "ok",
        copy: async (from, dest) => {
          await copyTree(from, dest);
          if (from === defaultUserData) damage(dest);
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.reason, /verification failed/);
      assert.equal(fs.existsSync(path.join(defaultUserData, POINTER_FILE)), false);
      assert.equal(fs.existsSync(path.join(defaultUserData, PENDING_MOVE_FILE)), false);
      assert.deepEqual(fs.readdirSync(to), []);
    });
  }

  it("a failing integrity check aborts the move", async () => {
    write(path.join(defaultUserData, "transcriptions.db"), "db");
    request();
    const result = await move({ checkDb: () => "*** in database main ***\nPage 3: never used" });

    assert.equal(result.ok, false);
    assert.match(result.reason, /transcriptions\.db integrity check failed/);
    assert.equal(fs.existsSync(path.join(defaultUserData, POINTER_FILE)), false);
  });

  it("a corrupted DB copy fails the real integrity_check and aborts the move", async (t) => {
    let Database;
    try {
      Database = require("better-sqlite3");
      new Database(":memory:").close();
    } catch (error) {
      return skipOrFail(t, error);
    }
    const dbFile = path.join(defaultUserData, "transcriptions.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX t_body ON t(body);");
    const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
    for (let i = 0; i < 2000; i += 1) insert.run(`row ${i} ${"x".repeat(50)}`);
    db.close();
    assert.equal(integrityCheck(dbFile), "ok");

    // Scribble over the last page (index b-tree) to corrupt it.
    const bytes = fs.readFileSync(dbFile);
    bytes.fill(0x7f, bytes.length - 3000, bytes.length - 100);
    fs.writeFileSync(dbFile, bytes);

    request();
    const result = await move();
    assert.equal(result.ok, false);
    assert.match(result.reason, /transcriptions\.db integrity check failed/);
    assert.equal(fs.existsSync(path.join(defaultUserData, POINTER_FILE)), false);
  });

  it("refuses a destination that is not empty or sits inside the current data", () => {
    write(path.join(to, "other.txt"), "x");
    assert.equal(checkDestination({ from: defaultUserData, to, cacheRoot }), "notEmpty");
    const inside = path.join(defaultUserData, "sub");
    fs.mkdirSync(inside);
    assert.equal(
      checkDestination({ from: defaultUserData, to: inside, cacheRoot }),
      "insideCurrent"
    );
    assert.equal(
      checkDestination({ from: defaultUserData, to: path.join(tempRoot, "nope") }),
      "missing"
    );
  });

  it("a pending move resolves to kind move, which copies the store boot would have used", () => {
    request();
    assert.deepEqual(resolveBootDataRoot({ defaultUserData, channel: "production" }), {
      kind: "move",
      from: defaultUserData,
      defaultUserData,
    });
  });
});

describe("move the data back to the default folder", () => {
  const STORE_ID = "3f1c2a9e-0000-4000-8000-000000000002";
  let tempRoot;
  let defaultUserData;
  let dataRoot;
  let cacheRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-move-home-"));
    defaultUserData = path.join(tempRoot, "default");
    dataRoot = path.join(tempRoot, "drive", "Whisper");
    cacheRoot = path.join(dataRoot, "cache");
    // Pointer mode: the default folder holds only boot's bookkeeping.
    write(
      path.join(defaultUserData, POINTER_FILE),
      JSON.stringify({ version: 1, dataRoot, storeId: STORE_ID })
    );
    write(path.join(defaultUserData, BOOT_LIMBO_DIR, "Local State"), "{}");
    write(path.join(defaultUserData, ".DS_Store"), "");
    write(
      path.join(dataRoot, MARKER_FILE),
      JSON.stringify({ storeId: STORE_ID, channel: "production" })
    );
    write(path.join(dataRoot, "settings.json"), "{}");
    write(path.join(dataRoot, "audio", "a.webm"), "0123456789");
    write(path.join(cacheRoot, "whisper-models", "ggml-base.bin"), "model-bytes");
  });

  afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  function moveHome() {
    assert.deepEqual(
      requestMove({ defaultUserData, from: dataRoot, to: defaultUserData, cacheRoot }),
      { ok: true }
    );
    return runPendingMove({
      defaultUserData,
      from: dataRoot,
      channel: "production",
      checkDb: () => "ok",
    });
  }

  it("accepts the default folder when it holds only bookkeeping files", () => {
    write(path.join(defaultUserData, PENDING_MOVE_FILE), "{}");
    write(path.join(defaultUserData, CACHE_ROOT_FILE), "{}");
    assert.equal(
      checkDestination({ from: dataRoot, to: defaultUserData, cacheRoot, defaultUserData }),
      null
    );
    // Without knowing it is the default folder, the pointer makes it not empty.
    assert.equal(checkDestination({ from: dataRoot, to: defaultUserData, cacheRoot }), "notEmpty");
    write(path.join(defaultUserData, "settings.json"), "{}");
    assert.equal(
      checkDestination({ from: dataRoot, to: defaultUserData, cacheRoot, defaultUserData }),
      "notEmpty"
    );
  });

  it("the bookkeeping exemption applies to the default folder only", () => {
    const other = path.join(tempRoot, "other");
    write(path.join(other, POINTER_FILE), "{}");
    assert.equal(
      checkDestination({ from: dataRoot, to: other, cacheRoot, defaultUserData }),
      "notEmpty"
    );
  });

  it("copies the data but not the cache, removes the pointer, and records cache and old copy", async () => {
    const result = await moveHome();

    assert.deepEqual(result, { ok: true, to: defaultUserData });
    assert.equal(
      fs.readFileSync(path.join(defaultUserData, "audio", "a.webm"), "utf8"),
      "0123456789"
    );
    assert.deepEqual(fs.readdirSync(defaultUserData).sort(), [
      ".DS_Store",
      "audio",
      BOOT_LIMBO_DIR,
      CACHE_ROOT_FILE,
      PREVIOUS_ROOT_FILE,
      "settings.json",
    ]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(defaultUserData, CACHE_ROOT_FILE), "utf8")),
      { version: 1, cacheRoot }
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(defaultUserData, PREVIOUS_ROOT_FILE), "utf8")),
      { version: 1, previousDataRoot: dataRoot }
    );
    // The cache stays on the drive and the old copy is untouched.
    assert.ok(fs.existsSync(path.join(cacheRoot, "whisper-models", "ggml-base.bin")));
    assert.ok(fs.existsSync(path.join(dataRoot, "audio", "a.webm")));
    // The next boot is default mode, using the cache on the drive.
    assert.deepEqual(resolveBootDataRoot({ defaultUserData, channel: "production" }), {
      kind: "default",
      userData: defaultUserData,
      cacheRoot,
    });
  });

  it("a failed move home keeps the pointer and boot's files", async () => {
    write(path.join(dataRoot, "transcriptions.db"), "db");
    requestMove({ defaultUserData, from: dataRoot, to: defaultUserData, cacheRoot });
    const result = await runPendingMove({
      defaultUserData,
      from: dataRoot,
      channel: "production",
      checkDb: () => "corrupt",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(defaultUserData).sort(), [
      ".DS_Store",
      BOOT_LIMBO_DIR,
      POINTER_FILE,
    ]);
  });

  it("removing the old copy after a move home keeps the cache and removes the rest", async () => {
    assert.equal((await moveHome()).ok, true);

    const result = await removeOldCopy({
      defaultUserData,
      dataRoot: defaultUserData,
      channel: "production",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(fs.readdirSync(dataRoot), ["cache"]);
    assert.ok(fs.existsSync(path.join(cacheRoot, "whisper-models", "ggml-base.bin")));
    assert.equal(fs.existsSync(path.join(defaultUserData, PREVIOUS_ROOT_FILE)), false);
    assert.equal(fs.existsSync(path.join(defaultUserData, CACHE_ROOT_FILE)), true);
    assert.ok(fs.existsSync(path.join(defaultUserData, "audio", "a.webm")));
  });

  it("a later move away from the default folder drops the move-home records", async () => {
    assert.equal((await moveHome()).ok, true);
    const away = path.join(tempRoot, "drive2", "Whisper");
    fs.mkdirSync(away, { recursive: true });
    requestMove({ defaultUserData, from: defaultUserData, to: away, cacheRoot });
    const result = await runPendingMove({
      defaultUserData,
      from: defaultUserData,
      channel: "production",
      checkDb: () => "ok",
    });

    assert.deepEqual(result, { ok: true, to: away });
    assert.equal(fs.existsSync(path.join(defaultUserData, CACHE_ROOT_FILE)), false);
    assert.equal(fs.existsSync(path.join(defaultUserData, PREVIOUS_ROOT_FILE)), false);
    assert.equal(fs.existsSync(path.join(away, CACHE_ROOT_FILE)), false);
    assert.ok(fs.existsSync(path.join(away, "cache", "whisper-models", "ggml-base.bin")));
  });
});
