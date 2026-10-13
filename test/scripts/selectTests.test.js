const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "ci", "select-tests.sh");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "select-tests",
  GIT_AUTHOR_EMAIL: "select-tests@example.invalid",
  GIT_COMMITTER_NAME: "select-tests",
  GIT_COMMITTER_EMAIL: "select-tests@example.invalid",
};

const BASE_FILES = {
  "src/a.js": "a\n",
  "src/b.js": "b\n",
  "test/a.test.js": "a test\n",
  "test/other/x.test.js": "x test\n",
  "README.md": "readme\n",
};

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Builds a throwaway repo holding the selector and BASE_FILES, commits `changes`
// on top, and returns the selector's output lines for base...head.
function select(changes, renames = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "select-tests-"));
  try {
    // not "main": hosts may block commits to protected branch names
    git(dir, "init", "-q", "-b", "selector");
    write(dir, "scripts/ci/select-tests.sh", fs.readFileSync(SCRIPT, "utf8"));
    for (const [rel, content] of Object.entries(BASE_FILES)) write(dir, rel, content);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD");
    for (const [from, to] of Object.entries(renames)) {
      fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git(dir, "mv", from, to);
    }
    for (const [rel, content] of Object.entries(changes)) write(dir, rel, content);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "head");
    const head = git(dir, "rev-parse", "HEAD");
    return execFileSync("bash", ["scripts/ci/select-tests.sh", base, head], {
      cwd: dir,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Regression (#551): a changed test filled the selection, so a source change no
// test matched never reached the FULL fallback and ran untested.
test("a changed test plus an unmatched source change runs the full suite", () => {
  assert.deepEqual(select({ "test/a.test.js": "a test v2\n", "lib/zzz.js": "zzz\n" }), ["FULL"]);
});

// Review on #560: a filename match is not coverage. A changed shared helper
// matched only its own test while a consumer's test, never selected, broke.
test("a source change runs the full suite even when a test matches its name", () => {
  assert.deepEqual(select({ "src/a.js": "a v2\n" }), ["FULL"]);
});

// Review on #560: Markdown under src/ can be a runtime input (a seed file).
test("a Markdown file outside the docs paths runs the full suite", () => {
  assert.deepEqual(select({ "src/config/bank.md": "q\n" }), ["FULL"]);
});

test("docs under docs/ select nothing", () => {
  assert.deepEqual(select({ "docs/guide.md": "g\n" }), ["NONE"]);
});

test("a test-only change selects exactly that test", () => {
  assert.deepEqual(select({ "test/other/x.test.js": "x test v2\n" }), ["test/other/x.test.js"]);
});

test("a docs-only change selects nothing", () => {
  assert.deepEqual(select({ "README.md": "readme v2\n" }), ["NONE"]);
});

// Review on #560: git diff lists only the new path of a rename, so a file
// moved into docs/ or test/ was classified by where it landed.
test("runtime Markdown renamed into docs/ runs the full suite", () => {
  assert.deepEqual(select({}, { "src/a.js": "docs/a.md" }), ["FULL"]);
});

test("a source file renamed into a test path runs the full suite", () => {
  assert.deepEqual(select({}, { "src/b.js": "test/b.test.js" }), ["FULL"]);
});

test("a test renamed within test/ selects the renamed test", () => {
  assert.deepEqual(select({}, { "test/other/x.test.js": "test/other/y.test.js" }), [
    "test/other/y.test.js",
  ]);
});

// Pre-push review: node --test treats [ab] as a glob, so the changed file
// itself would never run.
test("a test path with glob characters runs the full suite", () => {
  assert.deepEqual(select({ "test/other/[ab].test.js": "t\n" }), ["FULL"]);
});

test("a test at any depth is selected", () => {
  assert.deepEqual(select({ "test/a/b/c/d/e.test.js": "t\n" }), ["test/a/b/c/d/e.test.js"]);
});
