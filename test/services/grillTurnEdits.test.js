const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/grillTurnEdits.ts");
const loadSession = () => import("../../src/services/grill/grillSession.ts");

const NOW = new Date(2026, 8, 29, 10, 0, 0);
const DAILY = {
  kind: "daily",
  date: "2026-09-29",
  dayQuestions: ["What surprised you?"],
  standardQuestions: [],
};

const MESSAGES = [
  { id: "a", role: "assistant", content: "What surprised you?", isStreaming: false },
  { id: "b", role: "user", content: "the grill went off script", isStreaming: false },
  { id: "c", role: "assistant", content: "Say more about that.", isStreaming: false },
  { id: "d", role: "user", content: "stray text became an answer", isStreaming: false },
  {
    id: "h",
    role: "user",
    content: "Start my daily grill.",
    isStreaming: false,
    display: "hidden",
  },
];

test("editTurn changes only the named message", async () => {
  const { editTurn } = await load();
  const next = editTurn(MESSAGES, "b", "  the grill stayed on script  ");
  assert.equal(next[1].content, "the grill stayed on script");
  assert.equal(next.length, MESSAGES.length);
  assert.equal(next[0].content, MESSAGES[0].content);
  assert.equal(next[3].content, MESSAGES[3].content);
  // the source list is untouched
  assert.equal(MESSAGES[1].content, "the grill went off script");
});

test("editTurn leaves hidden turns alone and no-ops on an unknown id", async () => {
  const { editTurn } = await load();
  assert.equal(editTurn(MESSAGES, "nope", "x"), MESSAGES);
  const hidden = editTurn(MESSAGES, "h", "rewritten");
  assert.equal(hidden, MESSAGES);
});

test("removeTurn drops only the named message", async () => {
  const { removeTurn } = await load();
  const next = removeTurn(MESSAGES, "d");
  assert.equal(next.length, MESSAGES.length - 1);
  assert.ok(!next.some((m) => m.id === "d"));
  assert.ok(next.some((m) => m.id === "h"));
  assert.equal(removeTurn(MESSAGES, "nope"), MESSAGES);
});

test("removeTurn refuses a hidden turn", async () => {
  const { removeTurn } = await load();
  assert.equal(removeTurn(MESSAGES, "h"), MESSAGES);
});

test("the saved note is built from the edited list", async () => {
  const { editTurn, removeTurn } = await load();
  const { buildGrillSessionNote } = await loadSession();
  const edited = removeTurn(editTurn(MESSAGES, "b", "the grill stayed on script"), "d");
  const note = buildGrillSessionNote(DAILY, edited, NOW);
  assert.ok(note.content.includes("the grill stayed on script"));
  assert.ok(!note.content.includes("the grill went off script"));
  assert.ok(!note.content.includes("stray text became an answer"));
  assert.equal(note.turns.filter((turn) => turn.role === "user").length, 1);
});

test("Back to script is hidden from the saved note, like Skip", async () => {
  const { GRILL_BACK_TO_SCRIPT_TEXT, GRILL_SKIP_TEXT, buildGrillSessionNote } = await loadSession();
  assert.ok(GRILL_BACK_TO_SCRIPT_TEXT.length > 0);
  assert.notEqual(GRILL_BACK_TO_SCRIPT_TEXT, GRILL_SKIP_TEXT);
  const messages = [
    ...MESSAGES,
    {
      id: "s",
      role: "user",
      content: GRILL_BACK_TO_SCRIPT_TEXT,
      isStreaming: false,
      display: "hidden",
    },
  ];
  const note = buildGrillSessionNote(DAILY, messages, NOW);
  assert.ok(!note.content.includes(GRILL_BACK_TO_SCRIPT_TEXT));
  assert.ok(!note.transcript.includes("Go back to the script"));
});
