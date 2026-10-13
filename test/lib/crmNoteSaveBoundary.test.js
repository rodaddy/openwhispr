const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/lib/crmNoteSaveBoundary.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("CRM save boundary persists an edit that arrives while the first save is pending", async () => {
  const { persistStableCrmNoteDraft } = await load();
  let draft = { noteId: 7, title: "N", content: "one", enhancedContent: null };
  const saves = [];
  const first = deferred();
  const second = deferred();

  const run = persistStableCrmNoteDraft({
    getDraft: () => draft,
    save: (snapshot) => {
      saves.push({ ...snapshot });
      return saves.length === 1 ? first.promise : second.promise;
    },
  });

  await Promise.resolve();
  draft = { ...draft, content: "two" };
  first.resolve({ success: true });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    saves.map((save) => save.content),
    ["one", "two"]
  );
  second.resolve({ success: true });
  await run;
});

test("CRM save boundary rejects a failed save before export and keeps the current draft", async () => {
  const { persistStableCrmNoteDraft } = await load();
  const draft = { noteId: 9, title: "Keep", content: "unsaved", enhancedContent: "draft" };
  let exported = false;

  await assert.rejects(async () => {
    await persistStableCrmNoteDraft({
      getDraft: () => draft,
      save: async () => ({ success: false }),
    });
    exported = true;
  }, /Could not save/);

  assert.equal(exported, false);
  assert.equal(draft.content, "unsaved");
});

test("CRM save boundary aborts when the active note changes", async () => {
  const { persistStableCrmNoteDraft } = await load();
  let draft = { noteId: 11, title: "A", content: "one", enhancedContent: null };
  const save = deferred();
  const run = persistStableCrmNoteDraft({ getDraft: () => draft, save: () => save.promise });

  await Promise.resolve();
  draft = { noteId: 12, title: "B", content: "other", enhancedContent: null };
  save.resolve({ success: true });

  await assert.rejects(run, /changed before CRM sync/);
});
