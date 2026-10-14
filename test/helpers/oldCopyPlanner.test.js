const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { describe, it, before, after } = require("node:test");

const { planOldCopyRemoval } = require("../../src/helpers/oldCopyPlanner");
const { removeOldCopy } = require("../../src/helpers/dataFolderMove");

const ROOT = path.join(require("os").tmpdir(), "openwhispr-test-325");

describe("planOldCopyRemoval", () => {
  let old;
  let live;
  let base;
  before(() => {
    fs.mkdirSync(ROOT, { recursive: true });
    old = path.join(ROOT, "open-whispr");
    live = path.join(ROOT, "moved");
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(live, { recursive: true });
    base = {
      previousDataRoot: old,
      dataRoot: live,
      defaultUserData: old,
      keep: ["data-root.json", "pending-move.json"],
      entries: ["data-root.json", "logs", "audio", "transcriptions.db"],
    };
  });
  after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it("refuses when the previous root is missing", () => {
    assert.deepEqual(planOldCopyRemoval({ ...base, previousDataRoot: null }), {
      ok: false,
      reason: "missing",
    });
  });

  it("refuses the same path, even written differently", () => {
    const plan = planOldCopyRemoval({ ...base, previousDataRoot: `${live}/./` });
    assert.deepEqual(plan, { ok: false, reason: "sameAsLive" });
  });

  it("refuses when the live root is inside the old one", () => {
    const plan = planOldCopyRemoval({ ...base, dataRoot: path.join(old, "nested") });
    assert.deepEqual(plan, { ok: false, reason: "containsLive" });
  });

  it("keeps data-root.json and deletes every other top-level entry", () => {
    const plan = planOldCopyRemoval(base);
    assert.equal(plan.ok, true);
    assert.ok(!plan.paths.includes(path.join(old, "data-root.json")));
    for (const name of ["logs", "audio", "transcriptions.db"]) {
      assert.ok(plan.paths.includes(path.join(old, name)), name);
    }
  });

  it("applies KEEP only when the old root is the default userData folder", () => {
    const plan = planOldCopyRemoval({
      ...base,
      defaultUserData: path.join(ROOT, "elsewhere"),
      oldIsStore: true,
    });
    assert.ok(plan.paths.includes(path.join(old, "data-root.json")));
  });

  it("refuses a folder that is neither the default userData nor a marked store", () => {
    const home = path.join(ROOT, "home");
    const plan = planOldCopyRemoval({ ...base, previousDataRoot: home, entries: ["Documents"] });
    assert.deepEqual(plan, { ok: false, reason: "notAStore" });
    const marked = planOldCopyRemoval({ ...base, previousDataRoot: home, oldIsStore: true });
    assert.equal(marked.ok, true);
  });

  it("refuses a relative previous root", () => {
    const plan = planOldCopyRemoval({ ...base, previousDataRoot: "open-whispr" });
    assert.deepEqual(plan, { ok: false, reason: "missing" });
  });

  it("treats a differently-cased spelling of the live root as live when case-insensitive", () => {
    const plan = planOldCopyRemoval({
      ...base,
      previousDataRoot: live.toUpperCase(),
      oldIsStore: true,
      caseInsensitive: true,
    });
    assert.deepEqual(plan, { ok: false, reason: "sameAsLive" });
  });

  it("never plans the shared home model cache", () => {
    const plan = planOldCopyRemoval({
      ...base,
      cacheRoot: path.join(live, "cache"),
      defaultCacheRoot: path.join(ROOT, ".cache", "openwhispr"),
    });
    assert.ok(
      plan.paths.every((p) => path.dirname(p) === old),
      plan.paths.join()
    );
  });

  it("never returns the live root or anything inside it", () => {
    const plan = planOldCopyRemoval({
      ...base,
      entries: ["logs", "../moved", "../moved/x"],
    });
    for (const p of plan.paths) {
      const rel = path.relative(live, p);
      assert.ok(rel.startsWith("..") || path.isAbsolute(rel), p);
    }
  });
});

describe("removeOldCopy on disk", () => {
  const DISK = path.join(ROOT, "disk");
  const write = (p, body = "x") => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  const setup = (previousDataRoot) => {
    const defaultUserData = path.join(DISK, "default");
    write(path.join(defaultUserData, "data-root.json"), JSON.stringify({ previousDataRoot }));
    return defaultUserData;
  };
  before(() => fs.rmSync(DISK, { recursive: true, force: true }));
  after(() => fs.rmSync(DISK, { recursive: true, force: true }));

  it("refuses an old root that is a symlink to the live store", async () => {
    const live = path.join(DISK, "live");
    write(path.join(live, "transcriptions.db"));
    const link = path.join(DISK, "link");
    fs.symlinkSync(live, link);
    const defaultUserData = setup(link);
    const result = await removeOldCopy({ defaultUserData, dataRoot: live, channel: "production" });
    assert.deepEqual(result, { ok: false, reason: "sameAsLive" });
    assert.ok(fs.existsSync(path.join(live, "transcriptions.db")));
  });

  it("refuses an unmarked folder and deletes nothing in it", async () => {
    const stranger = path.join(DISK, "home");
    write(path.join(stranger, "Documents", "keep.txt"));
    const defaultUserData = setup(stranger);
    const live = path.join(DISK, "live2");
    fs.mkdirSync(live, { recursive: true });
    const result = await removeOldCopy({ defaultUserData, dataRoot: live, channel: "production" });
    assert.deepEqual(result, { ok: false, reason: "notAStore" });
    assert.ok(fs.existsSync(path.join(stranger, "Documents", "keep.txt")));
  });

  it("removes a marked old store of this channel", async () => {
    const oldStore = path.join(DISK, "old-store");
    write(path.join(oldStore, ".openwhispr-store.json"), JSON.stringify({ channel: "production" }));
    write(path.join(oldStore, "transcriptions.db"));
    const defaultUserData = setup(oldStore);
    const live = path.join(DISK, "live3");
    fs.mkdirSync(live, { recursive: true });
    const result = await removeOldCopy({ defaultUserData, dataRoot: live, channel: "production" });
    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(path.join(oldStore, "transcriptions.db")));
  });
});
