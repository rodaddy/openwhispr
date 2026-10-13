const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRemindersBridge,
  RemindersPermissionError,
  osascriptArgv,
} = require("../../src/helpers/remindersBridge.js");

const TITLE = 'Call "Bob" \\ back\nabout the quote';
const NOTES = 'line one\nline "two" \\ end';
const LIST = 'Brain "dumps"';

function fakeRunner(result) {
  const calls = [];
  const run = async (script, args) => {
    calls.push({ script, args });
    if (result instanceof Error) throw result;
    return result;
  };
  run.calls = calls;
  return run;
}

test("addReminder passes title, notes and list verbatim as argv", async () => {
  const runner = fakeRunner("x-apple-reminder://ABC-123\n");
  const bridge = createRemindersBridge({ runner, platform: "darwin" });
  await bridge.addReminder({ title: TITLE, notes: NOTES, list: LIST });
  assert.deepEqual(runner.calls[0].args, [TITLE, NOTES, LIST]);
});

test("the script contains no user text", async () => {
  const runner = fakeRunner("id-1");
  const bridge = createRemindersBridge({ runner, platform: "darwin" });
  await bridge.addReminder({ title: "UNIQUE_TITLE_42", notes: "UNIQUE_NOTE_42" });
  await bridge.removeReminder("UNIQUE_ID_42");
  for (const { script } of runner.calls) {
    assert.ok(script.includes("on run argv"));
    assert.ok(!/UNIQUE_/.test(script));
  }
});

test("list defaults to Brain dumps and notes to empty", async () => {
  const runner = fakeRunner("id-1");
  const bridge = createRemindersBridge({ runner, platform: "darwin" });
  await bridge.addReminder({ title: "t" });
  assert.deepEqual(runner.calls[0].args, ["t", "", "Brain dumps"]);
});

test("the id is parsed from the runner output", async () => {
  const runner = fakeRunner("  x-apple-reminder://ABC-123\n");
  const bridge = createRemindersBridge({ runner, platform: "darwin" });
  assert.deepEqual(await bridge.addReminder({ title: "t" }), {
    id: "x-apple-reminder://ABC-123",
  });
});

test("removeReminder passes the id as argv and resolves", async () => {
  const runner = fakeRunner("");
  const bridge = createRemindersBridge({ runner, platform: "darwin" });
  assert.equal(await bridge.removeReminder("x-apple-reminder://ABC"), undefined);
  assert.deepEqual(runner.calls[0].args, ["x-apple-reminder://ABC"]);
});

test("error -1743 becomes RemindersPermissionError", async () => {
  const err = new Error("Command failed");
  err.stderr = "execution error: Not authorized to send Apple events to Reminders. (-1743)";
  const bridge = createRemindersBridge({ runner: fakeRunner(err), platform: "darwin" });
  await assert.rejects(bridge.addReminder({ title: "t" }), (e) => {
    assert.ok(e instanceof RemindersPermissionError);
    assert.equal(
      e.message,
      "Allow rTech Whisper to control Reminders in System Settings > Privacy & Security > Automation."
    );
    return true;
  });
});

test("'not allowed' also becomes RemindersPermissionError", async () => {
  const err = new Error("osascript: Reminders got an error: not allowed");
  const bridge = createRemindersBridge({ runner: fakeRunner(err), platform: "darwin" });
  await assert.rejects(bridge.removeReminder("x"), RemindersPermissionError);
});

test("other runner errors pass through", async () => {
  const err = new Error("boom");
  const bridge = createRemindersBridge({ runner: fakeRunner(err), platform: "darwin" });
  await assert.rejects(bridge.addReminder({ title: "t" }), /boom/);
});

test("non-darwin rejects both functions without running", async () => {
  const runner = fakeRunner("id");
  const bridge = createRemindersBridge({ runner, platform: "linux" });
  await assert.rejects(bridge.addReminder({ title: "t" }), /Reminders is macOS only/);
  await assert.rejects(bridge.removeReminder("x"), /Reminders is macOS only/);
  assert.equal(runner.calls.length, 0);
});

test("osascript argv ends option parsing before user args", () => {
  const args = ["-e", 'property p : (do shell script "id")', "- buy milk", "-l"];
  assert.deepEqual(osascriptArgv("SCRIPT", args), ["-e", "SCRIPT", "--", ...args]);
});

test("osascript treats dash-leading titles as argv, not flags", { skip: process.platform !== "darwin" }, () => {
  const { execFileSync } = require("node:child_process");
  const script = "on run argv\n  return ((count of argv) as text) & \"|\" & (item 1 of argv)\nend run";
  const out = execFileSync("osascript", osascriptArgv(script, ["-e", "return 99", "- buy milk"]), {
    encoding: "utf8",
  });
  assert.equal(out.trim(), "3|-e");
});
