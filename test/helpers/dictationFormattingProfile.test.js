const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROFILES,
  DEFAULT_PROFILE,
  DEFAULT_APP_PROFILES,
  tokenize,
  matchesPhrase,
  resolveFormattingProfile,
  sanitizeAppProfileOverrides,
  MAX_APP_PROFILE_OVERRIDES,
  isSingleSentence,
  applyFormattingProfile,
} = require("../../src/helpers/dictationFormattingProfile");

test("the profile table is frozen and only names known profiles", () => {
  assert.deepEqual(PROFILES, ["terminal", "editor", "chat", "prose"]);
  assert.equal(DEFAULT_PROFILE, "prose");
  assert.ok(Object.isFrozen(DEFAULT_APP_PROFILES));
  for (const { match, profile } of DEFAULT_APP_PROFILES) {
    assert.ok(PROFILES.includes(profile), `${match} -> ${profile}`);
    assert.equal(match, match.toLowerCase());
    assert.ok(tokenize(match).length > 0);
  }
});

test("tokenize yields lowercase alphanumeric tokens", () => {
  const cases = [
    ["com.microsoft.VSCode", ["com", "microsoft", "vscode"]],
    ["Visual Studio Code", ["visual", "studio", "code"]],
    ["  --  ", []],
    ["", []],
    [null, []],
    [undefined, []],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(tokenize(input), expected, JSON.stringify(input));
  }
});

test("matchesPhrase matches whole tokens in a contiguous run", () => {
  const cases = [
    [["org", "gnome", "terminal"], "gnome terminal", true],
    [["gnome", "shell", "terminal"], "gnome terminal", false],
    [tokenize("football manager"), "foot", false],
    [tokenize("hypercard"), "hyper", false],
    [tokenize("xcode"), "code", false],
    [tokenize("xcode"), "xcode", true],
    [["visual", "studio", "code"], "Visual Studio Code", true],
    [["code"], "", false],
    [[], "code", false],
  ];
  for (const [tokens, phrase, expected] of cases) {
    assert.equal(matchesPhrase(tokens, phrase), expected, `${tokens.join(" ")} ~ "${phrase}"`);
  }
});

test("resolveFormattingProfile maps the target app to a profile", () => {
  const cases = [
    [{ appName: "Terminal" }, "terminal"],
    [{ appName: "iTerm2" }, "terminal"],
    [{ bundleId: "com.microsoft.VSCode" }, "editor"],
    [{ appName: "Visual Studio Code", exeName: "Electron" }, "editor"],
    [{ appName: "Cursor" }, "editor"],
    [{ appName: "Xcode" }, "editor"],
    [{ appName: "QR Code Generator" }, "prose"],
    [{ appName: "Code Runner" }, "prose"],
    [{ windowClass: "org.gnome.Terminal" }, "terminal"],
    [{ exeName: "WindowsTerminal.exe", appName: "Windows Terminal" }, "terminal"],
    [{ appName: "Slack" }, "chat"],
    [{ appName: "Microsoft Teams" }, "chat"],
    [{ appName: "Notes" }, "prose"],
    [{ appName: "Football Manager" }, "prose"],
    [{ appName: null, exeName: null, windowClass: null, bundleId: null }, "prose"],
    [{}, "prose"],
    [undefined, "prose"],
    [null, "prose"],
    ["Terminal", "prose"],
    [{ appName: "Notes", isTerminal: true }, "terminal"],
    [{ appName: "Notes", isTerminal: "yes" }, "prose"],
  ];
  for (const [target, expected] of cases) {
    assert.equal(resolveFormattingProfile(target), expected, JSON.stringify(target));
  }
});

test("user overrides win over isTerminal and the built-in table", () => {
  const cases = [
    [{ appName: "Notes" }, [{ match: "notes", profile: "chat" }], "chat"],
    [{ appName: "Terminal", isTerminal: true }, [{ match: "terminal", profile: "prose" }], "prose"],
    [{ appName: "Notes" }, [{ match: "notes", profile: "bogus" }], "prose"],
    [{ appName: "Slack" }, [{ match: "slack", profile: "bogus" }], "chat"],
    [{ appName: "Notes" }, [{ match: "...", profile: "chat" }], "prose"],
    [
      { appName: "Notes" },
      [null, { profile: "chat" }, { match: "notes", profile: "terminal" }],
      "terminal",
    ],
    [
      { appName: "Notes" },
      [
        { match: "notes", profile: "chat" },
        { match: "notes", profile: "terminal" },
      ],
      "chat",
    ],
    [{ appName: "Slack" }, "not an array", "chat"],
  ];
  for (const [target, overrides, expected] of cases) {
    assert.equal(
      resolveFormattingProfile(target, overrides),
      expected,
      `${JSON.stringify(target)} + ${JSON.stringify(overrides)}`
    );
  }
});

test("isSingleSentence needs a terminator followed by more text to say no", () => {
  const cases = [
    ["Run npm test.", true],
    ["Fix it. Then run tests.", false],
    ["v1.2 is out", true],
    ["Really? Yes", false],
    ["Wait… what", false],
    ["  Run it.  \n", true],
    ["", true],
    ['"Hello." She left.', false],
    ["He said “stop!” Then left.", false],
    ["Run (it works.) Now ship.", false],
    ['She said "hello" to me.', true],
  ];
  for (const [text, expected] of cases) {
    assert.equal(isSingleSentence(text), expected, JSON.stringify(text));
  }
});

test("terminal profile drops the trailing period and lowers only a known command", () => {
  const cases = [
    ["Ls -la", "ls -la"],
    ["Git status.", "git status"],
    ["Claude, fix the build.", "Claude, fix the build"],
    ["Run npm test.", "Run npm test"],
    // A command that is also an English word stays as dictated.
    ["Make sure it works.", "Make sure it works"],
    ["Go ahead.", "Go ahead"],
    // The trailing punctuation is stripped before the list check.
    ["Git, then push.", "git, then push"],
    ["Python3 script.py.", "python3 script.py"],
    // A known command keeps its capital in a multi-sentence text.
    ["Git status. Then commit.", "Git status. Then commit"],
    ["Fix the bug. Then run the tests.", "Fix the bug. Then run the tests"],
    ["NPM install.", "NPM install"],
    ["I think so.", "I think so"],
    ["I'm done.", "I'm done"],
    ["Don't push.", "Don't push"],
    ["Fix, then push.", "Fix, then push"],
    ["GitHub is down?", "GitHub is down?"],
    ["Wait...", "Wait..."],
    ["Say “hello” to it’s.", 'Say "hello" to it\'s'],
    ["  Run it. \n", "  Run it \n"],
    ["git push --force.", "git push --force"],
    ["Bump to v1.2.3.", "Bump to v1.2.3"],
    ["Open src/helpers/[draft] notes.md.", "Open src/helpers/[draft] notes.md"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(applyFormattingProfile(input, "terminal"), expected, JSON.stringify(input));
  }
});

test("chat profile only drops the period of a single sentence", () => {
  const cases = [
    ["Sounds good.", "Sounds good"],
    ["Sounds good. See you then.", "Sounds good. See you then."],
    ['"Hello." She left.', '"Hello." She left.'],
    ["Really?", "Really?"],
    ["Hmm..", "Hmm.."],
    [" Sounds “good”. ", " Sounds “good” "],
  ];
  for (const [input, expected] of cases) {
    assert.equal(applyFormattingProfile(input, "chat"), expected, JSON.stringify(input));
  }
});

test("prose and unknown profiles leave the text alone", () => {
  for (const profile of ["prose", "nope", undefined, null]) {
    assert.equal(applyFormattingProfile("Run npm test.", profile), "Run npm test.");
    assert.equal(applyFormattingProfile("Run it.", profile), "Run it.");
  }
});

test("empty, blank and non-string input", () => {
  const cases = [
    [undefined, ""],
    [null, ""],
    [42, ""],
    ["", ""],
    ["   ", "   "],
    [" \n\t", " \n\t"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(applyFormattingProfile(input, "terminal"), expected, JSON.stringify(input));
  }
});

test("a lone period is pasted as-is, never as nothing", () => {
  assert.equal(applyFormattingProfile(".", "terminal"), ".");
  assert.equal(applyFormattingProfile(".", "chat"), ".");
  assert.equal(applyFormattingProfile(" . ", "terminal"), " . ");
});

test("editor profile keeps the capital, drops the period and straightens quotes", () => {
  const cases = [
    ["Run npm test.", "Run npm test"],
    ["Claude, fix the build.", "Claude, fix the build"],
    ["Fix the bug. Then run the tests.", "Fix the bug. Then run the tests"],
    ["Say “hello” to it’s.", 'Say "hello" to it\'s'],
    ["Really?", "Really?"],
    ["Wait...", "Wait..."],
  ];
  for (const [input, expected] of cases) {
    assert.equal(applyFormattingProfile(input, "editor"), expected, input);
  }
});

// A period that belongs to an abbreviation is part of the word: it is neither
// a sentence boundary nor a trailing period to drop.
test("abbreviations keep their period and do not split a sentence", () => {
  assert.equal(isSingleSentence("Bring snacks, drinks, etc. for tomorrow."), true);
  assert.equal(isSingleSentence("Ask Dr. Smith about it."), true);
  assert.equal(isSingleSentence("Use e.g. the staging box."), true);
  assert.equal(isSingleSentence("It works. Ship it."), false);

  const cases = [
    ["Bring snacks, drinks, etc. for tomorrow.", "chat", "Bring snacks, drinks, etc. for tomorrow"],
    ["Add snacks, drinks, etc.", "chat", "Add snacks, drinks, etc."],
    ["Add snacks, drinks, etc.", "terminal", "Add snacks, drinks, etc."],
    ["Add snacks, drinks, etc.", "editor", "Add snacks, drinks, etc."],
    ["Meet at 5 p.m.", "chat", "Meet at 5 p.m."],
    ["It took 5 ms.", "terminal", "It took 5 ms"],
    ["Open README.md.", "terminal", "Open README.md"],
  ];
  for (const [input, profile, expected] of cases) {
    assert.equal(applyFormattingProfile(input, profile), expected, `${profile}: ${input}`);
  }
});

// #629: the override list comes from the renderer, so the main process keeps
// only what the resolver can use.
test("the override sanitizer keeps valid pairs, drops the rest and caps the list", () => {
  assert.deepEqual(
    sanitizeAppProfileOverrides([
      { match: "  Notes ", profile: "terminal" },
      { match: "slack", profile: "shouting" },
      { match: "   ", profile: "chat" },
      { match: "...", profile: "chat" },
      { match: "a".repeat(81), profile: "chat" },
      { match: 7, profile: "chat" },
      "notes",
      null,
      { match: "NOTES", profile: "editor" },
      { match: "a".repeat(80), profile: "prose" },
    ]),
    [
      { match: "Notes", profile: "terminal" },
      { match: "a".repeat(80), profile: "prose" },
    ]
  );

  const many = Array.from({ length: 25 }, (_, i) => ({ match: `app ${i}`, profile: "chat" }));
  assert.equal(MAX_APP_PROFILE_OVERRIDES, 20);
  assert.deepEqual(sanitizeAppProfileOverrides(many), many.slice(0, 20));

  // Hostile input costs bounded work: a valid entry past the first hundred is
  // never reached, however long the list is.
  const buried = [
    ...Array.from({ length: 100 }, () => ({ match: "x", profile: "nope" })),
    { match: "notes", profile: "chat" },
  ];
  assert.deepEqual(sanitizeAppProfileOverrides(buried), []);

  for (const value of ["notes", null, undefined, { match: "notes", profile: "chat" }]) {
    assert.deepEqual(sanitizeAppProfileOverrides(value), []);
  }
});
