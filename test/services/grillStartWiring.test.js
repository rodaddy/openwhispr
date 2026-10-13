const test = require("node:test");
const assert = require("node:assert/strict");

const loadWiring = () => import("../../src/services/grill/grillStartSubscription.ts");
const loadSession = () => import("../../src/services/grill/grillSession.ts");

function fakeApi() {
  const listeners = [];
  let unsubscribed = 0;
  return {
    listeners,
    unsubscribed: () => unsubscribed,
    onGrillStart: (callback) => {
      listeners.push(callback);
      return () => {
        unsubscribed += 1;
        listeners.splice(listeners.indexOf(callback), 1);
      };
    },
  };
}
const quietLog = { warn: () => {} };

test("subscribes to grill:start and hands {kind, chapter} to startGrillSession", async () => {
  const { subscribeToGrillStart } = await loadWiring();
  const api = fakeApi();
  const started = [];
  const unsubscribe = subscribeToGrillStart(api, (request) => started.push(request), quietLog);
  assert.equal(api.listeners.length, 1);

  api.listeners[0]({ kind: "daily", chapter: null, eventId: "evt-1" });
  api.listeners[0]({ kind: "lifetime", chapter: 3, eventId: "evt-2" });
  assert.deepEqual(started, [{ kind: "daily" }, { kind: "lifetime", chapter: 3 }]);

  unsubscribe();
  assert.equal(api.unsubscribed(), 1);
  assert.equal(api.listeners.length, 0);
});

test("each mount subscribes again, so a reloaded page keeps receiving grill:start", async () => {
  const { subscribeToGrillStart } = await loadWiring();
  const api = fakeApi();
  const first = subscribeToGrillStart(api, () => {}, quietLog);
  first(); // the page reloads: the old subscription is gone
  subscribeToGrillStart(api, () => {}, quietLog);
  assert.equal(api.listeners.length, 1);
});

test("a malformed request is logged and dropped, never started", async () => {
  const { subscribeToGrillStart } = await loadWiring();
  const api = fakeApi();
  const started = [];
  const warnings = [];
  subscribeToGrillStart(api, (request) => started.push(request), {
    warn: (message) => warnings.push(message),
  });
  api.listeners[0]({ kind: "weekly" });
  api.listeners[0]({ kind: "lifetime", chapter: null });
  api.listeners[0](null);
  assert.equal(started.length, 0);
  assert.equal(warnings.length, 3);
});

test("with no onGrillStart bridge, subscribing is a no-op", async () => {
  const { subscribeToGrillStart } = await loadWiring();
  const unsubscribe = subscribeToGrillStart({}, () => {}, quietLog);
  assert.doesNotThrow(unsubscribe);
});

test("a start in flight is shared: a double click runs one start, not a false 'unsaved grill'", async () => {
  const { createSingleFlight } = await loadSession();
  const busy = [];
  const flight = createSingleFlight((value) => busy.push(value));
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const start = () => {
    runs += 1;
    return gate.then(() => "plan");
  };
  const first = flight.run(start);
  const second = flight.run(start);
  assert.equal(flight.busy(), true);
  release();
  assert.equal(await first, "plan");
  assert.equal(await second, "plan");
  assert.equal(runs, 1);
  assert.equal(flight.busy(), false);
  assert.deepEqual(busy, [true, false]);
  // A later start runs again.
  await flight.run(start);
  assert.equal(runs, 2);
});

test("a failed start clears the in-flight flag", async () => {
  const { createSingleFlight } = await loadSession();
  const flight = createSingleFlight();
  await assert.rejects(flight.run(() => Promise.reject(new Error("no calendar"))));
  assert.equal(flight.busy(), false);
});

test("the Start grill menu is disabled while a start is in flight or a draft waits", async () => {
  const { grillStartDisabled } = await loadSession();
  assert.equal(grillStartDisabled({ starting: false, pendingDraft: null }), false);
  assert.equal(grillStartDisabled({ starting: true, pendingDraft: null }), true);
  assert.equal(grillStartDisabled({ starting: false, pendingDraft: {} }), true);
});
