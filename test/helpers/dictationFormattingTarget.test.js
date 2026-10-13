const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDictationFormattingTarget } = require("../../src/helpers/dictationFormattingTarget");
const {
  resolveFormattingProfile,
  applyFormattingProfile,
} = require("../../src/helpers/dictationFormattingProfile");

const ITERM = "/Applications/iTerm.app/Contents/MacOS/iTerm2";
const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const NOTES = "/Applications/Notes.app/Contents/MacOS/Notes";

const resolveFor = (executablePath, extra = {}) =>
  resolveDictationFormattingTarget({
    platform: "darwin",
    targetPid: 4242,
    readExecutablePath: async () => executablePath,
    ...extra,
  });

test("non-darwin platforms resolve to an empty target without reading the path", async () => {
  for (const platform of ["win32", "linux", undefined]) {
    let reads = 0;
    const target = await resolveFor(ITERM, {
      platform,
      readExecutablePath: async () => {
        reads += 1;
        return ITERM;
      },
    });
    assert.deepEqual(target, {});
    assert.equal(reads, 0);
  }
});

test("a missing pid resolves to an empty target", async () => {
  assert.deepEqual(await resolveFor(ITERM, { targetPid: null }), {});
  assert.deepEqual(await resolveFor(ITERM, { targetPid: 0 }), {});
});

test("a missing reader or no arguments resolve to an empty target", async () => {
  assert.deepEqual(await resolveFor(ITERM, { readExecutablePath: undefined }), {});
  assert.deepEqual(await resolveDictationFormattingTarget(), {});
});

test("an empty executable path resolves to an empty target", async () => {
  assert.deepEqual(await resolveFor(""), {});
});

test("the pid is handed to the reader", async () => {
  let seen = null;
  await resolveFor(ITERM, {
    readExecutablePath: async (pid) => {
      seen = pid;
      return ITERM;
    },
  });
  assert.equal(seen, 4242);
});

test("iTerm resolves to its bundle and executable names", async () => {
  assert.deepEqual(await resolveFor(ITERM), {
    appName: "iTerm",
    exeName: "iTerm2",
  });
});

test("a bundle name with spaces is kept whole", async () => {
  assert.deepEqual(await resolveFor(VSCODE), {
    appName: "Visual Studio Code",
    exeName: "Electron",
  });
});

test("a bare executable has no bundle name", async () => {
  assert.deepEqual(await resolveFor("zsh"), {
    appName: null,
    exeName: "zsh",
  });
});

test("a rejecting reader resolves to an empty target", async () => {
  const target = await resolveFor(ITERM, {
    readExecutablePath: async () => {
      throw new Error("ps failed");
    },
  });
  assert.deepEqual(target, {});
});

const profileFor = async (executablePath) =>
  resolveFormattingProfile(await resolveFor(executablePath), []);

test("end to end: terminal, editor, chat and prose targets each format their own way", async () => {
  const cases = [
    [ITERM, "terminal", "git status"],
    [VSCODE, "editor", "Git status"],
    ["/Applications/Slack.app/Contents/MacOS/Slack", "chat", "Git status"],
    [NOTES, "prose", "Git status."],
  ];
  // A known command, so the terminal result differs from the editor one.
  for (const [executablePath, profile, pasted] of cases) {
    assert.equal(await profileFor(executablePath), profile, executablePath);
    assert.equal(applyFormattingProfile("Git status.", profile), pasted, executablePath);
  }
});

// Regression: the paste path's terminal classifier is a substring match over
// Linux window classes, one of which is "st". Fed these real macOS apps it
// answers "terminal" for every one, which would lowercase and de-punctuate
// ordinary prose. The target lookup must not consult it.
test("apps whose names merely contain a terminal class are not terminals", async () => {
  const cases = [
    ["/Applications/Raycast.app/Contents/MacOS/Raycast", "prose"],
    ["/Applications/Fantastical.app/Contents/MacOS/Fantastical", "prose"],
    ["/System/Applications/System Settings.app/Contents/MacOS/System Settings", "prose"],
    ["/Applications/Postman.app/Contents/MacOS/Postman", "prose"],
    ["/System/Applications/Stickies.app/Contents/MacOS/Stickies", "prose"],
    ["/Applications/Steam.app/Contents/MacOS/steam_osx", "prose"],
    ["/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams", "chat"],
    ["/Applications/QR Code Generator.app/Contents/MacOS/QR Code Generator", "prose"],
  ];
  for (const [executablePath, profile] of cases) {
    const target = await resolveFor(executablePath);
    assert.equal("isTerminal" in target, false, executablePath);
    assert.equal(resolveFormattingProfile(target, []), profile, executablePath);
  }
});
