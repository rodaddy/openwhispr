const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/stores/brainDumpRunStore.ts");

// review desktop-pr-395: a run's progress and Last run rows must outlive the
// view, so a run finished after the user switched away still shows its Undo rows.
test("run progress and results live in the module store, not the view", async () => {
  const { startBrainDumpRun, useBrainDumpRunStore } = await load();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const running = startBrainDumpRun(
    {
      list: async () => ({ dumps: [{ id: 7, content: "buy milk\nand eggs" }], systemPrompt: "S" }),
      classify: async () => {
        await gate;
        return "reply";
      },
      process: async () => [{ noteId: 7, kind: "todo", actionId: 42 }],
    },
    1
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(useBrainDumpRunStore.getState().progress, { current: 1, total: 1 });
  release();
  await running;
  const state = useBrainDumpRunStore.getState();
  assert.equal(state.progress, null);
  assert.deepEqual(state.results, [{ noteId: 7, kind: "todo", actionId: 42, title: "buy milk" }]);
});

test("a second start while a run is in flight does nothing", async () => {
  const { startBrainDumpRun } = await load();
  let listCalls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const deps = {
    list: async () => {
      listCalls += 1;
      await gate;
      return { dumps: [], systemPrompt: "S" };
    },
    classify: async () => "x",
    process: async () => [],
  };
  const first = startBrainDumpRun(deps, 0);
  await startBrainDumpRun(deps, 0);
  release();
  await first;
  assert.equal(listCalls, 1);
});

test("an Undo the engine refused shows its error on the row and stays enabled", async () => {
  const { useBrainDumpRunStore, undoBrainDumpRow } = await load();
  const row = { noteId: 9, kind: "todo", actionId: 5, title: "t" };
  useBrainDumpRunStore.setState({ results: [row], error: null });
  await undoBrainDumpRow(row, async () => ({
    success: true,
    undone: false,
    error: "The original note is missing or deleted",
  }));
  let [after] = useBrainDumpRunStore.getState().results;
  assert.equal(after.undone, undefined);
  assert.equal(after.undoError, "The original note is missing or deleted");
  await undoBrainDumpRow(after, async () => ({ success: true, undone: true }));
  [after] = useBrainDumpRunStore.getState().results;
  assert.equal(after.undone, true);
  assert.equal(after.undoError, undefined);
});
