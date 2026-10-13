const test = require("node:test");
const assert = require("node:assert/strict");

const loadEditor = () => import("../../src/services/grill/grillEditor.ts");

const row = (over) => ({
  id: over.id,
  section: over.section,
  chapter: over.chapter ?? null,
  source: over.source ?? null,
  text: over.text ?? over.id,
  position: over.position ?? 0,
  status: over.status ?? "active",
  created_at: "2026-09-29T10:00:00.000Z",
  updated_at: "2026-09-29T10:00:00.000Z",
});

test("groups rows by section and chapter", async () => {
  const { groupGrillQuestions } = await loadEditor();
  const grouped = groupGrillQuestions([
    row({ id: "s1", section: "standard", position: 0 }),
    row({ id: "d1", section: "day-template", position: 0, source: "calendar" }),
    row({ id: "c1", section: "chapter", chapter: 2, position: 0 }),
    row({ id: "c2", section: "chapter", chapter: 1, position: 0 }),
  ]);

  assert.deepEqual(
    grouped.standard.map((r) => r.id),
    ["s1"]
  );
  assert.deepEqual(
    grouped.dayTemplates.map((r) => r.id),
    ["d1"]
  );
  assert.deepEqual(
    grouped.chapters.map((c) => c.number),
    [1, 2]
  );
  assert.deepEqual(
    grouped.chapters.map((c) => c.rows.map((r) => r.id)),
    [["c2"], ["c1"]]
  );
});

test("orders each group by position", async () => {
  const { groupGrillQuestions } = await loadEditor();
  const grouped = groupGrillQuestions([
    row({ id: "s3", section: "standard", position: 2 }),
    row({ id: "s1", section: "standard", position: 0 }),
    row({ id: "s2", section: "standard", position: 1 }),
    row({ id: "c2", section: "chapter", chapter: 1, position: 5 }),
    row({ id: "c1", section: "chapter", chapter: 1, position: 4 }),
  ]);

  assert.deepEqual(
    grouped.standard.map((r) => r.id),
    ["s1", "s2", "s3"]
  );
  assert.deepEqual(
    grouped.chapters[0].rows.map((r) => r.id),
    ["c1", "c2"]
  );
});

test("puts retired rows last inside their group", async () => {
  const { groupGrillQuestions } = await loadEditor();
  const grouped = groupGrillQuestions([
    row({ id: "r1", section: "standard", position: 0, status: "retired" }),
    row({ id: "a1", section: "standard", position: 1 }),
    row({ id: "r2", section: "standard", position: 3, status: "retired" }),
    row({ id: "a2", section: "standard", position: 2 }),
    row({ id: "cr", section: "chapter", chapter: 3, position: 0, status: "retired" }),
    row({ id: "ca", section: "chapter", chapter: 3, position: 9 }),
  ]);

  assert.deepEqual(
    grouped.standard.map((r) => r.id),
    ["a1", "a2", "r1", "r2"]
  );
  assert.deepEqual(
    grouped.chapters[0].rows.map((r) => r.id),
    ["ca", "cr"]
  );
});

test("chapter rows with a null chapter are dropped", async () => {
  const { groupGrillQuestions } = await loadEditor();
  const grouped = groupGrillQuestions([row({ id: "x", section: "chapter", chapter: null })]);
  assert.deepEqual(grouped.chapters, []);
});

test("empty input yields empty groups", async () => {
  const { groupGrillQuestions } = await loadEditor();
  const grouped = groupGrillQuestions([]);
  assert.deepEqual(grouped, { standard: [], dayTemplates: [], chapters: [] });
});

test("mark counts are grouped per question id, zero-filled when unmarked", async () => {
  const { markCountsForRows } = await loadEditor();
  const tallies = markCountsForRows(
    [row({ id: "a", section: "standard" }), row({ id: "b", section: "standard" })],
    { a: { good: 2, weak: 1, retire: 0 } }
  );
  assert.deepEqual(tallies, {
    a: { good: 2, weak: 1, retire: 0 },
    b: { good: 0, weak: 0, retire: 0 },
  });
});

test("retired questions keep their mark counts", async () => {
  const { markCountsForRows } = await loadEditor();
  const tallies = markCountsForRows([row({ id: "r", section: "standard", status: "retired" })], {
    r: { good: 0, weak: 3, retire: 4 },
  });
  assert.deepEqual(tallies.r, { good: 0, weak: 3, retire: 4 });
});

test("mark counts for unknown ids are ignored", async () => {
  const { markCountsForRows } = await loadEditor();
  const tallies = markCountsForRows([row({ id: "a", section: "standard" })], {
    a: { good: 1, weak: 0, retire: 0 },
    ghost: { good: 9, weak: 9, retire: 9 },
  });
  assert.deepEqual(tallies, { a: { good: 1, weak: 0, retire: 0 } });
});
