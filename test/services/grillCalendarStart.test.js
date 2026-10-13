const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/services/grill/grillStartSubscription.ts");

test("a calendar grill:start while a grill is running is ignored with a toast", async () => {
  const { routeCalendarGrillStart } = await load();
  const log = [];
  routeCalendarGrillStart(
    { kind: "daily" },
    {
      running: true,
      start: () => log.push("start (would cancel the interviewer stream)"),
      alreadyRunning: () => log.push("toast"),
    }
  );
  assert.deepEqual(log, ["toast"]);
});

test("a calendar grill:start with no grill running starts one", async () => {
  const { routeCalendarGrillStart } = await load();
  const started = [];
  routeCalendarGrillStart(
    { kind: "lifetime", chapter: 2 },
    { running: false, start: (r) => started.push(r), alreadyRunning: () => started.push("toast") }
  );
  assert.deepEqual(started, [{ kind: "lifetime", chapter: 2 }]);
});

test("the English toast reads 'A grill is already running'", () => {
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  assert.equal(en.chat.grill.alreadyRunning, "A grill is already running");
  assert.equal(en.chat.grill.voice.answerSkipped, "Answer skipped");
});

test("ChatView's grill:start routing: running is a session or a start in flight", async () => {
  const { routeChatGrillStart } = await load();
  const cases = [
    [{ session: { plan: {} }, isStarting: false }, ["toast"]],
    [{ session: null, isStarting: true }, ["toast"]],
    [{ session: { plan: {} }, isStarting: true }, ["toast"]],
    [{ session: null, isStarting: false }, ["start"]],
    [{ session: undefined, isStarting: false }, ["start"]],
  ];
  for (const [grill, expected] of cases) {
    const log = [];
    routeChatGrillStart({ kind: "daily" }, grill, {
      start: () => log.push("start"),
      alreadyRunning: () => log.push("toast"),
    });
    assert.deepEqual(log, expected, JSON.stringify(grill));
  }
});
