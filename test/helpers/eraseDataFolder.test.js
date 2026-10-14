const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, afterEach } = require("node:test");
const unzipper = require("unzipper");

const {
  POINTER_FILE,
  PENDING_MOVE_FILE,
  PREVIOUS_ROOT_FILE,
  CACHE_ROOT_FILE,
} = require("../../src/helpers/dataRootBootstrap");
const { eraseDataFolder } = require("../../src/helpers/eraseDataFolder");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seedData(root) {
  write(path.join(root, "transcriptions.db"), "db");
  write(path.join(root, "audio", "a.wav"), "wav");
  write(path.join(root, "cache", "model.bin"), "model");
  write(path.join(root, "tmp", "frag.wav"), "frag");
}

async function zipEntries(zipPath) {
  const dir = await unzipper.Open.file(zipPath);
  return dir.files.map((f) => f.path);
}

describe("erase data folder", () => {
  let tempRoot;
  let trashDir;
  let trashItem;
  const now = new Date(2026, 9, 2, 9, 5, 7);

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "erase-data-"));
    trashDir = path.join(tempRoot, "trash");
    fs.mkdirSync(trashDir);
    trashItem = async (file) => {
      fs.renameSync(file, path.join(trashDir, path.basename(file)));
    };
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("pointer mode: zips without cache/tmp, trashes the zip, deletes the folder and bookkeeping", async () => {
    const dataRoot = path.join(tempRoot, "drive", "data");
    const defaultUserData = path.join(tempRoot, "default");
    seedData(dataRoot);
    write(path.join(defaultUserData, POINTER_FILE), "{}");
    write(path.join(defaultUserData, PENDING_MOVE_FILE), "{}");

    const result = await eraseDataFolder({
      dataRoot,
      defaultUserData,
      removePointer: true,
      trashItem,
      now,
    });

    assert.equal(result.ok, true);
    assert.equal(path.basename(result.zipPath), "rTech Whisper backup 2026-10-02 090507.zip");
    const trashed = path.join(trashDir, path.basename(result.zipPath));
    assert.ok(fs.existsSync(trashed));
    const entries = await zipEntries(trashed);
    assert.ok(entries.includes("transcriptions.db"));
    assert.ok(entries.includes("audio/a.wav"));
    assert.ok(!entries.some((e) => e.startsWith("cache/") || e === "cache"));
    assert.ok(!entries.some((e) => e.startsWith("tmp/") || e === "tmp"));
    assert.ok(!fs.existsSync(dataRoot));
    assert.ok(!fs.existsSync(path.join(defaultUserData, POINTER_FILE)));
    assert.ok(!fs.existsSync(path.join(defaultUserData, PENDING_MOVE_FILE)));
  });

  it("trash failure deletes nothing and leaves no zip", async () => {
    const dataRoot = path.join(tempRoot, "drive", "data");
    const defaultUserData = path.join(tempRoot, "default");
    seedData(dataRoot);

    const result = await eraseDataFolder({
      dataRoot,
      defaultUserData,
      removePointer: true,
      trashItem: async () => {
        throw new Error("no trash");
      },
      now,
    });

    assert.equal(result.ok, false);
    assert.equal(result.step, "trash");
    assert.ok(fs.existsSync(path.join(dataRoot, "transcriptions.db")));
    assert.ok(fs.existsSync(path.join(dataRoot, "audio", "a.wav")));
    const zips = fs.readdirSync(path.dirname(dataRoot)).filter((f) => f.endsWith(".zip"));
    assert.deepEqual(zips, []);
  });

  it("default mode: deletes the folder and trashes the zip", async () => {
    const dataRoot = path.join(tempRoot, "default");
    seedData(dataRoot);
    write(path.join(dataRoot, POINTER_FILE), "{}");

    const result = await eraseDataFolder({
      dataRoot,
      defaultUserData: dataRoot,
      removePointer: false,
      trashItem,
      now,
    });

    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(dataRoot));
    assert.ok(fs.existsSync(path.join(trashDir, path.basename(result.zipPath))));
  });

  it("pointer mode: the pointer is gone before the folder delete starts, so a failed delete leaves no pointer", async () => {
    const dataRoot = path.join(tempRoot, "drive", "data");
    const defaultUserData = path.join(tempRoot, "default");
    seedData(dataRoot);
    const pointer = path.join(defaultUserData, POINTER_FILE);
    const pending = path.join(defaultUserData, PENDING_MOVE_FILE);
    write(pointer, "{}");
    write(pending, "{}");
    let seenAtRm = null;

    const result = await eraseDataFolder({
      dataRoot,
      defaultUserData,
      removePointer: true,
      trashItem,
      now,
      rm: async () => {
        seenAtRm = { pointer: fs.existsSync(pointer), pending: fs.existsSync(pending) };
        throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
      },
    });

    assert.deepEqual(seenAtRm, { pointer: false, pending: false });
    assert.equal(result.ok, false);
    assert.equal(result.step, "delete");
    assert.ok(fs.existsSync(path.join(trashDir, path.basename(result.zipPath))));
    assert.ok(!fs.existsSync(pointer));
    assert.ok(!fs.existsSync(pending));
  });

  it("env or switch mode (removePointer false): another store's pointer and pending move stay", async () => {
    const dataRoot = path.join(tempRoot, "env", "data");
    const defaultUserData = path.join(tempRoot, "default");
    seedData(dataRoot);
    const pointer = path.join(defaultUserData, POINTER_FILE);
    const pending = path.join(defaultUserData, PENDING_MOVE_FILE);
    write(pointer, '{"dataRoot":"/mnt/Drive/data"}');
    write(pending, "{}");

    const result = await eraseDataFolder({
      dataRoot,
      defaultUserData,
      removePointer: false,
      trashItem,
      now,
    });

    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(dataRoot));
    assert.equal(fs.readFileSync(pointer, "utf8"), '{"dataRoot":"/mnt/Drive/data"}');
    assert.ok(fs.existsSync(pending));
  });

  describe("pointer mode removes the old copy too", () => {
    function pointTo(defaultUserData, dataRoot, previousDataRoot) {
      write(
        path.join(defaultUserData, POINTER_FILE),
        JSON.stringify({ version: 1, dataRoot, previousDataRoot })
      );
    }

    it("old copy is the default folder: backed up under default-folder/, the default folder ends empty", async () => {
      const dataRoot = path.join(tempRoot, "drive", "data");
      const defaultUserData = path.join(tempRoot, "default");
      seedData(dataRoot);
      write(path.join(defaultUserData, "transcriptions.db"), "old db");
      write(path.join(defaultUserData, "audio", "x.wav"), "old wav");
      write(path.join(defaultUserData, PENDING_MOVE_FILE), "{}");
      write(path.join(defaultUserData, PREVIOUS_ROOT_FILE), "{}");
      write(path.join(defaultUserData, CACHE_ROOT_FILE), "{}");
      pointTo(defaultUserData, dataRoot, defaultUserData);

      const result = await eraseDataFolder({
        dataRoot,
        defaultUserData,
        removePointer: true,
        trashItem,
        now,
      });

      assert.equal(result.ok, true);
      const entries = await zipEntries(path.join(trashDir, path.basename(result.zipPath)));
      assert.ok(entries.includes("transcriptions.db"));
      assert.ok(entries.includes("audio/a.wav"));
      assert.ok(entries.includes("default-folder/transcriptions.db"));
      assert.ok(entries.includes("default-folder/audio/x.wav"));
      assert.ok(!entries.some((e) => e.startsWith("old-copy/")));
      assert.ok(!entries.includes(`default-folder/${POINTER_FILE}`));
      assert.ok(!entries.includes(`default-folder/${PENDING_MOVE_FILE}`));
      assert.ok(!entries.includes(`default-folder/${PREVIOUS_ROOT_FILE}`));
      assert.ok(!entries.includes(`default-folder/${CACHE_ROOT_FILE}`));
      assert.deepEqual(fs.readdirSync(defaultUserData), []);
      assert.ok(!fs.existsSync(dataRoot));
    });

    it("old copy on another path: backed up under old-copy/ and deleted", async () => {
      const dataRoot = path.join(tempRoot, "drive", "data");
      const defaultUserData = path.join(tempRoot, "default");
      const oldCopy = path.join(tempRoot, "other", "old-data");
      seedData(dataRoot);
      seedData(oldCopy);
      pointTo(defaultUserData, dataRoot, oldCopy);

      const result = await eraseDataFolder({
        dataRoot,
        defaultUserData,
        removePointer: true,
        trashItem,
        now,
      });

      assert.equal(result.ok, true);
      const entries = await zipEntries(path.join(trashDir, path.basename(result.zipPath)));
      assert.ok(entries.includes("old-copy/transcriptions.db"));
      assert.ok(entries.includes("old-copy/audio/a.wav"));
      assert.ok(!entries.some((e) => e.startsWith("old-copy/cache/")));
      assert.ok(!entries.some((e) => e.startsWith("old-copy/tmp/")));
      assert.ok(!fs.existsSync(oldCopy));
      assert.ok(!fs.existsSync(dataRoot));
      assert.ok(!fs.existsSync(path.join(defaultUserData, POINTER_FILE)));
    });

    it("a failed old-copy delete stops before the pointer and the live folder", async () => {
      const dataRoot = path.join(tempRoot, "drive", "data");
      const defaultUserData = path.join(tempRoot, "default");
      const oldCopy = path.join(tempRoot, "other", "old-data");
      seedData(dataRoot);
      seedData(oldCopy);
      pointTo(defaultUserData, dataRoot, oldCopy);

      const result = await eraseDataFolder({
        dataRoot,
        defaultUserData,
        removePointer: true,
        trashItem,
        now,
        rm: async (target, options) => {
          if (target === oldCopy) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          return fs.promises.rm(target, options);
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.step, "delete");
      assert.ok(fs.existsSync(path.join(defaultUserData, POINTER_FILE)));
      assert.ok(fs.existsSync(path.join(dataRoot, "transcriptions.db")));
      assert.ok(fs.existsSync(path.join(dataRoot, "audio", "a.wav")));
    });

    it("two moves: the original in the default folder and the old copy are both backed up and deleted", async () => {
      const dataRoot = path.join(tempRoot, "drive-b", "data");
      const defaultUserData = path.join(tempRoot, "default");
      const folderA = path.join(tempRoot, "drive-a", "data");
      seedData(dataRoot);
      write(path.join(defaultUserData, "transcriptions.db"), "original db");
      write(path.join(folderA, "transcriptions.db"), "a db");
      write(path.join(defaultUserData, PREVIOUS_ROOT_FILE), "{}");
      pointTo(defaultUserData, dataRoot, folderA);

      const result = await eraseDataFolder({
        dataRoot,
        defaultUserData,
        removePointer: true,
        trashItem,
        now,
      });

      assert.equal(result.ok, true);
      const entries = await zipEntries(path.join(trashDir, path.basename(result.zipPath)));
      assert.ok(entries.includes("transcriptions.db"));
      assert.ok(entries.includes("default-folder/transcriptions.db"));
      assert.ok(entries.includes("old-copy/transcriptions.db"));
      assert.ok(!entries.includes(`default-folder/${POINTER_FILE}`));
      assert.ok(!fs.existsSync(folderA));
      assert.deepEqual(fs.readdirSync(defaultUserData), []);
      assert.ok(!fs.existsSync(dataRoot));
    });

    for (const [label, aliasLive] of [
      ["the live folder is reached through a symlink", true],
      ["the old copy is named through a symlink", false],
    ]) {
      it(`symlink alias: ${label}, so an old copy holding the live store is never deleted`, async () => {
        const real = path.join(tempRoot, "real");
        const alias = path.join(tempRoot, "alias");
        fs.mkdirSync(real, { recursive: true });
        fs.symlinkSync(real, alias);
        const dataRoot = path.join(aliasLive ? alias : real, "store");
        const previous = aliasLive ? real : alias;
        const defaultUserData = path.join(tempRoot, "default");
        seedData(dataRoot);
        write(path.join(real, "keep.txt"), "not part of the live store");
        write(path.join(defaultUserData, PREVIOUS_ROOT_FILE), "{}");
        pointTo(defaultUserData, dataRoot, previous);

        const result = await eraseDataFolder({
          dataRoot,
          defaultUserData,
          removePointer: true,
          trashItem,
          now,
        });

        assert.equal(result.ok, true);
        const entries = await zipEntries(path.join(trashDir, path.basename(result.zipPath)));
        assert.ok(!entries.some((e) => e.startsWith("old-copy/")));
        assert.ok(fs.existsSync(path.join(real, "keep.txt")));
      });
    }

    it("a failed default-folder delete stops before the pointer and the live folder", async () => {
      const dataRoot = path.join(tempRoot, "drive", "data");
      const defaultUserData = path.join(tempRoot, "default");
      seedData(dataRoot);
      write(path.join(defaultUserData, "transcriptions.db"), "original db");
      pointTo(defaultUserData, dataRoot, path.join(tempRoot, "gone"));
      const defaultDb = path.join(path.resolve(defaultUserData), "transcriptions.db");

      const result = await eraseDataFolder({
        dataRoot,
        defaultUserData,
        removePointer: true,
        trashItem,
        now,
        rm: async (target, options) => {
          if (target === defaultDb) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          return fs.promises.rm(target, options);
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.step, "delete");
      assert.ok(fs.existsSync(path.join(trashDir, path.basename(result.zipPath))));
      assert.ok(fs.existsSync(path.join(defaultUserData, POINTER_FILE)));
      assert.ok(fs.existsSync(path.join(dataRoot, "transcriptions.db")));
      assert.ok(fs.existsSync(path.join(dataRoot, "audio", "a.wav")));
    });

    it("previousDataRoot names a missing folder: erases as before", async () => {
      const dataRoot = path.join(tempRoot, "drive", "data");
      const defaultUserData = path.join(tempRoot, "default");
      seedData(dataRoot);
      pointTo(defaultUserData, dataRoot, path.join(tempRoot, "gone"));
      write(path.join(defaultUserData, PENDING_MOVE_FILE), "{}");

      const result = await eraseDataFolder({
        dataRoot,
        defaultUserData,
        removePointer: true,
        trashItem,
        now,
      });

      assert.equal(result.ok, true);
      const entries = await zipEntries(path.join(trashDir, path.basename(result.zipPath)));
      assert.ok(entries.includes("transcriptions.db"));
      assert.ok(!entries.some((e) => e.startsWith("old-copy/")));
      assert.ok(!fs.existsSync(dataRoot));
      assert.ok(!fs.existsSync(path.join(defaultUserData, POINTER_FILE)));
      assert.ok(!fs.existsSync(path.join(defaultUserData, PENDING_MOVE_FILE)));
    });
  });

  it("refuses a call without an explicit removePointer", async () => {
    const dataRoot = path.join(tempRoot, "drive", "data");
    seedData(dataRoot);
    await assert.rejects(
      eraseDataFolder({ dataRoot, defaultUserData: tempRoot, trashItem, now }),
      TypeError
    );
    assert.ok(fs.existsSync(path.join(dataRoot, "transcriptions.db")));
  });
});
