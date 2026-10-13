const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/dailyQuestions.ts");

// 10:00 local on 2026-09-26, the daily grill block.
const NOW = new Date(2026, 8, 26, 10, 0, 0);
const local = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const sqliteUtc = (iso) => iso.replace("T", " ").replace(/\.\d+Z$/, "");

function event(id, summary, start, end, attendees, overrides = {}) {
  return {
    id,
    summary,
    start_time: start,
    end_time: end,
    is_all_day: 0,
    status: "confirmed",
    attendees_count: attendees.length,
    attendees: JSON.stringify(attendees),
    ...overrides,
  };
}

const me = { email: "rico@example.com", displayName: "Rico", self: true };
const dana = { email: "dana@example.com", displayName: "Dana Park", self: false };
const lee = { email: "lee@example.com", displayName: null, self: false };

const EVENTS = [
  event("ev-old", "Last week sync", local(19, 9), local(19, 10), [me, dana]),
  event("ev-pricing", "Q3 pricing", local(25, 14), local(25, 15), [me, dana]),
  event("ev-solo", "Focus block", local(25, 16), local(25, 17), []),
  event("ev-allday", "Holiday", "2026-09-25", "2026-09-26", [me, dana], { is_all_day: 1 }),
  event("ev-cancelled", "Cancelled call", local(25, 11), local(25, 12), [me, lee], {
    status: "cancelled",
  }),
  event("ev-acme", "Acme kickoff", local(25, 9), local(25, 10), [me, dana, lee]),
  event("ev-today", "Hiring loop", local(26, 8), local(26, 9), [me, lee]),
];

const MEETING_NOTES = [
  {
    id: 7,
    title: "Acme kickoff",
    note_type: "meeting",
    calendar_event_id: "ev-acme",
    created_at: sqliteUtc(local(25, 10, 5)),
    participants: JSON.stringify([dana]),
    transcript: JSON.stringify([
      { text: "Thanks everyone for joining.", source: "system" },
      { text: "Okay.", source: "mic" },
      {
        text: "We ship on Fridays because the client reviews on Monday morning and never before",
        source: "mic",
      },
    ]),
  },
  {
    id: 8,
    title: "Vendor call",
    note_type: "meeting",
    calendar_event_id: null,
    created_at: sqliteUtc(local(26, 8, 30)),
    participants: JSON.stringify([{ email: "sam@example.com", displayName: "Sam Ortiz" }]),
    transcript: null,
  },
  {
    id: 9,
    title: "Too old",
    note_type: "meeting",
    created_at: sqliteUtc(local(24, 8)),
    participants: null,
    transcript: JSON.stringify([{ text: "Old words from two days ago here", source: "mic" }]),
  },
];

test("fills the bank's templates from meeting notes first, then calendar events", async () => {
  const { selectDayQuestions } = await load();
  const questions = selectDayQuestions({ events: EVENTS, meetingNotes: MEETING_NOTES, now: NOW });

  assert.deepEqual(questions, [
    "In the Acme kickoff, you said 'We ship on Fridays because the client reviews on Monday morning and...'. Say more: why?",
    "You met Sam Ortiz about Vendor call. What surprised you?",
    "You met Lee about Hiring loop. What surprised you?",
    "You met Dana Park about Q3 pricing. What surprised you?",
  ]);
});

test("never more than four day questions, and none from stale, solo, all-day or cancelled items", async () => {
  const { selectDayQuestions } = await load();
  const questions = selectDayQuestions({ events: EVENTS, meetingNotes: MEETING_NOTES, now: NOW });
  assert.ok(questions.length <= 4);
  const joined = questions.join("\n");
  for (const absent of [
    "Last week sync",
    "Focus block",
    "Holiday",
    "Cancelled call",
    "Old words",
  ]) {
    assert.ok(!joined.includes(absent), absent);
  }
});

test("a note linked to an event is asked once, not also as the event", async () => {
  const { selectDayQuestions } = await load();
  const questions = selectDayQuestions({ events: EVENTS, meetingNotes: MEETING_NOTES, now: NOW });
  assert.equal(questions.filter((q) => q.includes("Acme kickoff")).length, 1);
});

test("with no local context there are no day questions", async () => {
  const { selectDayQuestions } = await load();
  assert.deepEqual(selectDayQuestions({ events: [], meetingNotes: [], now: NOW }), []);
});

test("standard questions rotate by day so each comes up every few days", async () => {
  const { rotateStandardQuestions } = await load();
  const bank = ["a", "b", "c", "d"];
  const today = rotateStandardQuestions(bank, NOW);
  const tomorrow = rotateStandardQuestions(bank, new Date(2026, 8, 27, 10));
  assert.equal(today.length, 4);
  assert.deepEqual([...today].sort(), bank);
  assert.notEqual(today[0], tomorrow[0]);
});

test("pending grill topics come first and count toward the max of 4", async () => {
  const { selectDayQuestions } = await load();
  const topics = [
    { id: "t1", text: "Hiring plan", source: "brain-dump" },
    { id: "t2", text: "Pricing", source: "brain-dump" },
  ];
  const questions = selectDayQuestions({
    events: EVENTS,
    meetingNotes: MEETING_NOTES,
    now: NOW,
    topics,
  });
  assert.equal(questions.length, 4);
  assert.deepEqual(questions.slice(0, 2), [
    "From your brain dump: Hiring plan",
    "From your brain dump: Pricing",
  ]);
  const many = [1, 2, 3, 4, 5].map((n) => ({
    id: `t${n}`,
    text: `Topic ${n}`,
    source: "brain-dump",
  }));
  assert.deepEqual(
    selectDayQuestions({ events: EVENTS, meetingNotes: MEETING_NOTES, now: NOW, topics: many }),
    [
      "From your brain dump: Topic 1",
      "From your brain dump: Topic 2",
      "From your brain dump: Topic 3",
      "From your brain dump: Topic 4",
    ]
  );
});

test("grillTopicQuestion labels by source, collapses whitespace, caps at 300", async () => {
  const { grillTopicQuestion } = await load();
  assert.equal(
    grillTopicQuestion({ id: "a", text: "Hiring\n\n plan", source: "brain-dump" }),
    "From your brain dump: Hiring plan"
  );
  assert.equal(
    grillTopicQuestion({ id: "b", text: "Pricing", source: "manual" }),
    "Topic you added: Pricing"
  );
  assert.equal(grillTopicQuestion({ id: "c", text: "Pricing" }), "Topic you added: Pricing");
  const long = grillTopicQuestion({ id: "d", text: "x".repeat(400), source: "brain-dump" });
  assert.ok(long.length <= 300 + "From your brain dump: ".length);
  assert.ok(long.endsWith("..."));
});
