const test = require("node:test");
const assert = require("node:assert/strict");

const { expandSpokenEmoji } = require("../../src/utils/spokenEmoji.ts");
const emojiData = require("../../src/data/spokenEmoji.en.json");

/** The emoji character the data actually carries for a CLDR label. */
function charFor(label) {
  const row = emojiData.find((r) => r.l === label);
  assert.ok(row, `no data row labelled "${label}"`);
  return row.e;
}

test("a full name before 'emoji' becomes the emoji", () => {
  const cases = [
    ["upside down smiley emoji", "upside-down face"],
    ["red heart emoji", "red heart"],
    ["crying face emoji", "crying face"],
  ];
  for (const [spoken, label] of cases) {
    assert.equal(expandSpokenEmoji(spoken), charFor(label), `expected "${spoken}" to expand`);
  }
});

// Rico, 2026-09-29: names must be quick, not the whole CLDR label.
test("short everyday names resolve to the everyday emoji", () => {
  const cases = {
    "shrug emoji": "🤷‍♂️",
    "upside down emoji": "🙃",
    "facepalm emoji": "🤦‍♂️",
    "face palm emoji": "🤦‍♂️",
    "eye roll emoji": "🙄",
    "heart emoji": "❤️",
    "laughing emoji": "😂",
    "crying emoji": "😢",
    "party emoji": "🥳",
    "ok emoji": "👌",
    "thumbs up emoji": "👍",
    "fire emoji": "🔥",
  };
  for (const [spoken, emoji] of Object.entries(cases)) {
    assert.equal(expandSpokenEmoji(spoken), emoji, spoken);
  }
});

test("a keyword or part of a name finds the emoji", () => {
  assert.equal(expandSpokenEmoji("unicorn emoji"), charFor("unicorn"));
  assert.equal(expandSpokenEmoji("taco emoji"), charFor("taco"));
  assert.equal(expandSpokenEmoji("test, upside down emoji, test"), "test, 🙃, test");
});

// Rico, 2026-09-29: "shrug emoji means man shrugging for me".
test("a person emoji resolves to the man variant unless person or woman is said", () => {
  assert.equal(expandSpokenEmoji("shrug emoji"), charFor("man shrugging"));
  assert.equal(expandSpokenEmoji("woman shrugging emoji"), charFor("woman shrugging"));
  assert.equal(expandSpokenEmoji("person shrugging emoji"), charFor("person shrugging"));
});

test("a misheard name still lands on the preferred emoji", () => {
  assert.equal(expandSpokenEmoji("scrug emoji"), "🤷‍♂️");
  assert.equal(expandSpokenEmoji("facepalmm emoji"), "🤦‍♂️");
  assert.equal(expandSpokenEmoji("unicron emoji"), charFor("unicorn"));
  assert.equal(expandSpokenEmoji("xyzzy emoji"), "xyzzy emoji");
});

test("ordinary sentences that mention emoji are unchanged", () => {
  for (const text of [
    "I love this emoji thing",
    "we only get one emoji",
    "the new emoji picker",
    "nothing to see here",
    "",
  ]) {
    assert.equal(expandSpokenEmoji(text), text);
  }
});

test("two emoji phrases in one transcript both expand", () => {
  assert.equal(
    expandSpokenEmoji("send the fire emoji and the thumbs up emoji please"),
    "send the 🔥 and the 👍 please"
  );
  assert.equal(
    expandSpokenEmoji("Shrug emoji is my most common emoji"),
    "🤷‍♂️ is my most common emoji"
  );
});

test("punctuation after 'emoji' is kept and case does not matter", () => {
  assert.equal(expandSpokenEmoji("ship it, fire emoji!"), "ship it, 🔥!");
  assert.equal(expandSpokenEmoji("fire emoji."), "🔥.");
  assert.equal(expandSpokenEmoji("Fire Emoji"), "🔥");
  assert.equal(expandSpokenEmoji("Thumbs Up EMOJI"), "👍");
});

test("surrounding words are preserved around the replacement", () => {
  assert.equal(
    expandSpokenEmoji("that deploy was a fire emoji moment"),
    "that deploy was a 🔥 moment"
  );
});
