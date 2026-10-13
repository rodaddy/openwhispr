const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
const calls = (source) => source.match(/useBrainDumpRoundups\(\)/g)?.length ?? 0;

// #423: the scheduler must run in the dictation window, which main.js always
// creates, not the control panel, which a hidden or login launch never opens.
test("roundups are scheduled once, in the always-present dictation window", () => {
  assert.equal(calls(read("App.jsx")), 1);
  assert.equal(calls(read("components/ControlPanel.tsx")), 0);
});
