const test = require("node:test");
const assert = require("node:assert/strict");

// hotkeyManager loads Electron; only its pure key predicates are used here.
require.cache[require.resolve("electron")] = {
  exports: { globalShortcut: {}, BrowserWindow: class {} },
};
const hotkeyPredicates = require("../../src/helpers/hotkeyManager.js");
const {
  createPasteLastCallback,
  isPasteLastHotkeyDispatchable,
} = require("../../src/helpers/pasteLastTranscript");

function harness(overrides = {}) {
  const calls = { pastes: [], logs: [] };
  const callback = createPasteLastCallback({
    isBusy: () => false,
    getText: () => "Run npm test.",
    pasteText: async (...args) => {
      calls.pastes.push(args);
    },
    log: (...args) => calls.logs.push(args),
    ...overrides,
  });
  return { calls, callback };
}

test("pastes the stored dictation with no paste options", async () => {
  const { calls, callback } = harness();

  await callback();

  assert.deepEqual(calls.pastes, [["Run npm test.", {}]]);
});

test("pastes nothing while busy or when no dictation is stored", async () => {
  const busy = harness({ isBusy: () => true });
  await busy.callback();
  assert.deepEqual(busy.calls.pastes, []);

  const empty = harness({ getText: () => null });
  await empty.callback();
  assert.deepEqual(empty.calls.pastes, []);
});

test("only an ordinary key combination is dispatchable for paste-last", () => {
  assert.equal(isPasteLastHotkeyDispatchable("Control+Shift+V", hotkeyPredicates), true);
  for (const hotkey of [
    "GLOBE",
    "Fn",
    "MouseButton4",
    "RightCommand",
    "Control+Super",
    "Control+Shift+V,GLOBE",
  ]) {
    assert.equal(isPasteLastHotkeyDispatchable(hotkey, hotkeyPredicates), false, hotkey);
  }
});

test("a failed paste is caught and its log line does not carry the dictation", async () => {
  const { calls, callback } = harness({
    pasteText: async () => {
      throw new Error("xdotool type -- Run npm test. exited with code 1");
    },
  });

  await assert.doesNotReject(callback());

  assert.equal(calls.logs.length, 1);
  assert.equal(JSON.stringify(calls.logs).includes("Run npm test."), false);
});
