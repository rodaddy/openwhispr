const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatGrillEventPrefixes,
  parseGrillEventPrefixesInput,
} = require("../../src/utils/grillEventPrefixesInput.ts");

test("formatGrillEventPrefixes joins the list as comma-separated text", () => {
  assert.equal(formatGrillEventPrefixes(["Grill", "Life Story"]), "Grill, Life Story");
  assert.equal(formatGrillEventPrefixes([]), "");
});

test("parseGrillEventPrefixesInput splits on commas, trims, and drops blanks", () => {
  assert.deepEqual(parseGrillEventPrefixesInput(" Grill ,Life Story,, Roast "), [
    "Grill",
    "Life Story",
    "Roast",
  ]);
});

test("parseGrillEventPrefixesInput drops case-insensitive duplicates, keeping the first", () => {
  assert.deepEqual(parseGrillEventPrefixesInput("Grill, grill, GRILL, Life Story"), [
    "Grill",
    "Life Story",
  ]);
});

test("empty input is an empty list, which disables the grill trigger", () => {
  assert.deepEqual(parseGrillEventPrefixesInput(""), []);
  assert.deepEqual(parseGrillEventPrefixesInput(" , ,"), []);
});

test("format then parse round-trips a clean list", () => {
  const list = ["Grill", "Life Story"];
  assert.deepEqual(parseGrillEventPrefixesInput(formatGrillEventPrefixes(list)), list);
});
