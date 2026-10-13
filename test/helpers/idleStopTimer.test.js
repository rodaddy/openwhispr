const test = require("node:test");
const assert = require("node:assert/strict");

const { createIdleStopTimer, resolveIdleMs } = require("../../src/helpers/idleStopTimer");

// Manual timer: nothing fires until the test says so.
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeoutImpl(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutImpl(id) {
      pending.delete(id);
    },
    pendingCount: () => pending.size,
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fireAll() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.fn();
    },
  };
}

function timerWith(overrides = {}) {
  const timers = fakeTimers();
  const calls = [];
  const timer = createIdleStopTimer({
    idleMs: 1000,
    onIdle: () => calls.push("idle"),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...overrides,
  });
  return { timer, timers, calls };
}

test("fires onIdle once after the idle period", () => {
  const { timer, timers, calls } = timerWith();

  timer.arm();
  assert.deepEqual(timers.delays(), [1000]);
  timers.fireAll();

  assert.deepEqual(calls, ["idle"]);
  assert.equal(timers.pendingCount(), 0);
});

test("re-arming replaces the pending timer instead of stacking", () => {
  const { timer, timers, calls } = timerWith();

  timer.arm();
  timer.arm();
  assert.equal(timers.pendingCount(), 1);
  timers.fireAll();

  assert.deepEqual(calls, ["idle"]);
});

test("begin cancels a pending idle stop", () => {
  const { timer, timers, calls } = timerWith();

  timer.arm();
  timer.begin();

  assert.equal(timers.pendingCount(), 0);
  assert.equal(timer.activeCount(), 1);
  timers.fireAll();
  assert.deepEqual(calls, []);
});

test("arm is a no-op while in use", () => {
  const { timer, timers } = timerWith();

  timer.begin();
  timer.arm();

  assert.equal(timers.pendingCount(), 0);
});

test("nested begin/end only arms once the count reaches zero", () => {
  const { timer, timers, calls } = timerWith();

  timer.begin();
  timer.begin();
  timer.end();
  assert.equal(timer.activeCount(), 1);
  assert.equal(timers.pendingCount(), 0);

  timer.end();
  assert.equal(timer.activeCount(), 0);
  assert.equal(timers.pendingCount(), 1);
  timers.fireAll();
  assert.deepEqual(calls, ["idle"]);
});

test("end below zero is safe and never goes negative", () => {
  const { timer, timers } = timerWith();

  timer.end();
  timer.end();
  assert.equal(timer.activeCount(), 0);
  assert.equal(timers.pendingCount(), 1);

  timer.begin();
  assert.equal(timer.activeCount(), 1);
});

test("a timer that fires while in use does not call onIdle", () => {
  const timers = fakeTimers();
  const calls = [];
  // clearTimeout that loses the race: the callback still runs after begin().
  const timer = createIdleStopTimer({
    idleMs: 1000,
    onIdle: () => calls.push("idle"),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: () => {},
  });

  timer.arm();
  timer.begin();
  timers.fireAll();

  assert.deepEqual(calls, []);
});

test("onIdle throwing is swallowed", () => {
  const { timer, timers } = timerWith({
    onIdle: () => {
      throw new Error("boom");
    },
  });

  timer.arm();
  assert.doesNotThrow(() => timers.fireAll());
});

test("onIdle rejecting is swallowed", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { timer, timers } = timerWith({ onIdle: async () => Promise.reject(new Error("boom")) });

    timer.arm();
    timers.fireAll();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("idleMs 0, negative or non-finite never arms and never counts", () => {
  for (const idleMs of [0, -5, NaN, Infinity, undefined]) {
    const { timer, timers, calls } = timerWith({ idleMs });

    timer.arm();
    timer.begin();
    timer.end();
    timer.cancel();

    assert.equal(timers.pendingCount(), 0, `idleMs=${idleMs}`);
    assert.equal(timer.activeCount(), 0, `idleMs=${idleMs}`);
    assert.deepEqual(calls, []);
  }
});

test("the real timer handle is unref'd so it cannot hold the process open", () => {
  let unrefs = 0;
  const timer = createIdleStopTimer({
    idleMs: 1000,
    onIdle: () => {},
    setTimeoutImpl: () => ({ unref: () => (unrefs += 1) }),
    clearTimeoutImpl: () => {},
  });

  timer.arm();

  assert.equal(unrefs, 1);
});

test("resolveIdleMs table", () => {
  const cases = [
    [undefined, 600000],
    ["", 600000],
    ["0", 0],
    ["5", 30000],
    ["30", 30000],
    ["600", 600000],
    ["abc", 600000],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveIdleMs(input), expected, `input=${JSON.stringify(input)}`);
  }
  assert.equal(resolveIdleMs(undefined, 120), 120000);
});

test("a delay past the 32-bit timer limit is clamped instead of firing at once", () => {
  // Node turns a delay above 2^31-1 ms into 1 ms.
  const { timer, timers } = timerWith({ idleMs: resolveIdleMs("3000000") });

  timer.arm();

  assert.deepEqual(timers.delays(), [2 ** 31 - 1]);
});

test("an idle period past the 32-bit timer limit fires only once the whole period has passed", () => {
  const idleMs = 3_000_000_000;
  const cap = 2 ** 31 - 1;
  let clock = 0;
  const { timer, timers, calls } = timerWith({ idleMs, now: () => clock });

  timer.arm();
  clock += cap;
  timers.fireAll();

  assert.deepEqual(calls, [], "the capped timer is not the end of the idle period");
  assert.deepEqual(timers.delays(), [idleMs - cap]);

  clock = idleMs;
  timers.fireAll();

  assert.deepEqual(calls, ["idle"]);
  assert.equal(timers.pendingCount(), 0);
});
