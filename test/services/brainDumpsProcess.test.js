const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/brainDumps/processDumps.ts");

const dumps = [
  { id: 1, content: "buy milk" },
  { id: 2, content: "why is the build slow" },
  { id: 3, content: "idea for the app" },
];

function fakeApi(classify) {
  const calls = { classify: [], processed: null };
  return {
    calls,
    deps: {
      list: async () => ({ dumps, systemPrompt: "SORT" }),
      classify: async (systemPrompt, content) => {
        calls.classify.push([systemPrompt, content]);
        return classify(content);
      },
      process: async (outputs) => {
        calls.processed = outputs;
        return Object.keys(outputs).map((id) => ({ noteId: Number(id), kind: "note" }));
      },
    },
  };
}

test("each dump goes to the model with the IPC system prompt, outputs keyed by note id", async () => {
  const { processDumps } = await load();
  const api = fakeApi((content) => `reply:${content}`);
  const run = await processDumps(api.deps);
  assert.deepEqual(api.calls.classify, [
    ["SORT", "buy milk"],
    ["SORT", "why is the build slow"],
    ["SORT", "idea for the app"],
  ]);
  assert.deepEqual(api.calls.processed, {
    1: "reply:buy milk",
    2: "reply:why is the build slow",
    3: "reply:idea for the app",
  });
  assert.equal(run.dumps.length, 3);
  assert.equal(run.results.length, 3);
});

test("a model error for one dump sends no reply for it and the others still run", async () => {
  const { processDumps } = await load();
  const api = fakeApi((content) => {
    if (content === "why is the build slow") throw new Error("model down");
    return "ok";
  });
  await processDumps(api.deps);
  assert.equal(api.calls.classify.length, 3);
  assert.deepEqual(api.calls.processed, { 1: "ok", 3: "ok" });
});

test("progress counts each dump as it starts, out of the total", async () => {
  const { processDumps } = await load();
  const seen = [];
  const api = fakeApi(() => "ok");
  await processDumps({ ...api.deps, onProgress: (done, total) => seen.push([done, total]) });
  assert.deepEqual(seen, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test("every model call failing surfaces the first error, not an all-Not-classified run", async () => {
  const { processDumps } = await load();
  let n = 0;
  const api = fakeApi(() => {
    n += 1;
    throw new Error(n === 1 ? "No AI model is set up for note formatting" : "other");
  });
  await assert.rejects(processDumps(api.deps), /No AI model is set up for note formatting/);
  assert.equal(api.calls.processed, null);
});
