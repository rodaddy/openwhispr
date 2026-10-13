const test = require("node:test");
const assert = require("node:assert/strict");

const { createLarkM2StatusGetter, parseLarkM2Status } = require("../../src/helpers/larkM2Status");

const logger = { debug() {} };

test("parses a valid receiver response as connected when either transmitter is connected", () => {
  assert.deepEqual(
    parseLarkM2Status(
      JSON.stringify({
        status: "connected",
        receiverPresent: true,
        tx1Connected: true,
        tx2Connected: false,
      })
    ),
    {
      status: "connected",
      receiverPresent: true,
      tx1Connected: true,
      tx2Connected: false,
    }
  );
});

test("parses a valid receiver response with both transmitters off as disconnected", () => {
  assert.deepEqual(
    parseLarkM2Status(
      JSON.stringify({
        status: "disconnected",
        receiverPresent: true,
        tx1Connected: false,
        tx2Connected: false,
      })
    ),
    {
      status: "disconnected",
      receiverPresent: true,
      tx1Connected: false,
      tx2Connected: false,
    }
  );
});

test("rejects invalid transmitter booleans and truncated output instead of guessing disconnected", () => {
  assert.equal(
    parseLarkM2Status(
      JSON.stringify({
        status: "disconnected",
        receiverPresent: true,
        tx1Connected: 0,
        tx2Connected: false,
      })
    ),
    null
  );
  assert.equal(parseLarkM2Status('{"status":"disconnected","receiverPresent":true'), null);
});

test("caches completed status briefly and shares an in-flight query", async () => {
  let calls = 0;
  let resolveRun;
  const runResult = new Promise((resolve) => {
    resolveRun = resolve;
  });
  const getStatus = createLarkM2StatusGetter({
    platform: "darwin",
    resolveBinary: () => "/fake/macos-mic-listener",
    run: async () => {
      calls += 1;
      return runResult;
    },
    logger,
    now: () => 100,
  });

  const first = getStatus();
  const second = getStatus();
  assert.equal(calls, 1);
  resolveRun(
    JSON.stringify({
      status: "connected",
      receiverPresent: true,
      tx1Connected: false,
      tx2Connected: true,
    })
  );
  assert.deepEqual(await first, await second);
  assert.deepEqual(await getStatus(), await first);
  assert.equal(calls, 1);
});

test("returns unknown for command timeout and non-macOS without claiming signal loss", async () => {
  const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true });
  const timedOut = createLarkM2StatusGetter({
    platform: "darwin",
    resolveBinary: () => "/fake/macos-mic-listener",
    run: async () => {
      throw timeout;
    },
    logger,
  });
  let nonMacRun = false;
  const nonMac = createLarkM2StatusGetter({
    platform: "linux",
    run: async () => {
      nonMacRun = true;
    },
    logger,
  });

  assert.deepEqual(await timedOut(), { status: "unknown", receiverPresent: null });
  assert.deepEqual(await nonMac(), { status: "unknown", receiverPresent: null });
  assert.equal(nonMacRun, false);
});

test("an idle caller within 30 s reuses the status; a forced refresh or expiry spawns again", async () => {
  let calls = 0;
  let clock = 0;
  const getStatus = createLarkM2StatusGetter({
    platform: "darwin",
    resolveBinary: () => "/fake/macos-mic-listener",
    run: async () => {
      calls += 1;
      return JSON.stringify({ status: "unknown", receiverPresent: null });
    },
    logger,
    now: () => clock,
  });

  await getStatus();
  clock = 29_999;
  await getStatus();
  assert.equal(calls, 1, "two calls within 30 s spawn the helper once");
  await getStatus({ refresh: true });
  assert.equal(calls, 2, "a forced refresh spawns again");
  clock = 29_999 + 30_000;
  await getStatus();
  assert.equal(calls, 3, "an expired cache spawns again");
});

async function failingQuery(error) {
  const forgotten = [];
  const getStatus = createLarkM2StatusGetter({
    platform: "darwin",
    resolveBinary: () => "/fake/macos-mic-listener",
    forgetBinary: (name) => forgotten.push(name),
    run: async () => {
      throw error;
    },
    logger,
  });
  assert.deepEqual(await getStatus(), { status: "unknown", receiverPresent: null });
  return forgotten;
}

for (const code of ["ENOENT", "EACCES"]) {
  test(`a helper that cannot be spawned (${code}) is forgotten so the next query re-resolves it`, async () => {
    const error = Object.assign(new Error(`spawn ${code}`), { code });
    assert.deepEqual(await failingQuery(error), ["macos-mic-listener"]);
  });
}

test("a helper that ran and failed is not forgotten", async () => {
  const timedOut = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
  assert.deepEqual(await failingQuery(timedOut), [], "a timeout keeps the cached path");
  const exited = Object.assign(new Error("exit 1"), { code: 1 });
  assert.deepEqual(await failingQuery(exited), [], "a non-zero exit keeps the cached path");
  const overflow = Object.assign(new Error("maxBuffer"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
  assert.deepEqual(await failingQuery(overflow), [], "an output overflow keeps the cached path");
});
