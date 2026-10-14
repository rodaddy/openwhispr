const test = require("node:test");
const assert = require("node:assert/strict");

const { countWords, shouldAutoSubmit } = require("../../src/helpers/dictationAutoSubmit");

const allowed = {
  enabled: true,
  bundleId: "com.googlecode.iterm2",
  text: "run npm test",
  pasted: true,
};

test("countWords counts whitespace-separated tokens holding a letter or digit", () => {
  const cases = [
    ["run npm test", 3],
    ["  a  b ", 2],
    ["... ?", 0],
    ["über café", 2],
    ["", 0],
    [undefined, 0],
    [null, 0],
    [42, 0],
    [["run", "npm", "test"], 0],
  ];
  for (const [input, expected] of cases) {
    assert.equal(countWords(input), expected, JSON.stringify(input));
  }
});

test("shouldAutoSubmit allows a pasted single-line terminal dictation at the floor", () => {
  assert.equal(shouldAutoSubmit(allowed), true);
});

test("shouldAutoSubmit refuses when any single condition is violated", () => {
  const violations = {
    "not enabled": { enabled: false },
    "enabled missing": { enabled: undefined },
    "enabled as a string": { enabled: "true" },
    "not pasted": { pasted: false },
    "pasted missing": { pasted: undefined },
    "newline in the text": { text: "run npm test\nrm -rf build" },
    "carriage return in the text": { text: "run npm test\r" },
    "non-string text": { text: 12345 },
    "below the floor": { text: "npm test" },
    "punctuation only": { text: "... ? !" },
  };
  for (const [name, override] of Object.entries(violations)) {
    assert.equal(shouldAutoSubmit({ ...allowed, ...override }), false, name);
  }
  assert.equal(shouldAutoSubmit(), false, "no arguments");
});

test("shouldAutoSubmit allows a terminal on the exact bundle-id list", () => {
  assert.equal(shouldAutoSubmit({ ...allowed, bundleId: "com.apple.Terminal" }), true);
});

test("shouldAutoSubmit refuses a bundle id that is not exactly on the list", () => {
  // An app merely named like a terminal must not get a Return.
  for (const bundleId of ["com.example.TerminalNotes", "com.apple.terminal", null, undefined]) {
    assert.equal(shouldAutoSubmit({ ...allowed, bundleId }), false, String(bundleId));
  }
});

test("shouldAutoSubmit falls back to the default floor for an unusable minWords", () => {
  // 1 is below the settings range of 2..12, so it is not honored either.
  for (const minWords of [1, 0, -1, 2.5, undefined, null, "1", NaN]) {
    assert.equal(
      shouldAutoSubmit({ ...allowed, text: "npm test", minWords }),
      false,
      `two words, minWords ${String(minWords)}`
    );
    assert.equal(
      shouldAutoSubmit({ ...allowed, text: "run npm test", minWords }),
      true,
      `three words, minWords ${String(minWords)}`
    );
  }
});

test("shouldAutoSubmit honors an integer minWords of two or more", () => {
  assert.equal(shouldAutoSubmit({ ...allowed, text: "npm test", minWords: 2 }), true);
  assert.equal(shouldAutoSubmit({ ...allowed, text: "run npm test", minWords: 4 }), false);
});

test("shouldAutoSubmit refuses every control character and line separator", () => {
  // A terminal may take any of these as the end of a line.
  for (const code of [0x09, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0x90, 0x9b, 0x2028, 0x2029]) {
    const text = `run npm test${String.fromCharCode(code)}rm -rf build`;
    assert.equal(shouldAutoSubmit({ ...allowed, text }), false, `U+${code.toString(16)}`);
  }
});
