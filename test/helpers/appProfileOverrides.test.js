const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanAppProfileOverrides,
} = require("../../src/components/settings/appProfileOverrideRules.ts");
const { sanitizeAppProfileOverrides } = require("../../src/helpers/dictationFormattingProfile.js");

test("the settings list saves trimmed, unique, named rows, in order, twenty at most", () => {
  const long = "a".repeat(95);
  const cleaned = cleanAppProfileOverrides([
    { match: "  Ghostty ", profile: "editor" },
    { match: "   ", profile: "chat" },
    { match: "ghostty", profile: "chat" },
    { match: long, profile: "prose" },
    ...Array.from({ length: 25 }, (_, i) => ({ match: `App ${i}`, profile: "terminal" })),
  ]);

  assert.equal(cleaned.length, 20);
  assert.deepEqual(cleaned.slice(0, 4), [
    { match: "Ghostty", profile: "editor" },
    { match: "a".repeat(80), profile: "prose" },
    { match: "App 0", profile: "terminal" },
    { match: "App 1", profile: "terminal" },
  ]);
  // What the settings list saves is what the paste formatter keeps.
  assert.deepEqual(sanitizeAppProfileOverrides(cleaned), cleaned);
});
