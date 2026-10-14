const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Regression guard: the Share button and dialog mount were
// dropped with the OpenWhispr cloud and never came back when sharing moved to
// the rTech share service. Rendering NoteEditor needs electronAPI, auth, and
// store doubles this suite does not have, so this asserts the wiring in source.
const SOURCE = fs.readFileSync(
  path.join(__dirname, "../../src/components/notes/NoteEditor.tsx"),
  "utf8"
);

test("the editor renders a Share control that opens the share dialog", () => {
  assert.match(SOURCE, /onClick=\{\(\) => setShareDialogOpen\(true\)\}/);
  assert.match(SOURCE, /aria-label=\{t\("noteEditor\.share\.button"\)\}/);
});

test("the editor mounts ShareNoteDialog", () => {
  assert.match(SOURCE, /<ShareNoteDialog\s+open=\{shareDialogOpen\}/);
});

test("the Share control is not gated on OpenWhispr cloud sign-in", () => {
  assert.doesNotMatch(SOURCE, /\bcanShare\b/);
  const button = SOURCE.slice(SOURCE.indexOf("setShareDialogOpen(true)") - 200);
  assert.doesNotMatch(button.slice(0, 200), /isSignedIn|cloud_id/);
});

test("noteEditor.share.button resolves in the en locale", () => {
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  assert.equal(typeof en?.noteEditor?.share?.button, "string");
});
