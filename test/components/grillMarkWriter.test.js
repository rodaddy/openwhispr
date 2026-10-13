// rtech-whisper#134: a failed mark write must not roll the UI back over a
// newer write that already succeeded.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGrillMarkWriter } = require("../../src/components/chat/useGrillMarks.ts");

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function setup(initial = null) {
  let shown = initial;
  const stored = { value: initial };
  const pending = [];
  const write = createGrillMarkWriter({
    current: () => shown,
    apply: (_q, state) => {
      shown = state;
    },
    persist: (_q, next) => {
      const d = deferred();
      pending.push({ next, settle: (ok) => (ok && (stored.value = next), d.resolve(ok)) });
      return d.promise;
    },
    reload: async () => stored.value,
  });
  return { write, pending, shown: () => shown, stored };
}

const GOOD = { mark: "good", note: null };
const WEAK = { mark: "weak", note: null };

test("an older write failing after a newer one succeeded keeps the newer mark", async () => {
  const s = setup(null);
  const a = s.write("q1", GOOD);
  const b = s.write("q1", WEAK);
  s.pending[1].settle(true);
  assert.equal(await b, true);
  s.pending[0].settle(false);
  assert.equal(await a, false);
  assert.deepEqual(s.shown(), WEAK);
  assert.deepEqual(s.stored.value, WEAK);
});

test("the latest write failing shows what the store holds", async () => {
  const s = setup(GOOD);
  const a = s.write("q1", WEAK);
  s.pending[0].settle(false);
  assert.equal(await a, false);
  assert.deepEqual(s.shown(), GOOD);
});

test("both writes failing out of order still ends on the stored mark", async () => {
  const s = setup(null);
  const a = s.write("q1", GOOD);
  const b = s.write("q1", WEAK);
  s.pending[1].settle(false);
  await b;
  s.pending[0].settle(false);
  await a;
  assert.equal(s.shown(), null);
});
