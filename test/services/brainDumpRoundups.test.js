const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/brainDumps/roundups.ts");

const TIMES = { morning: "09:30", night: "23:00" };
// Local wall-clock times, so the tests hold in any time zone.
const at = (day, hh, mm) => new Date(2026, 8, day, hh, mm);

test("nothing is due before the morning time", async () => {
  const { dueRoundupSlots } = await load();
  assert.deepEqual(dueRoundupSlots(at(30, 9, 29), TIMES, {}), []);
});

test("a slot is due once its time has passed and it has not run today", async () => {
  const { dueRoundupSlots } = await load();
  assert.deepEqual(dueRoundupSlots(at(30, 9, 30), TIMES, {}), ["morning"]);
});

test("a slot that already ran today is not due again", async () => {
  const { dueRoundupSlots } = await load();
  const lastRuns = { morning: at(30, 9, 31).toISOString() };
  assert.deepEqual(dueRoundupSlots(at(30, 12, 0), TIMES, lastRuns), []);
});

test("a slot that last ran yesterday is due again today", async () => {
  const { dueRoundupSlots } = await load();
  const lastRuns = { morning: at(29, 9, 30).toISOString(), night: at(29, 23, 0).toISOString() };
  assert.deepEqual(dueRoundupSlots(at(30, 10, 0), TIMES, lastRuns), ["morning"]);
});

test("after a long sleep both slots are due, each once", async () => {
  const { dueRoundupSlots } = await load();
  const lastRuns = { morning: at(27, 9, 30).toISOString(), night: at(27, 23, 0).toISOString() };
  assert.deepEqual(dueRoundupSlots(at(30, 23, 30), TIMES, lastRuns), ["morning", "night"]);
});

test("missed past days are not backfilled: before today's times nothing runs", async () => {
  const { dueRoundupSlots } = await load();
  const lastRuns = { morning: at(20, 9, 30).toISOString(), night: at(20, 23, 0).toISOString() };
  assert.deepEqual(dueRoundupSlots(at(30, 8, 0), TIMES, lastRuns), []);
});

test("a malformed time never fires", async () => {
  const { dueRoundupSlots } = await load();
  assert.deepEqual(dueRoundupSlots(at(30, 23, 59), { morning: "", night: "25:00" }, {}), []);
});

function fakes({ dumps, actions = [] }) {
  const calls = { context: [], summarize: [], save: [] };
  return {
    calls,
    deps: {
      now: () => at(30, 23, 0),
      since: at(30, 9, 30).toISOString(),
      context: async (sinceIso) => {
        calls.context.push(sinceIso);
        return { dumps, actions };
      },
      summarize: async (systemPrompt, content) => {
        calls.summarize.push([systemPrompt, content]);
        return "  SUMMARY  ";
      },
      save: async (title, content) => {
        calls.save.push([title, content]);
      },
    },
  };
}

test("a run with no new dumps saves nothing and calls no model", async () => {
  const { runRoundup } = await load();
  const api = fakes({ dumps: [] });
  const outcome = await runRoundup("night", api.deps);
  assert.equal(outcome.saved, false);
  assert.deepEqual(api.calls.context, [at(30, 9, 30).toISOString()]);
  assert.deepEqual(api.calls.summarize, []);
  assert.deepEqual(api.calls.save, []);
});

test("a run with dumps saves one note titled with the date and slot", async () => {
  const { runRoundup } = await load();
  const api = fakes({
    dumps: [{ title: "", content: "buy milk", createdAt: "2026-09-30 14:00:00" }],
    actions: [{ kind: "todo", target: "Reminders", title: "buy milk", createdAt: "x" }],
  });
  const outcome = await runRoundup("night", api.deps);
  assert.equal(outcome.saved, true);
  assert.equal(api.calls.summarize.length, 1);
  assert.match(api.calls.summarize[0][1], /buy milk/);
  assert.match(api.calls.summarize[0][1], /Reminders/);
  assert.deepEqual(api.calls.save, [["Roundup 2026-09-30 night", "SUMMARY"]]);
});

test("the Run now slot follows the current time", async () => {
  const { currentRoundupSlot } = await load();
  assert.equal(currentRoundupSlot(at(30, 12, 0), TIMES), "morning");
  assert.equal(currentRoundupSlot(at(30, 23, 30), TIMES), "night");
  assert.equal(currentRoundupSlot(at(30, 2, 0), TIMES), "night");
});

test("a failed slot backs off, then gives up for the day (review desktop-pr-396)", async () => {
  const { dueRoundupSlots, recordRoundupFailure, MAX_ROUNDUP_TRIES } = await load();
  let failures = recordRoundupFailure({}, "morning", at(30, 9, 30), TIMES);
  assert.equal(failures.morning.tries, 1);
  // Not retried the next minute: this was the every-60-s paid loop.
  assert.deepEqual(dueRoundupSlots(at(30, 9, 31), TIMES, {}, failures), []);
  assert.deepEqual(dueRoundupSlots(at(30, 9, 35), TIMES, {}, failures), ["morning"]);
  for (let i = 1; i < MAX_ROUNDUP_TRIES; i += 1) {
    failures = recordRoundupFailure(failures, "morning", at(30, 10 + i, 0), TIMES);
  }
  assert.equal(failures.morning.tries, MAX_ROUNDUP_TRIES);
  assert.deepEqual(dueRoundupSlots(at(30, 22, 59), TIMES, {}, failures), []);
  // A new day starts over.
  assert.deepEqual(dueRoundupSlots(at(31, 9, 30), TIMES, {}, failures), ["morning"]);
  assert.equal(recordRoundupFailure(failures, "morning", at(31, 9, 30), TIMES).morning.tries, 1);
});

test("a failed summarize or save throws, so the slot is not marked done", async () => {
  const { runRoundup } = await load();
  const dumps = [{ title: "", content: "x", createdAt: "2026-09-30 14:00:00" }];
  const empty = fakes({ dumps });
  empty.deps.summarize = async () => "   ";
  await assert.rejects(runRoundup("night", empty.deps), /empty roundup/);
  const failedSave = fakes({ dumps });
  failedSave.deps.save = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(runRoundup("night", failedSave.deps), /disk full/);
});

test("a run passes the arrival cursor and returns the next one", async () => {
  const { runRoundup } = await load();
  const api = fakes({ dumps: [] });
  const seen = [];
  api.deps.afterNoteId = 41;
  api.deps.context = async (sinceIso, afterNoteId) => {
    seen.push(afterNoteId);
    return { dumps: [], actions: [], lastNoteId: 57 };
  };
  const outcome = await runRoundup("night", api.deps);
  assert.deepEqual(seen, [41]);
  assert.equal(outcome.lastNoteId, 57);
});

test("a stored time that is not HH:MM falls back to the default", async () => {
  const { resolveRoundupTimes, isRoundupTime } = await load();
  assert.deepEqual(resolveRoundupTimes({ morning: "", night: "25:00" }), {
    morning: "09:30",
    night: "23:00",
  });
  assert.deepEqual(resolveRoundupTimes({ morning: "07:15", night: "9:5" }), {
    morning: "07:15",
    night: "23:00",
  });
  assert.equal(isRoundupTime("08:00"), true);
  for (const bad of ["", "8:00", "24:00", "12:60", "12:00:00", undefined]) {
    assert.equal(isRoundupTime(bad), false, String(bad));
  }
});

test("roundup input keeps the newest 100 dumps and says how many were left out", async () => {
  const { runRoundup } = await load();
  const dumps = Array.from({ length: 130 }, (_, i) => ({
    title: "",
    content: `dump ${i}`,
    createdAt: `2026-09-30 ${String(i).padStart(4, "0")}`,
  }));
  const api = fakes({ dumps });
  await runRoundup("night", api.deps);
  const input = api.calls.summarize[0][1];
  assert.match(input, /30 older dumps not included/);
  assert.doesNotMatch(input, /dump 29\b/);
  assert.match(input, /dump 30\b/);
  assert.match(input, /dump 129\b/);
  assert.match(api.calls.save[0][1], /^SUMMARY\n\n.*30 older dumps not included/s);
});

test("roundup input is capped at 20,000 characters, newest first", async () => {
  const { runRoundup } = await load();
  const dumps = Array.from({ length: 5 }, (_, i) => ({
    title: "",
    content: `${i}`.repeat(6000),
    createdAt: `2026-09-30 1${i}:00:00`,
  }));
  const api = fakes({ dumps });
  await runRoundup("night", api.deps);
  const input = api.calls.summarize[0][1];
  assert.match(input, /2 older dumps not included/);
  assert.ok(!input.includes("1".repeat(6000)));
  assert.ok(input.includes("4".repeat(6000)));
  assert.match(api.calls.save[0][1], /2 older dumps not included/);
});

test("nothing left out: no note about older dumps", async () => {
  const { runRoundup } = await load();
  const api = fakes({ dumps: [{ title: "", content: "x", createdAt: "2026-09-30 14:00:00" }] });
  await runRoundup("night", api.deps);
  assert.doesNotMatch(api.calls.summarize[0][1], /not included/);
  assert.deepEqual(api.calls.save, [["Roundup 2026-09-30 night", "SUMMARY"]]);
});
