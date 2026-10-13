const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

const darwinOnly = { skip: process.platform !== "darwin" };

function stubFrontmostPid(monitor, pid) {
  let invocations = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve({ pid, window: null });
  });
  monitor._readFrontmostTarget = () => {
    invocations += 1;
    return gate;
  };
  return { release, count: () => invocations };
}

test("concurrent captures share one frontmost lookup", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostPid(m, 4242);

  const first = m.captureTargetPid();
  const second = m.captureTargetPid();
  lookup.release();

  assert.deepEqual(await Promise.all([first, second]), [4242, 4242]);
  assert.equal(lookup.count(), 1);
  assert.equal(m.lastTargetPid, 4242);
});

test("a just-completed capture is reused instead of respawning osascript", darwinOnly, async () => {
  const m = new TextEditMonitor();
  const lookup = stubFrontmostPid(m, 4242);

  const first = m.captureTargetPid();
  lookup.release();
  await first;

  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(lookup.count(), 1);
});

test("a failed capture is retried, not reused", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostTarget = () => {
    invocations += 1;
    return Promise.resolve({ pid: invocations === 1 ? null : 4242, window: null });
  };

  assert.equal(await m.captureTargetPid(), null);
  assert.equal(await m.captureTargetPid(), 4242);
  assert.equal(invocations, 2);
});

test("captures refresh once the reuse window has passed", darwinOnly, async () => {
  const m = new TextEditMonitor();
  let invocations = 0;
  m._readFrontmostTarget = () => {
    invocations += 1;
    return Promise.resolve({ pid: invocations === 1 ? 1111 : 2222, window: null });
  };

  assert.equal(await m.captureTargetPid(), 1111);
  m._lastCaptureAt = Date.now() - 10_000;
  assert.equal(await m.captureTargetPid(), 2222);
  assert.equal(m.lastTargetPid, 2222);
});

// A shell stands in for the native helper's --frontmost-pid answer.
function stubHelperAnswers(monitor, answers) {
  let call = 0;
  monitor.resolveBinary = () => {
    const lines = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return { command: "/bin/sh", args: ["-c", `printf '%s\\n' ${lines.join(" ")}`] };
  };
}

test(
  "a two-line helper answer records the target window, a later one without it clears it",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    m.setCaptureTargetWindow(true);
    stubHelperAnswers(m, [["FRONTMOST_PID:4242", "FRONTMOST_WINDOW:917"], ["FRONTMOST_PID:5151"]]);

    assert.equal(m.lastTargetWindow, null);
    assert.equal(await m.captureTargetPid(), 4242);
    assert.equal(m.lastTargetPid, 4242);
    assert.equal(m.lastTargetWindow, 917);

    m._lastCaptureAt = Date.now() - 10_000;
    assert.equal(await m.captureTargetPid(), 5151);
    assert.equal(m.lastTargetPid, 5151);
    assert.equal(m.lastTargetWindow, null);
  }
);

test(
  "the helper's bundle id is stored with the pid and window, and is null without its line",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    m.setCaptureTargetWindow(true);
    stubHelperAnswers(m, [
      ["FRONTMOST_PID:4242", "FRONTMOST_BUNDLE:com.googlecode.iterm2", "FRONTMOST_WINDOW:917"],
      ["FRONTMOST_PID:5151", "FRONTMOST_WINDOW:12"],
    ]);

    assert.equal(await m.captureTargetPid(), 4242);
    assert.deepEqual(
      [m.lastTargetPid, m.lastTargetWindow, m.lastTargetBundleId],
      [4242, 917, "com.googlecode.iterm2"]
    );

    m._lastCaptureAt = Date.now() - 10_000;
    assert.equal(await m.captureTargetPid(), 5151);
    assert.deepEqual([m.lastTargetPid, m.lastTargetWindow, m.lastTargetBundleId], [5151, 12, null]);
  }
);

// A shell that answers with a pid and a window line only when it was run with
// exactly the expected arguments, and fails otherwise. The osascript fallback
// is stubbed to null so a wrong argument list cannot be rescued by it.
function stubHelperExpectingArgs(monitor, expectedArgs) {
  const script =
    `[ "$*" = "${expectedArgs}" ] || exit 1; ` +
    "printf '%s\\n' FRONTMOST_PID:4242 FRONTMOST_WINDOW:917";
  monitor.resolveBinary = () => ({ command: "/bin/sh", args: ["-c", script, "sh"] });
  monitor._readFrontmostPidViaOsascript = () => Promise.resolve(null);
}

test(
  "captureTargetPid adds --with-window only while setCaptureTargetWindow(true) is in effect",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    const capture = async (expectedArgs) => {
      stubHelperExpectingArgs(m, expectedArgs);
      m._lastCaptureAt = 0;
      return [await m.captureTargetPid(), m.lastTargetWindow];
    };

    assert.deepEqual(await capture("--frontmost-pid"), [4242, null]);
    m.setCaptureTargetWindow(true);
    assert.deepEqual(await capture("--frontmost-pid --with-window"), [4242, 917]);
    m.setCaptureTargetWindow(false);
    assert.deepEqual(await capture("--frontmost-pid"), [4242, null]);
  }
);

test(
  "_readFrontmostPid runs the helper with exactly --frontmost-pid and resolves a bare pid",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    stubHelperExpectingArgs(m, "--frontmost-pid");

    // The answer carries a window line; the pid-only read must not surface it.
    assert.equal(await m._readFrontmostPid(), 4242);
    assert.deepEqual(await m._readFrontmostTarget(), { pid: 4242, window: null, bundleId: null });
    assert.equal(m.lastTargetPid, null);
    assert.equal(m.lastTargetWindow, null);
  }
);

test(
  "a pid printed before the helper timed out is kept, without the osascript fallback",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    let fallbacks = 0;
    // exec, so the 1000 ms timeout's kill reaches the sleeping process itself.
    const script = "echo FRONTMOST_PID:42; exec sleep 3";
    m.resolveBinary = () => ({ command: "/bin/sh", args: ["-c", script] });
    m._readFrontmostPidViaOsascript = () => {
      fallbacks += 1;
      return Promise.resolve(99);
    };

    assert.equal(await m.captureTargetPid(), 42);
    assert.equal(m.lastTargetWindow, null);
    assert.equal(fallbacks, 0);
  }
);

test(
  "a capture on the osascript fallback is not given another read's window",
  darwinOnly,
  async () => {
    const m = new TextEditMonitor();
    // The capture's helper call fails, so it waits on the osascript fallback.
    let fallbackEntered;
    const inFallback = new Promise((resolve) => {
      fallbackEntered = resolve;
    });
    let releaseFallback;
    m._readFrontmostPidViaOsascript = () =>
      new Promise((resolve) => {
        releaseFallback = () => resolve(1111);
        fallbackEntered();
      });
    m.resolveBinary = () => ({ command: "/bin/sh", args: ["-c", "exit 1"] });

    const capture = m.captureTargetPid();
    await inFallback;

    // A second read resolves in between with another app and its window.
    stubHelperAnswers(m, [["FRONTMOST_PID:2222", "FRONTMOST_WINDOW:77"]]);
    assert.deepEqual(await m._readFrontmostTarget({ withWindow: true }), {
      pid: 2222,
      window: 77,
      bundleId: null,
    });

    releaseFallback();
    assert.equal(await capture, 1111);
    assert.equal(m.lastTargetPid, 1111);
    assert.equal(m.lastTargetWindow, null);
  }
);
