const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/stores/assistantSpeechProviderSetter.ts");

// A fake store plus a main link whose send and read promises the test settles by hand.
const harness = async (initial) => {
  const { createAssistantSpeechProviderSetter } = await load();
  let current = initial;
  const writes = [];
  const warnings = [];
  const sends = [];
  const reads = [];
  let linked = true;
  const deferred = (list) => () => new Promise((resolve, reject) => list.push({ resolve, reject }));
  const set = createAssistantSpeechProviderSetter({
    read: () => current,
    write: (value) => {
      current = value;
      writes.push(value);
    },
    warn: (message, error) => warnings.push({ message, error }),
    main: () => (linked ? { send: deferred(sends), read: deferred(reads) } : undefined),
  });
  // Settled handlers need a turn before the next step of the setter runs.
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const unlink = () => {
    linked = false;
  };
  return { set, writes, warnings, sends, reads, flush, unlink, value: () => current };
};

test("a late failure of an older request does not undo a newer choice of the same value", async () => {
  const h = await harness("hub");
  h.set("local");
  h.set("auto");
  h.set("local");

  h.sends[0].reject(new Error("timed out"));
  await h.flush();

  assert.equal(h.value(), "local");
  assert.deepEqual(h.writes, ["local", "auto", "local"]);
});

test("a failed change returns the store to what the main process reports", async () => {
  const h = await harness("hub");
  h.set("local");

  h.sends[0].reject(new Error("main refused"));
  await h.flush();
  h.reads[0].resolve("hub");
  await h.flush();

  assert.equal(h.value(), "hub");
  assert.deepEqual(h.warnings, [
    { message: "Assistant speech provider was not applied", error: "main refused" },
  ]);
});

test("the store adopts the provider the main process answers with", async () => {
  const h = await harness("hub");
  h.set("local");

  h.sends[0].resolve({ provider: "auto" });
  await h.flush();

  assert.equal(h.value(), "auto");
  assert.equal(h.warnings.length, 1);
});

test("two failed changes in flight end on what the main process reports", async () => {
  const h = await harness("hub");
  h.set("local");
  h.set("auto");

  h.sends[0].reject(new Error("timed out"));
  h.sends[1].reject(new Error("timed out"));
  await h.flush();
  h.reads[0].resolve("hub");
  await h.flush();

  assert.equal(h.value(), "hub");
});

test("a failure after an older change was applied ends on the value the main process applied", async () => {
  const h = await harness("hub");
  h.set("local");
  h.set("auto");

  h.sends[0].resolve({ provider: "local" });
  await h.flush();
  h.sends[1].reject(new Error("timed out"));
  await h.flush();
  h.reads[0].resolve("local");
  await h.flush();

  assert.equal(h.value(), "local");
});

test("a failure with the main process unreachable keeps the choice and rejects nothing", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = await harness("hub");
    h.set("local");

    h.sends[0].reject(new Error("timed out"));
    await h.flush();
    h.reads[0].reject(new Error("main is gone"));
    await h.flush();

    assert.equal(h.value(), "local");
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a change made without the main link makes an older pending request stale", async () => {
  const h = await harness("hub");
  h.set("local");
  h.unlink();
  h.set("auto");

  h.sends[0].resolve({ provider: "local" });
  await h.flush();

  assert.equal(h.value(), "auto");
});
