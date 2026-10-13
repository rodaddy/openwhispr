const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createOmnivoiceLocalEngine,
  DONE_MARKER,
} = require("../../src/helpers/omnivoiceLocalEngine");

const PLACEHOLDER_SIZE = 0x7fffffff;
const REF_A = { referenceWavPath: "/voices/a.wav", referenceTextPath: "/voices/a.txt" };
const REF_B = { referenceWavPath: "/voices/b.wav", referenceTextPath: "/voices/b.txt" };

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The sidecar-shaped WAV: 44-byte header with placeholder sizes, then PCM.
function wavChunk(pcmBytes) {
  const pcm = Buffer.isBuffer(pcmBytes) ? pcmBytes : Buffer.from(pcmBytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(PLACEHOLDER_SIZE, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(PLACEHOLDER_SIZE, 40);
  return Buffer.concat([header, pcm]);
}

function assertWav(wav, pcmBytes) {
  const pcm = Buffer.from(pcmBytes);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("latin1", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = {
    writes: [],
    ended: 0,
    write(data) {
      this.writes.push(String(data));
      return true;
    },
    end() {
      this.ended += 1;
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.exited = false;
  child.kill = (signal) => {
    child.kills.push(signal);
    if (!child.exited) {
      child.exited = true;
      child.emit("exit", null, signal);
    }
    return true;
  };
  return child;
}

function setup(t, overrides = {}, makeChild = makeFakeChild) {
  const children = [];
  const spawnCalls = [];
  const spawnImpl = (command, args, options) => {
    const child = makeChild();
    spawnCalls.push({ command, args, options });
    children.push(child);
    return child;
  };
  const engine = createOmnivoiceLocalEngine({
    spawnImpl,
    existsSync: () => true,
    binaryPath: "/bin/omnivoice-tts",
    modelPath: "/models/model.gguf",
    codecPath: "/models/codec.gguf",
    settleMs: 5,
    idleMs: 40,
    requestTimeoutMs: 80,
    ...overrides,
  });
  t.after(() => engine.stop());
  return { engine, children, spawnCalls };
}

const emitOut = (child, buffer) => child.stdout.emit("data", buffer);
const emitErr = (child, text) => child.stderr.emit("data", Buffer.from(text));
const emitDone = (child) => emitErr(child, `${DONE_MARKER}\n`);

function utter(child, pcmBytes) {
  emitOut(child, wavChunk(pcmBytes));
  emitDone(child);
}

test("happy path: exact spawn argv, single-line stdin, finalized WAV", async (t) => {
  const spawned = [];
  const { engine, children, spawnCalls } = setup(t, { onSpawn: (child) => spawned.push(child) });

  const pending = engine.synthesize({ text: " hello\nworld ", ...REF_A });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "/bin/omnivoice-tts");
  assert.deepEqual(spawnCalls[0].args, [
    "--model",
    "/models/model.gguf",
    "--codec",
    "/models/codec.gguf",
    "--ref-wav",
    "/voices/a.wav",
    "--ref-text",
    "/voices/a.txt",
    "--lang",
    "English",
    "--steps",
    "16",
    "--seed",
    "42",
    "--stream-by-line",
    "-o",
    "-",
  ]);
  assert.deepEqual(spawnCalls[0].options, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  assert.deepEqual(spawned, [children[0]]);
  assert.deepEqual(children[0].stdin.writes, ["hello world\n"]);
  assert.deepEqual(engine.getStatus(), { running: true, queued: 0, busy: true });

  utter(children[0], [9, 8, 7, 6]);
  assertWav(await pending, [9, 8, 7, 6]);
  assert.deepEqual(engine.getStatus(), { running: true, queued: 0, busy: false });
});

test("stdout split into chunks, the last one after the Done line, is fully included", async (t) => {
  const { engine, children } = setup(t, { settleMs: 30 });
  const pending = engine.synthesize({ text: "split", ...REF_A });
  const child = children[0];
  const whole = wavChunk([1, 2, 3, 4, 5, 6, 7, 8]);

  emitOut(child, whole.subarray(0, 10));
  emitOut(child, whole.subarray(10, 46));
  emitDone(child);
  emitOut(child, whole.subarray(46, 50));
  // Each late chunk restarts the settle timer: 20 + 20 ms outlasts a single 30 ms window.
  await tick(20);
  emitOut(child, whole.subarray(50));
  await tick(20);
  assert.equal(engine.getStatus().busy, true);

  assertWav(await pending, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a Done marker split across two stderr data events is still seen", async (t) => {
  const { engine, children } = setup(t);
  const pending = engine.synthesize({ text: "marker", ...REF_A });
  const child = children[0];

  emitOut(child, wavChunk([5, 5]));
  emitErr(child, "[TTS] step 16/16\n[TTS-Str");
  emitErr(child, "eam] Done\n");

  assertWav(await pending, [5, 5]);
});

test("two requests are served FIFO over one child, each with its own audio", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  const second = engine.synthesize({ text: "second", ...REF_A });
  const child = children[0];

  assert.deepEqual(child.stdin.writes, ["first\n"]);
  assert.deepEqual(engine.getStatus(), { running: true, queued: 1, busy: true });

  emitOut(child, wavChunk([1, 1, 1, 1]));
  emitDone(child);
  assert.deepEqual(child.stdin.writes, ["first\n"], "second waits for the first to settle");
  assertWav(await first, [1, 1, 1, 1]);
  assert.deepEqual(child.stdin.writes, ["first\n", "second\n"]);

  utter(child, [2, 2]);
  assertWav(await second, [2, 2]);
  assert.equal(spawnCalls.length, 1);
});

// A child that exits only when the test emits its exit: kill and stdin end do nothing on their own.
function makeManualExitChild() {
  const child = makeFakeChild();
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

const setupManualExit = (t) => setup(t, { idleMs: 0, requestTimeoutMs: 2000 }, makeManualExitChild);

test("a new reference waits for the retired child to exit", async (t) => {
  const { engine, children, spawnCalls } = setupManualExit(t);
  const first = engine.synthesize({ text: "one", ...REF_A });
  utter(children[0], [1, 1]);
  await first;

  const second = engine.synthesize({ text: "two", ...REF_B });
  await tick(5);
  assert.equal(spawnCalls.length, 1);
  assert.equal(children[0].stdin.ended, 1);
  assert.deepEqual(engine.getStatus(), { running: false, queued: 1, busy: false });

  children[0].emit("exit", 0, null);
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[1].args[spawnCalls[1].args.indexOf("--ref-wav") + 1], "/voices/b.wav");
  assert.deepEqual(children[1].stdin.writes, ["two\n"]);
  utter(children[1], [2, 2]);
  assertWav(await second, [2, 2]);
});

test("the grace kill ends the wait", async (t) => {
  // The default fake ignores stdin end and exits only when killed.
  const { engine, children, spawnCalls } = setup(t, { idleMs: 0, requestTimeoutMs: 5000 });
  const first = engine.synthesize({ text: "one", ...REF_A });
  utter(children[0], [1, 1]);
  await first;

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const second = engine.synthesize({ text: "two", ...REF_B });
  t.mock.timers.tick(1999);
  assert.equal(spawnCalls.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.equal(spawnCalls.length, 2);

  utter(children[1], [2, 2]);
  t.mock.timers.tick(5);
  assertWav(await second, [2, 2]);
});

test("an already-aborted signal rejects without spawning", async (t) => {
  const { engine, spawnCalls } = setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.synthesize({ text: "nope", ...REF_A, signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(spawnCalls.length, 0);
});

test("abort while queued leaves the child untouched", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const controller = new AbortController();
  const first = engine.synthesize({ text: "first", ...REF_A });
  const second = engine.synthesize({ text: "second", ...REF_A, signal: controller.signal });
  const third = engine.synthesize({ text: "third", ...REF_A });

  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.deepEqual(children[0].kills, []);
  assert.equal(children[0].stdin.ended, 0);
  assert.equal(engine.getStatus().queued, 1);

  utter(children[0], [1, 1]);
  assertWav(await first, [1, 1]);
  assert.deepEqual(children[0].stdin.writes, ["first\n", "third\n"]);
  utter(children[0], [3, 3]);
  assertWav(await third, [3, 3]);
  assert.equal(spawnCalls.length, 1);
});

test("abort in flight kills the child and the next request spawns again", async (t) => {
  const exits = [];
  const { engine, children, spawnCalls } = setup(t, { onExit: () => exits.push("exit") });
  const controller = new AbortController();
  const first = engine.synthesize({ text: "first", ...REF_A, signal: controller.signal });
  emitOut(children[0], wavChunk([1, 2]));

  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.deepEqual(exits, ["exit"]);
  assert.deepEqual(engine.getStatus(), { running: false, queued: 0, busy: false });

  const second = engine.synthesize({ text: "second", ...REF_A });
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [7, 7]);
  assertWav(await second, [7, 7]);
});

test("a request in flight past the timeout kills the child", async (t) => {
  const { engine, children } = setup(t);
  const pending = engine.synthesize({ text: "slow", ...REF_A });
  await assert.rejects(pending, { message: "Local speech timed out" });
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.equal(engine.getStatus().running, false);
});

test("child exit mid-request rejects it and a fresh child serves the queue", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  const second = engine.synthesize({ text: "second", ...REF_A });
  const rejected = assert.rejects(first, {
    message: "Local speech process exited (3): boom: out of memory",
  });

  emitErr(children[0], "loading model\nboom: out of memory\n");
  children[0].emit("exit", 3, null);
  await rejected;

  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(children[1].stdin.writes, ["second\n"]);
  utter(children[1], [4, 4]);
  assertWav(await second, [4, 4]);
});

test("a child error event rejects the in-flight request", async (t) => {
  const { engine, children } = setup(t);
  const pending = engine.synthesize({ text: "first", ...REF_A });
  const rejected = assert.rejects(pending, { message: "Local speech process exited (ENOENT): " });
  children[0].emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  await rejected;
  assert.equal(engine.getStatus().running, false);
});

test("an exit with nothing in flight just clears the child", async (t) => {
  const exits = [];
  const { engine, children, spawnCalls } = setup(t, { onExit: () => exits.push("exit") });
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;

  children[0].emit("exit", 0, null);
  assert.deepEqual(exits, ["exit"]);
  assert.equal(engine.getStatus().running, false);

  const second = engine.synthesize({ text: "second", ...REF_A });
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [2, 2]);
  assertWav(await second, [2, 2]);
});

test("idle: the child gets stdin.end() after idleMs", async (t) => {
  const { engine, children } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;
  assert.equal(children[0].stdin.ended, 0);

  await tick(90);
  assert.equal(children[0].stdin.ended, 1);
  assert.equal(engine.getStatus().running, false);
});

test("idle: a request before idleMs cancels the idle stop", async (t) => {
  const { engine, children, spawnCalls } = setup(t, { requestTimeoutMs: 2000 });
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;

  await tick(15);
  const second = engine.synthesize({ text: "second", ...REF_A });
  await tick(80);
  assert.equal(children[0].stdin.ended, 0);
  assert.equal(spawnCalls.length, 1);

  utter(children[0], [2, 2]);
  assertWav(await second, [2, 2]);
});

test("idleMs <= 0 disables the idle stop", async (t) => {
  const { engine, children } = setup(t, { idleMs: 0 });
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;
  await tick(60);
  assert.equal(children[0].stdin.ended, 0);
  assert.equal(engine.getStatus().running, true);
});

test("reset() lets the in-flight request finish, then stops the child", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  engine.reset();
  assert.equal(children[0].stdin.ended, 0);

  utter(children[0], [1, 1]);
  assertWav(await first, [1, 1]);
  assert.equal(children[0].stdin.ended, 1);
  assert.deepEqual(children[0].kills, []);

  children[0].emit("exit", 0, null);
  const second = engine.synthesize({ text: "second", ...REF_A });
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [2, 2]);
  await second;

  engine.reset();
  assert.equal(children[1].stdin.ended, 1);
  assert.equal(engine.getStatus().running, false);
});

test("reset() during a hand-over spawns once the old child is gone", async (t) => {
  const { engine, children, spawnCalls } = setupManualExit(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;

  engine.reset();
  const second = engine.synthesize({ text: "second", ...REF_A });
  await tick(5);
  assert.equal(spawnCalls.length, 1);

  children[0].emit("exit", 0, null);
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [2, 2]);
  assertWav(await second, [2, 2]);
});

test("stop() rejects in-flight and queued requests and kills the child", async (t) => {
  const { engine, children } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  const second = engine.synthesize({ text: "second", ...REF_A });
  const stopped = { message: "Local speech stopped" };
  const rejections = Promise.all([assert.rejects(first, stopped), assert.rejects(second, stopped)]);

  engine.stop();
  await rejections;
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.deepEqual(children[0].stdin.writes, ["first\n"]);
  assert.deepEqual(engine.getStatus(), { running: false, queued: 0, busy: false });
});

test("empty text and a missing install reject without spawning", async (t) => {
  const missing = setup(t, { existsSync: (filePath) => filePath !== "/models/codec.gguf" });
  assert.equal(missing.engine.isAvailable(), false);
  await assert.rejects(missing.engine.synthesize({ text: "hello", ...REF_A }), {
    message: "Local speech is not installed",
  });
  await assert.rejects(missing.engine.synthesize({ text: " \n ", ...REF_A }), {
    message: "Speech text is required",
  });
  assert.equal(missing.spawnCalls.length, 0);

  const present = setup(t);
  assert.equal(present.engine.isAvailable(), true);
  await assert.rejects(present.engine.synthesize({ text: 42, ...REF_A }), {
    message: "Speech text is required",
  });
  assert.equal(present.spawnCalls.length, 0);
});

test("only the stderr tail is kept: 100 lines in, the last one in the message", async (t) => {
  const { engine, children } = setup(t);
  const pending = engine.synthesize({ text: "chatty", ...REF_A });
  const outcome = pending.then(
    () => assert.fail("expected a rejection"),
    (error) => error
  );

  for (let index = 0; index < 100; index += 1) emitErr(children[0], `log line ${index}\n`);
  children[0].emit("exit", 1, null);

  const error = await outcome;
  assert.equal(error.message, "Local speech process exited (1): log line 99");
  assert.ok(!error.message.includes("log line 98"));
});

const NO_AUDIO = { message: "Local speech returned no audio" };

// A setImmediate stand-in that stores callbacks so a test decides when each one runs.
function manualImmediates() {
  const pending = [];
  return {
    pending,
    impl: (callback) => pending.push(callback),
    runNext: () => pending.shift()(),
  };
}

const LONG_FIRST = `${"a".repeat(399)}.`;
const LONG_SECOND = `${"b".repeat(399)}.`;
const LONG_TEXT = `${LONG_FIRST} ${LONG_SECOND}`;

test("long text: one line per segment, the second only after the first settles, one WAV", async (t) => {
  const { engine, children, spawnCalls } = setup(t, { requestTimeoutMs: 2000 });
  const pending = engine.synthesize({ text: LONG_TEXT, ...REF_A });
  const child = children[0];
  assert.deepEqual(child.stdin.writes, [`${LONG_FIRST}\n`]);

  emitOut(child, wavChunk([1, 2]));
  await tick(20);
  assert.equal(child.stdin.writes.length, 1, "no Done line yet");
  emitDone(child);
  assert.equal(child.stdin.writes.length, 1, "the segment has not settled yet");
  await tick(30);
  assert.deepEqual(child.stdin.writes, [`${LONG_FIRST}\n`, `${LONG_SECOND}\n`]);
  assert.equal(engine.getStatus().busy, true);

  utter(child, [3, 4, 5, 6]);
  assertWav(await pending, [1, 2, 3, 4, 5, 6]);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(child.kills, []);
});

test("maxLineCodepoints sets where the engine cuts", async (t) => {
  const { engine, children } = setup(t, { maxLineCodepoints: 10 });
  const pending = engine.synthesize({ text: "one two. three four.", ...REF_A });
  utter(children[0], [1, 2]);
  await tick(30);
  assert.deepEqual(children[0].stdin.writes, ["one two.\n", "three\n"]);
  utter(children[0], [3, 4]);
  await tick(30);
  utter(children[0], [5, 6]);
  assertWav(await pending, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(children[0].stdin.writes, ["one two.\n", "three\n", "four.\n"]);
});

test("the timeout is per segment: it is re-armed when the second line is written", async (t) => {
  const { engine, children } = setup(t, { requestTimeoutMs: 150 });
  const pending = engine.synthesize({ text: LONG_TEXT, ...REF_A });
  await tick(100);
  utter(children[0], [1, 2]);
  await tick(100);
  assert.equal(children[0].stdin.writes.length, 2);
  assert.equal(engine.getStatus().busy, true, "200 ms in, past one 150 ms window");
  await assert.rejects(pending, { message: "Local speech timed out" });
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
});

test("abort during the second segment rejects and kills the child", async (t) => {
  const { engine, children } = setup(t, { requestTimeoutMs: 2000 });
  const controller = new AbortController();
  const pending = engine.synthesize({ text: LONG_TEXT, ...REF_A, signal: controller.signal });
  utter(children[0], [1, 2]);
  await tick(30);
  assert.equal(children[0].stdin.writes.length, 2);
  emitOut(children[0], wavChunk([3, 4]));

  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.equal(engine.getStatus().running, false);
});

test("blocked loop: a chunk read after the settle timer fired keeps the segment open", async (t) => {
  const immediates = manualImmediates();
  const { engine, children } = setup(t, {
    setImmediateImpl: immediates.impl,
    requestTimeoutMs: 2000,
  });
  let settled = false;
  const pending = engine.synthesize({ text: "blocked", ...REF_A });
  pending.then(
    () => (settled = true),
    () => (settled = true)
  );
  const child = children[0];
  const whole = wavChunk([1, 2, 3, 4, 5, 6]);

  emitOut(child, whole.subarray(0, 48));
  emitDone(child);
  await tick(30);
  assert.equal(immediates.pending.length, 1, "the settle timer fired and deferred to an immediate");

  // The pipe read that the blocked turn had not done yet.
  emitOut(child, whole.subarray(48));
  immediates.runNext();
  await tick(0);
  assert.equal(settled, false, "the stale immediate must not finish the segment");
  assert.equal(engine.getStatus().busy, true);

  await tick(30);
  assert.equal(immediates.pending.length, 1);
  assert.equal(settled, false);
  immediates.runNext();
  assertWav(await pending, [1, 2, 3, 4, 5, 6]);
});

test("a Done line with no stdout at all rejects and drops the child", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "silent", ...REF_A });
  emitDone(children[0]);
  await assert.rejects(first, NO_AUDIO);
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.equal(engine.getStatus().running, false);

  const second = engine.synthesize({ text: "second", ...REF_A });
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [7, 7]);
  assertWav(await second, [7, 7]);
});

test("a segment holding a second header, or an odd PCM count, rejects and kills the child", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "doubled", ...REF_A });
  emitOut(children[0], Buffer.concat([wavChunk([1, 2]), wavChunk([3, 4])]));
  emitDone(children[0]);
  await assert.rejects(first, NO_AUDIO);
  assert.deepEqual(children[0].kills, ["SIGKILL"]);

  const second = engine.synthesize({ text: "odd", ...REF_A });
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [1, 2, 3]);
  await assert.rejects(second, NO_AUDIO);
  assert.deepEqual(children[1].kills, ["SIGKILL"]);
  assert.deepEqual(engine.getStatus(), { running: false, queued: 0, busy: false });
});

test("a framing error in the second segment fails the whole request", async (t) => {
  const { engine, children } = setup(t, { requestTimeoutMs: 2000 });
  const pending = engine.synthesize({ text: LONG_TEXT, ...REF_A });
  utter(children[0], [1, 2]);
  await tick(30);
  emitOut(children[0], Buffer.from([9, 9, 9, 9]));
  emitDone(children[0]);
  await assert.rejects(pending, NO_AUDIO);
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
});

test("stdout from the active child with nothing in flight drops it", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;
  assert.deepEqual(children[0].kills, []);

  emitOut(children[0], Buffer.from([4, 4]));
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
  assert.equal(engine.getStatus().running, false);

  const second = engine.synthesize({ text: "second", ...REF_A });
  assert.equal(spawnCalls.length, 2);
  utter(children[1], [2, 2]);
  assertWav(await second, [2, 2]);
});

test("stdout from a retired child is ignored", async (t) => {
  const { engine, children } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 1]);
  await first;
  engine.reset();
  assert.equal(children[0].stdin.ended, 1);

  emitOut(children[0], Buffer.from([4, 4]));
  assert.deepEqual(children[0].kills, []);
});

for (const streamName of ["stdout", "stderr"]) {
  test(`an error on the child's ${streamName} pipe fails the request through the exit path`, async (t) => {
    const { engine, children } = setup(t);
    const pending = engine.synthesize({ text: "pipe", ...REF_A });
    const rejected = assert.rejects(pending, { message: /^Local speech process exited \(.+\): / });
    assert.doesNotThrow(() => children[0][streamName].emit("error", new Error("EIO")));
    await rejected;
    assert.deepEqual(children[0].kills, ["SIGKILL"]);
    assert.equal(engine.getStatus().running, false);
  });
}

test("a throwing onSpawn leaves the child tracked and the request served", async (t) => {
  const { engine, children, spawnCalls } = setup(t, {
    onSpawn: () => {
      throw new Error("observer broke");
    },
  });
  const pending = engine.synthesize({ text: "hello", ...REF_A });
  assert.deepEqual(engine.getStatus(), { running: true, queued: 0, busy: true });
  utter(children[0], [1, 2]);
  assertWav(await pending, [1, 2]);
  assert.equal(spawnCalls.length, 1);
});

test("a throwing onExit still rejects the in-flight request with the exit error", async (t) => {
  const { engine, children } = setup(t, {
    onExit: () => {
      throw new Error("observer broke");
    },
  });
  const pending = engine.synthesize({ text: "hello", ...REF_A });
  const rejected = assert.rejects(pending, { message: "Local speech process exited (9): " });
  assert.doesNotThrow(() => children[0].emit("exit", 9, null));
  await rejected;
  assert.equal(engine.getStatus().running, false);
});

test("a missing reference path rejects without spawning, after the text check", async (t) => {
  const { engine, spawnCalls } = setup(t, { existsSync: () => false });
  const required = { message: "Reference clip is required" };
  await assert.rejects(
    engine.synthesize({ text: "hi", referenceWavPath: "/voices/a.wav" }),
    required
  );
  await assert.rejects(
    engine.synthesize({ text: "hi", referenceTextPath: "/voices/a.txt" }),
    required
  );
  await assert.rejects(engine.synthesize({ text: "hi", ...REF_A, referenceWavPath: "" }), required);
  await assert.rejects(engine.synthesize({ text: "hi", ...REF_A, referenceTextPath: 7 }), required);
  await assert.rejects(engine.synthesize({ text: " ", referenceWavPath: "" }), {
    message: "Speech text is required",
  });
  await assert.rejects(engine.synthesize({ text: "hi", ...REF_A }), {
    message: "Local speech is not installed",
  });
  assert.equal(spawnCalls.length, 0);
});

test("maxLineCodepoints cannot be raised past the sidecar's own chunk limit", async (t) => {
  const { engine, children } = setup(t, { maxLineCodepoints: 5000 });
  const text = `${"a".repeat(499)}. ${"b".repeat(499)}.`;
  const pending = engine.synthesize({ text, ...REF_A });
  utter(children[0], [1, 2]);
  await tick(30);
  // 1001 codepoints would have gone out as one line; the sidecar would have split it.
  assert.deepEqual(children[0].stdin.writes, [`${"a".repeat(499)}.\n`, `${"b".repeat(499)}.\n`]);
  utter(children[0], [3, 4]);
  assertWav(await pending, [1, 2, 3, 4]);
});

test("a stderr line that only contains the Done marker does not end the line", async (t) => {
  const { engine, children } = setup(t);
  const pending = engine.synthesize({ text: "marker", ...REF_A });
  const child = children[0];

  emitOut(child, wavChunk([1, 2]));
  emitErr(child, `[TTS] text: say ${DONE_MARKER} twice\n`);
  await tick(30);
  assert.equal(engine.getStatus().busy, true, "an echo of the marker inside a line is ignored");

  emitOut(child, Buffer.from([3, 4]));
  emitDone(child);
  assertWav(await pending, [1, 2, 3, 4]);
});

test("an abort or a stop from inside onSpawn is honoured", async (t) => {
  const controller = new AbortController();
  const aborted = setup(t, { onSpawn: () => controller.abort() });
  await assert.rejects(
    aborted.engine.synthesize({ text: "hello", signal: controller.signal, ...REF_A }),
    { name: "AbortError" }
  );
  assert.deepEqual(aborted.children[0].stdin.writes, [], "nothing was written for it");
  assert.deepEqual(aborted.children[0].kills, ["SIGKILL"]);

  // The callback closes over the engine it stops.
  const stopped = setup(t, { onSpawn: () => stopped.engine.stop() });
  await assert.rejects(stopped.engine.synthesize({ text: "hello", ...REF_A }), {
    message: "Local speech stopped",
  });
  assert.deepEqual(stopped.children[0].stdin.writes, []);
  assert.deepEqual(stopped.children[0].kills, ["SIGKILL"]);
  assert.deepEqual(stopped.engine.getStatus(), { running: false, queued: 0, busy: false });
});

test("an error event on a started child kills it and its exit settles the request", async (t) => {
  const { engine, children } = setup(t);
  const pending = engine.synthesize({ text: "first", ...REF_A });
  const rejected = assert.rejects(pending, { message: "Local speech process exited (SIGKILL): " });
  children[0].pid = 4242;
  children[0].emit("error", new Error("kill EPERM"));
  await rejected;
  assert.deepEqual(children[0].kills, ["SIGKILL"]);
});

test("a request after stop() is refused and spawns nothing", async (t) => {
  const { engine, children, spawnCalls } = setup(t);
  const first = engine.synthesize({ text: "first", ...REF_A });
  utter(children[0], [1, 2]);
  await first;

  engine.stop();
  engine.stop();
  await assert.rejects(engine.synthesize({ text: "late", ...REF_A }), {
    message: "Local speech stopped",
  });
  engine.reset();
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(engine.getStatus(), { running: false, queued: 0, busy: false });
});

test("a stopped engine reports unavailable", (t) => {
  const { engine } = setup(t);
  assert.equal(engine.isAvailable(), true);
  engine.stop();
  assert.equal(engine.isAvailable(), false);
});
