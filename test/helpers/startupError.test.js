const test = require("node:test");
const assert = require("node:assert/strict");

const { startupErrorMessage } = require("../../src/helpers/startupError");

const t = (key, options) => ({ key, options });

test("an error carrying a backup path names it in the dialog text", () => {
  const error = new Error("no such column: x");
  error.backupPath = "/data/transcriptions.db.backup-1.0.0";

  assert.deepEqual(startupErrorMessage(error, t), {
    key: "startup.error.messageWithBackup",
    options: { error: "no such column: x", backupPath: "/data/transcriptions.db.backup-1.0.0" },
  });
});

test("an error without a backup path uses the plain startup message", () => {
  assert.deepEqual(startupErrorMessage(new Error("boom"), t), {
    key: "startup.error.message",
    options: { error: "boom" },
  });
});
