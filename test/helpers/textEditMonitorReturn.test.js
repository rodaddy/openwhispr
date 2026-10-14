const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

// Auto-submit goes through the native helper's --paste-return-to-pid
// mode, which delivers Cmd+V and Return to one window of one process. A shell
// stands in for the helper here: the arguments appended after the script arrive
// as $0, $1 and $2, so the script can prove what argv ended with.
const darwinOnly = { skip: process.platform !== "darwin" };

function monitorWithHelper(script) {
  const monitor = new TextEditMonitor();
  let resolves = 0;
  monitor.resolveBinary = () => {
    resolves += 1;
    return { command: "/bin/sh", args: ["-c", script] };
  };
  return { monitor, resolves: () => resolves };
}

// [what the helper does, the outcome for pid 42 and window 7]
const HELPER_ANSWERS = [
  ['[ "$0" = "--paste-return-to-pid" ] && echo "PASTE_RETURN_OK:$1"', "submitted"],
  ['echo "PASTE_SENT:$1"; echo "PASTE_RETURN_OK:$1"', "submitted"],
  ['echo "PASTE_ONLY:$1"; exit 4', "pasted"],
  ['echo "PASTE_SENT:$1"; echo "PASTE_ONLY:$1"; exit 4', "pasted"],
  // Killed after the paste went out: a second keystroke would paste twice.
  ['echo "PASTE_SENT:$1"; exec sleep 4', "pasted"],
  // Nothing was posted: wrong target, bad arguments, no accessibility trust.
  ['echo "PASTE_SKIPPED"; exit 3', "skipped"],
  ['echo "PASTE_FAILED"; exit 1', "skipped"],
  ['echo "PASTE_FAILED"; exit 2', "skipped"],
  // A confirmation for another pid, or one that is not a line of its own.
  ['echo "PASTE_RETURN_OK:43"', "failed"],
  ['echo "PASTE_ONLY:43"; exit 4', "failed"],
  ['echo "PASTE_SENT:43"', "failed"],
  ['echo "PASTE_RETURN_OK:420"', "failed"],
  ['echo "NOT PASTE_RETURN_OK:42"', "failed"],
  // A confirmation that came with an error.
  ['echo "PASTE_RETURN_OK:42"; exit 1', "failed"],
  // A helper built before this mode existed, a silent one, a killed one.
  ['echo "NO_ELEMENT"; exit 1', "failed"],
  ["exit 0", "failed"],
  ["kill -9 $$", "failed"],
  // The 2 s timeout; exec, so its kill reaches the sleeping process itself.
  ["exec sleep 4", "failed"],
];

for (const [script, outcome] of HELPER_ANSWERS) {
  test(`pasteAndReturnForPid: helper '${script}' resolves ${outcome}`, darwinOnly, async () => {
    const { monitor } = monitorWithHelper(script);
    assert.equal(await monitor.pasteAndReturnForPid(42, 7), outcome);
  });
}

test(
  "pasteAndReturnForPid passes exactly --paste-return-to-pid <pid> <window>",
  darwinOnly,
  async () => {
    // Confirms only for the exact trailing argv; anything else is an unknown answer.
    const { monitor } = monitorWithHelper(
      '[ "$#" = "2" ] && [ "$0 $1 $2" = "--paste-return-to-pid 42 7" ] && echo "PASTE_RETURN_OK:42"'
    );
    assert.equal(await monitor.pasteAndReturnForPid(42, 7), "submitted");
    assert.equal(await monitor.pasteAndReturnForPid(42, 8), "failed");
    assert.equal(await monitor.pasteAndReturnForPid(43, 7), "failed");
  }
);

test(
  "pasteAndReturnForPid: an unrunnable helper is failed, no helper is skipped",
  darwinOnly,
  async () => {
    const run = (resolveBinary) => {
      const monitor = new TextEditMonitor();
      monitor.resolveBinary = resolveBinary;
      return monitor.pasteAndReturnForPid(42, 7);
    };
    assert.equal(await run(() => ({ command: "/nonexistent/helper", args: [] })), "failed");
    // execFile itself throws on a command that is not a string.
    assert.equal(await run(() => ({ command: null, args: [] })), "failed");
    assert.equal(await run(() => null), "skipped");
    const throwing = () => {
      throw new Error("no binary");
    };
    assert.equal(await run(throwing), "skipped");
  }
);

test("pasteAndReturnForPid runs no helper for an invalid pid or window, or off macOS", async () => {
  const { monitor, resolves } = monitorWithHelper('echo "PASTE_RETURN_OK:42"');
  for (const bad of [undefined, null, 0, -1, 1.5, "42", NaN]) {
    assert.equal(await monitor.pasteAndReturnForPid(bad, 7), "skipped", `pid ${bad}`);
    assert.equal(await monitor.pasteAndReturnForPid(42, bad), "skipped", `window ${bad}`);
  }
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    assert.equal(await monitor.pasteAndReturnForPid(42, 7), "skipped", "off macOS");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.equal(resolves(), 0);
});
