const test = require("node:test");
const assert = require("node:assert/strict");

const ParakeetServerManager = require("../../src/helpers/parakeetServer");

const SAMPLE_RATE = 16000;
const SEGMENT_BYTES = 15 * SAMPLE_RATE * 4; // float32, mirrors MAX_SEGMENT_SECONDS

// Minimal 16kHz mono 16-bit WAV so _ensureWav uses the buffer as-is (no FFmpeg).
function wavFromSeconds(spans) {
  const totalSamples = spans.reduce((sum, span) => sum + span.seconds * SAMPLE_RATE, 0);
  const dataSize = totalSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (const span of spans) {
    const amplitude = span.silent ? 0 : 8000;
    for (let i = 0; i < span.seconds * SAMPLE_RATE; i++) {
      buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, offset);
      offset += 2;
    }
  }
  return buf;
}

function fakeWsServer(responses, { onCall } = {}) {
  const calls = [];
  return {
    calls,
    async start() {},
    async transcribe(samplesBuffer) {
      calls.push(samplesBuffer.length);
      const next = responses.shift();
      assert.ok(next, "unexpected extra transcribe call");
      onCall?.(calls.length);
      return { elapsed: 1, ...next };
    },
  };
}

function isAbortError(err) {
  assert.equal(err.name, "AbortError");
  return true;
}

function managerWith(fake) {
  const manager = new ParakeetServerManager();
  manager.isModelDownloaded = () => true;
  manager.wsServer = fake;
  return manager;
}

test("audio at or under the 15s cap decodes in one request", async () => {
  const fake = fakeWsServer([{ text: "hello" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 10 }]));

  assert.equal(result.text, "hello");
  assert.deepEqual(fake.calls, [10 * SAMPLE_RATE * 4]);
});

test("retries a single-request decode when audible audio decodes to empty", async () => {
  const fake = fakeWsServer([{ text: "" }, { text: "hello" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 10 }]));

  assert.equal(result.text, "hello");
  assert.deepEqual(fake.calls, [10 * SAMPLE_RATE * 4, 10 * SAMPLE_RATE * 4]);
});

test("retries once when an audible segment decodes to empty text", async () => {
  const fake = fakeWsServer([{ text: "" }, { text: "one" }, { text: "two" }, { text: "three" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "one two three");
  assert.ok(!result.truncated, "a recovered retry must not flag truncation");
  assert.deepEqual(fake.calls, [SEGMENT_BYTES, SEGMENT_BYTES, SEGMENT_BYTES, SAMPLE_RATE * 4]);
});

test("a truncated empty first attempt does not taint a successful retry", async () => {
  const fake = fakeWsServer([
    { text: "", truncated: true },
    { text: "one" },
    { text: "two" },
    { text: "three" },
  ]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "one two three");
  assert.ok(!result.truncated, "the discarded attempt's truncation must not survive recovery");
});

test("flags truncation when an audible segment stays empty after the retry", async () => {
  const fake = fakeWsServer([{ text: "" }, { text: "" }, { text: "two" }, { text: "three" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "two three");
  assert.equal(result.truncated, true);
});

test("a silent segment decoding to empty is not retried or flagged", async () => {
  const fake = fakeWsServer([{ text: "alpha" }, { text: "" }, { text: "omega" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(
    wavFromSeconds([{ seconds: 15 }, { seconds: 15, silent: true }, { seconds: 1 }])
  );

  assert.equal(result.text, "alpha omega");
  assert.ok(!result.truncated, "silence is not data loss");
  assert.equal(fake.calls.length, 3);
});

test("a pre-aborted signal rejects before any decode is issued", async () => {
  const fake = fakeWsServer([]);
  const manager = managerWith(fake);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => manager.transcribe(wavFromSeconds([{ seconds: 10 }]), { signal: controller.signal }),
    isAbortError
  );
  assert.equal(fake.calls.length, 0);
});

test("an abort during the first segment stops the segment loop", async () => {
  const controller = new AbortController();
  const fake = fakeWsServer([{ text: "one" }, { text: "two" }, { text: "three" }], {
    onCall: () => controller.abort(),
  });
  const manager = managerWith(fake);

  await assert.rejects(
    () => manager.transcribe(wavFromSeconds([{ seconds: 31 }]), { signal: controller.signal }),
    isAbortError
  );
  assert.equal(fake.calls.length, 1, "no further segments may be scheduled after the abort");
});

test("an abort between an empty decode and its retry suppresses the retry", async () => {
  const controller = new AbortController();
  const fake = fakeWsServer([{ text: "" }, { text: "recovered" }], {
    onCall: () => controller.abort(),
  });
  const manager = managerWith(fake);

  await assert.rejects(
    () => manager.transcribe(wavFromSeconds([{ seconds: 10 }]), { signal: controller.signal }),
    isAbortError
  );
  assert.equal(fake.calls.length, 1, "the empty-decode retry must not run after a cancel");
});

test("transcribe without a signal is unchanged", async () => {
  const fake = fakeWsServer([{ text: "one" }, { text: "two" }, { text: "three" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "one two three");
  assert.equal(fake.calls.length, 3);
});

test("cohere models segment at 30s and start the server with the resolved language", async () => {
  const fake = fakeWsServer([{ text: "one" }, { text: "two" }]);
  const startArgs = [];
  fake.start = async (...args) => {
    startArgs.push(args);
  };
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]), {
    modelName: "cohere-transcribe-03-2026",
    language: "pl",
  });

  assert.equal(result.text, "one two");
  assert.deepEqual(fake.calls, [30 * SAMPLE_RATE * 4, 1 * SAMPLE_RATE * 4]);
  assert.equal(startArgs.length, 1);
  assert.equal(startArgs[0][0], "cohere-transcribe-03-2026");
  assert.equal(startArgs[0][2], "offline");
  assert.equal(startArgs[0][3], "pl");
});

test("cohere models fall back to English when the app language has no match", async () => {
  const fake = fakeWsServer([{ text: "hello" }]);
  const startArgs = [];
  fake.start = async (...args) => {
    startArgs.push(args);
  };
  const manager = managerWith(fake);

  await manager.transcribe(wavFromSeconds([{ seconds: 5 }]), {
    modelName: "cohere-transcribe-03-2026",
    language: "auto",
  });

  assert.equal(startArgs[0][3], "en");
});

test("transducer models start the server without a language", async () => {
  const fake = fakeWsServer([{ text: "hello" }]);
  const startArgs = [];
  fake.start = async (...args) => {
    startArgs.push(args);
  };
  const manager = managerWith(fake);

  await manager.transcribe(wavFromSeconds([{ seconds: 5 }]), { language: "pl" });

  assert.equal(startArgs[0][3], null);
});

// Idle unload (#640): manual timers, so nothing fires until the test says so.
function fakeIdleTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeoutImpl(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutImpl(id) {
      pending.delete(id);
    },
    pendingCount: () => pending.size,
    fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

function idleManagerWith(fake, timers) {
  const manager = new ParakeetServerManager({
    idleMs: 1000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  manager.isModelDownloaded = () => true;
  fake.isAvailable = () => true;
  fake.stops = 0;
  fake.stop = async () => {
    fake.stops += 1;
  };
  manager.wsServer = fake;
  return manager;
}

test("an idle fire after a start stops the ws server exactly once", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  const manager = idleManagerWith(fake, timers);

  const started = await manager.startServer("parakeet-tdt-0.6b-v3");
  assert.equal(started.success, true);
  assert.equal(timers.pendingCount(), 1);

  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.stops, 1);
  assert.equal(timers.pendingCount(), 0);
});

test("the idle stop does not fire while a transcribe is in flight", async () => {
  const timers = fakeIdleTimers();
  let pendingDuringCall = null;
  const fake = fakeWsServer([{ text: "hello" }], {
    onCall: () => {
      pendingDuringCall = timers.pendingCount();
      timers.fireAll();
    },
  });
  const manager = idleManagerWith(fake, timers);

  await manager.startServer("parakeet-tdt-0.6b-v3");
  const result = await manager.transcribe(wavFromSeconds([{ seconds: 5 }]));

  assert.equal(result.text, "hello");
  assert.equal(pendingDuringCall, 0, "the pending idle stop is cancelled while in use");
  assert.equal(fake.stops, 0);
  assert.equal(timers.pendingCount(), 1, "finishing the transcribe re-arms the idle stop");

  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.stops, 1);
});

test("a failed or aborted transcribe still releases the idle counter", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  fake.transcribe = async () => {
    throw new Error("decode failed");
  };
  const manager = idleManagerWith(fake, timers);

  await assert.rejects(manager.transcribe(wavFromSeconds([{ seconds: 5 }])), /decode failed/);

  assert.equal(manager.idleTimer.activeCount(), 0);
  assert.equal(timers.pendingCount(), 1);
});

test("an explicit stopServer cancels the pending idle stop", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  const manager = idleManagerWith(fake, timers);

  await manager.startServer("parakeet-tdt-0.6b-v3");
  assert.equal(timers.pendingCount(), 1);

  await manager.stopServer();
  assert.equal(fake.stops, 1);
  assert.equal(timers.pendingCount(), 0);

  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.stops, 1, "no second stop from the idle timer");
});

test("an online stream holds off the idle stop until it finishes, aborts or errors", async () => {
  for (const endWith of ["finish", "abort", "error", "finish+abort"]) {
    const timers = fakeIdleTimers();
    const fake = fakeWsServer([]);
    let streamOptions = null;
    fake.createOnlineStream = (options) => {
      streamOptions = options;
      return { finish: async () => ({ text: "hi", truncated: false }), abort() {} };
    };
    const manager = idleManagerWith(fake, timers);
    const errors = [];

    await manager.startServer("parakeet-tdt-0.6b-v3");
    const stream = manager.createOnlineStream({ onError: (error) => errors.push(error.message) });
    assert.equal(timers.pendingCount(), 0, endWith);
    assert.equal(manager.idleTimer.activeCount(), 1, endWith);

    if (endWith === "error") {
      streamOptions.onError(new Error("socket died"));
      assert.deepEqual(errors, ["socket died"]);
    } else {
      if (endWith.includes("finish")) assert.equal((await stream.finish()).text, "hi");
      if (endWith.includes("abort")) stream.abort();
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.idleTimer.activeCount(), 0, `${endWith}: released exactly once`);
    assert.equal(timers.pendingCount(), 1, endWith);
    assert.equal(fake.stops, 0, endWith);
  }
});

test("a stream that fails to open does not leak the idle counter", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  fake.createOnlineStream = () => {
    throw new Error("parakeet-ws server is not running");
  };
  const manager = idleManagerWith(fake, timers);

  assert.throws(() => manager.createOnlineStream({}), /not running/);

  assert.equal(manager.idleTimer.activeCount(), 0);
});

// A stop the test settles by hand. Mirrors wsServer.stop(), which keeps the
// server looking ready until its process is gone.
function deferredStopOn(fake) {
  let release;
  fake.stop = () => {
    fake.stops += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  return () => release();
}

test("a start during an idle stop waits for it instead of reusing the dying server", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  const manager = idleManagerWith(fake, timers);
  await manager.startServer("parakeet-tdt-0.6b-v3");

  const order = [];
  const finishStop = deferredStopOn(fake);
  fake.start = async () => {
    order.push("start");
  };

  timers.fireAll();
  assert.equal(fake.stops, 1);

  const restarted = manager.startServer("parakeet-tdt-0.6b-v3");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "no start while the idle stop is still in flight");

  order.push("stopped");
  finishStop();
  assert.equal((await restarted).success, true);
  assert.deepEqual(order, ["stopped", "start"]);
});

test("a transcribe during an idle stop waits for it, then restarts the server", async () => {
  const timers = fakeIdleTimers();
  const order = [];
  const fake = fakeWsServer([{ text: "hello" }], { onCall: () => order.push("transcribe") });
  const manager = idleManagerWith(fake, timers);
  await manager.startServer("parakeet-tdt-0.6b-v3");

  const finishStop = deferredStopOn(fake);
  fake.start = async () => {
    order.push("start");
  };

  timers.fireAll();
  const pending = manager.transcribe(wavFromSeconds([{ seconds: 5 }]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "nothing reaches the server while the idle stop is in flight");

  order.push("stopped");
  finishStop();
  assert.equal((await pending).text, "hello");
  assert.deepEqual(order, ["stopped", "start", "transcribe"]);
  assert.equal(fake.stops, 1);
});

test("a stream cannot open on a server that is being idle-stopped", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  let opened = 0;
  fake.createOnlineStream = () => {
    opened += 1;
    return { finish: async () => ({ text: "", truncated: false }), abort() {} };
  };
  const manager = idleManagerWith(fake, timers);
  await manager.startServer("parakeet-tdt-0.6b-v3");

  const finishStop = deferredStopOn(fake);
  timers.fireAll();

  assert.throws(() => manager.createOnlineStream({}), /stopping/);
  assert.equal(opened, 0);
  assert.equal(manager.idleTimer.activeCount(), 0);

  finishStop();
  await new Promise((resolve) => setImmediate(resolve));
  manager.createOnlineStream({});
  assert.equal(opened, 1, "a stream opens again once the stop has finished");
});

test("a transcribe cancelled during an idle stop rejects without converting the audio", async () => {
  const timers = fakeIdleTimers();
  const fake = fakeWsServer([]);
  const manager = idleManagerWith(fake, timers);
  await manager.startServer("parakeet-tdt-0.6b-v3");
  let conversions = 0;
  const ensureWav = manager._ensureWav.bind(manager);
  manager._ensureWav = async (audioBuffer) => {
    conversions += 1;
    return ensureWav(audioBuffer);
  };

  const finishStop = deferredStopOn(fake);
  timers.fireAll();
  const controller = new AbortController();
  const pending = manager.transcribe(wavFromSeconds([{ seconds: 5 }]), {
    signal: controller.signal,
  });
  controller.abort();
  finishStop();

  await assert.rejects(pending, isAbortError);
  assert.equal(conversions, 0);
});
