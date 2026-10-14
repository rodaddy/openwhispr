const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/grillVoiceLoop.ts");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Fake deps: every speak/listen/transcribe call waits on a deferred the test settles.
function harness(overrides = {}) {
  const log = [];
  const pending = { speak: [], listen: [], transcribe: [] };
  const aborted = [];
  const deps = {
    stillThereText: "Still there?",
    speak: (text, signal) => {
      log.push(["speak", text]);
      const d = deferred();
      signal.addEventListener("abort", () => {
        aborted.push(["speak", text]);
        d.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      pending.speak.push(d);
      return d.promise;
    },
    listen: (signal) => {
      log.push(["listen"]);
      const d = deferred();
      signal.addEventListener("abort", () => {
        aborted.push(["listen"]);
        d.resolve({ kind: "aborted" });
      });
      pending.listen.push(d);
      return d.promise;
    },
    transcribe: (audio) => {
      log.push(["transcribe", audio]);
      const d = deferred();
      pending.transcribe.push(d);
      return d.promise;
    },
    sendAnswer: (text) => log.push(["send", text]),
    requestNextQuestion: () => log.push(["skip"]),
    endSession: () => log.push(["end"]),
    notice: (kind, detail) => log.push(["notice", kind, detail]),
    ...overrides,
  };
  return { deps, log, pending, aborted };
}

test("speak, listen, transcribe, send, then the next question", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const phases = [];
  const loop = createGrillVoiceLoop({ ...h.deps, onChange: (s) => phases.push(s.phase) });

  loop.question("What surprised you today?");
  assert.equal(loop.state().phase, "speaking");
  h.pending.speak[0].resolve();
  await tick();
  assert.equal(loop.state().phase, "listening");
  h.pending.listen[0].resolve({ kind: "answer", audio: "take-1" });
  await tick();
  assert.equal(loop.state().phase, "transcribing");
  h.pending.transcribe[0].resolve({ ok: true, text: " The pricing call. " });
  await tick();
  assert.equal(loop.state().phase, "thinking");

  loop.question("Who was on it?");
  h.pending.speak[1].resolve();
  await tick();
  assert.equal(loop.state().phase, "listening");

  assert.deepEqual(h.log.slice(0, 5), [
    ["speak", "What surprised you today?"],
    ["listen"],
    ["transcribe", "take-1"],
    ["send", "The pricing call."],
    ["speak", "Who was on it?"],
  ]);
  assert.deepEqual(phases.slice(0, 4), ["speaking", "listening", "transcribing", "thinking"]);
});

test("pause stops speaking or listening; resume re-asks an unspoken question or listens again", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);

  loop.question("Q1");
  loop.pause();
  await tick();
  assert.equal(loop.state().phase, "paused");
  assert.equal(loop.state().paused, true);
  assert.deepEqual(h.aborted, [["speak", "Q1"]]);

  loop.resume();
  assert.equal(loop.state().phase, "speaking");
  h.pending.speak[1].resolve();
  await tick();
  assert.equal(loop.state().phase, "listening");

  loop.pause();
  await tick();
  assert.equal(loop.state().phase, "paused");
  loop.resume();
  await tick();
  // Already spoken: resume goes straight back to listening, no second reading.
  assert.equal(loop.state().phase, "listening");
  assert.equal(h.log.filter((e) => e[0] === "speak").length, 2);
});

test("pausing while an answer transcribes never drops it; the next question waits for resume", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "answer", audio: "take" });
  await tick();
  loop.pause();
  h.pending.transcribe[0].resolve({ ok: true, text: "An answer" });
  await tick();
  assert.ok(h.log.some((e) => e[0] === "send" && e[1] === "An answer"));

  loop.question("Q2");
  assert.equal(loop.state().phase, "paused");
  assert.equal(h.log.filter((e) => e[0] === "speak").length, 1);
  loop.resume();
  assert.equal(loop.state().phase, "speaking");
  assert.deepEqual(h.log.at(-1), ["speak", "Q2"]);
});

test("skip stops listening and asks the interviewer for the next question", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  loop.skip();
  await tick();
  assert.deepEqual(h.aborted, [["listen"]]);
  assert.equal(loop.state().phase, "thinking");
  assert.deepEqual(h.log.at(-1), ["skip"]);
  assert.equal(h.log.filter((e) => e[0] === "transcribe").length, 0);
});

test("mute skips speech and goes straight to listening; muting mid-question stops the voice", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  loop.setMuted(true);
  await tick();
  assert.deepEqual(h.aborted, [["speak", "Q1"]]);
  assert.equal(loop.state().phase, "listening");
  assert.equal(loop.state().muted, true);

  h.pending.listen[0].resolve({ kind: "answer", audio: "a" });
  await tick();
  h.pending.transcribe[0].resolve({ ok: true, text: "x" });
  await tick();
  loop.question("Q2");
  await tick();
  assert.equal(loop.state().phase, "listening");
  assert.equal(h.log.filter((e) => e[0] === "speak").length, 1);
});

test("push-to-talk turns auto-listen off; turning it back on listens again", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  loop.setPushToTalk(true);
  await tick();
  assert.deepEqual(h.aborted, [["listen"]]);
  assert.equal(loop.state().phase, "waiting");

  loop.answeredByText();
  assert.equal(loop.state().phase, "thinking");
  loop.question("Q2");
  h.pending.speak[1].resolve();
  await tick();
  assert.equal(loop.state().phase, "waiting");
  assert.equal(h.log.filter((e) => e[0] === "listen").length, 1);

  loop.setPushToTalk(false);
  await tick();
  assert.equal(loop.state().phase, "listening");
});

test("a TTS failure shows the question as text and keeps listening", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].reject(new Error("Speech service failed (502)"));
  await tick();
  assert.equal(loop.state().phase, "listening");
  assert.ok(h.log.some((e) => e[0] === "notice" && e[1] === "speech-failed" && /502/.test(e[2])));
});

test("a transcription failure says so, keeps the take, and can be retried", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "answer", audio: { blob: "b" } });
  await tick();
  h.pending.transcribe[0].resolve({
    ok: false,
    error: "whisper crashed",
    retry: { path: "/tmp-audio/take.webm" },
  });
  await tick();
  assert.equal(loop.state().phase, "failed");
  assert.equal(loop.state().error, "whisper crashed");
  assert.ok(h.log.some((e) => e[0] === "notice" && e[1] === "transcription-failed"));
  assert.equal(h.log.filter((e) => e[0] === "send").length, 0);

  loop.retry();
  assert.equal(loop.state().phase, "transcribing");
  assert.deepEqual(h.log.at(-1), ["transcribe", { path: "/tmp-audio/take.webm" }]);
  h.pending.transcribe[1].resolve({ ok: true, text: "Recovered" });
  await tick();
  assert.deepEqual(h.log.at(-1), ["send", "Recovered"]);
  assert.equal(loop.state().error, null);
});

test("a take with no recognized words is a failure, not a silent drop", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "answer", audio: "take" });
  await tick();
  h.pending.transcribe[0].resolve({ ok: true, text: "   " });
  await tick();
  assert.equal(loop.state().phase, "failed");
  loop.retry();
  assert.deepEqual(h.log.at(-1), ["transcribe", "take"]);
});

test("typing an answer after a failed take clears the failure", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "answer", audio: "take" });
  await tick();
  h.pending.transcribe[0].resolve({ ok: false, error: "boom", retry: "take" });
  await tick();
  loop.answeredByText();
  assert.equal(loop.state().phase, "thinking");
  assert.equal(loop.state().error, null);
});

test("no speech within the window asks 'Still there?' once and pauses", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "no-speech" });
  await tick();
  assert.equal(loop.state().phase, "paused");
  assert.equal(loop.state().paused, true);
  assert.deepEqual(h.log.slice(-2), [
    ["notice", "still-there", undefined],
    ["speak", "Still there?"],
  ]);
  h.pending.speak[1].resolve();
  await tick();
  // It does not listen again on its own.
  assert.equal(h.log.filter((e) => e[0] === "listen").length, 1);
  loop.resume();
  await tick();
  assert.equal(loop.state().phase, "listening");
});

test("end stops everything and uses the session's save", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  loop.end();
  await tick();
  assert.equal(loop.state().phase, "ended");
  assert.deepEqual(h.aborted, [["listen"]]);
  assert.deepEqual(h.log.at(-1), ["end"]);
  loop.question("late question");
  assert.equal(loop.state().phase, "ended");
});

test("a new question while listening replaces the old turn", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  loop.question("Q2");
  await tick();
  assert.deepEqual(h.aborted, [["listen"]]);
  assert.equal(loop.state().phase, "speaking");
});

test("a mic that cannot open says so and falls back to typing, without an unhandled rejection", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness({
    listen: async () => {
      throw new Error("Permission denied");
    },
  });
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  assert.equal(loop.state().phase, "waiting");
  assert.ok(
    h.log.some((e) => e[0] === "notice" && e[1] === "listen-failed" && /Permission/.test(e[2]))
  );
});

// --- G2c-fix: pause keeps the take, skip drops it ----------------------------

test("pause while listening ends the take: it is transcribed and sent, then the next question waits", async () => {
  const { createGrillVoiceLoop, GRILL_FINISH_TAKE } = await load();
  assert.ok(GRILL_FINISH_TAKE, "the loop exports its finish-the-take abort reason");
  const h = harness();
  h.deps.listen = (signal) => {
    h.log.push(["listen"]);
    const d = deferred();
    signal.addEventListener("abort", () =>
      d.resolve(
        signal.reason === GRILL_FINISH_TAKE
          ? { kind: "answer", audio: "partial-take" }
          : { kind: "aborted" }
      )
    );
    h.pending.listen.push(d);
    return d.promise;
  };
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  assert.equal(loop.state().phase, "listening");

  loop.pause();
  await tick();
  assert.equal(loop.state().paused, true);
  assert.deepEqual(h.log.at(-1), ["transcribe", "partial-take"]);
  h.pending.transcribe[0].resolve({ ok: true, text: "What I said so far" });
  await tick();
  assert.ok(h.log.some((e) => e[0] === "send" && e[1] === "What I said so far"));

  // The interviewer's reply does not start speaking while paused.
  loop.question("Q2");
  assert.equal(loop.state().phase, "paused");
  assert.equal(h.log.filter((e) => e[0] === "speak").length, 1);
});

test("skip while listening still discards the take and says 'Answer skipped'", async () => {
  const { createGrillVoiceLoop, GRILL_FINISH_TAKE } = await load();
  const h = harness();
  const reasons = [];
  h.deps.listen = (signal) => {
    h.log.push(["listen"]);
    const d = deferred();
    signal.addEventListener("abort", () => {
      reasons.push(signal.reason === GRILL_FINISH_TAKE ? "finish" : "abort");
      d.resolve({ kind: "aborted" });
    });
    h.pending.listen.push(d);
    return d.promise;
  };
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  h.pending.speak[0].resolve();
  await tick();
  loop.skip();
  await tick();
  assert.deepEqual(reasons, ["abort"]);
  assert.equal(h.log.filter((e) => e[0] === "transcribe").length, 0);
  assert.ok(h.log.some((e) => e[0] === "notice" && e[1] === "answer-skipped"));
  assert.deepEqual(h.log.at(-1), ["skip"]);
});

test("skip while speaking asks for the next question without an 'Answer skipped' notice", async () => {
  const { createGrillVoiceLoop } = await load();
  const h = harness();
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("Q1");
  loop.skip();
  await tick();
  assert.equal(h.log.filter((e) => e[0] === "notice").length, 0);
});

// --- G2c-fix: End or unmount while an answer transcribes ---------------------

const loadSession = () => import("../../src/services/grill/grillSession.ts");

function notesApi({ failSave = false } = {}) {
  const calls = [];
  const api = {
    getSpaces: async () => [{ id: 1, kind: "private", name: "Personal" }],
    getFolders: async () => [{ id: 4, name: "Grill", is_default: 0, space_id: 1 }],
    createFolder: async (name) => ({ success: true, folder: { id: 9, name, is_default: 0 } }),
    saveNote: async (...args) => {
      calls.push(["saveNote", ...args]);
      return failSave
        ? { success: false, error: "disk full" }
        : { success: true, note: { id: 42 } };
    },
    updateNote: async (...args) => {
      calls.push(["updateNote", ...args]);
      return { success: true, note: { id: 42 } };
    },
  };
  return { api, calls };
}

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

async function grillWithLoop({ failSave = false, answerWaitMs } = {}) {
  const { createGrillVoiceLoop } = await load();
  const { createGrillController, planGrillSession, GRILL_DRAFT_KEY } = await loadSession();
  const { api, calls } = notesApi({ failSave });
  const storage = memoryStorage();
  const messages = [
    { id: "1", role: "assistant", content: "Who was on the call?", isStreaming: false },
    { id: "2", role: "user", content: "Their CFO.", isStreaming: false },
    { id: "3", role: "assistant", content: "What surprised you?", isStreaming: false },
  ];
  const controller = createGrillController({
    api,
    notify: { saved: () => {}, savedWithoutTurns: () => {}, failed: () => {} },
    storage,
    getMessages: () => messages,
    onSessionChange: () => {},
  });
  const plan = planGrillSession(
    { kind: "daily" },
    { now: new Date(2026, 8, 26, 10), events: [], meetingNotes: [] }
  );
  controller.begin(plan, 77, messages);
  const saves = [];
  const h = harness({
    endSession: () => saves.push(controller.exit()),
    holdAnswer: (answer) => controller.holdAnswer(answer),
    ...(answerWaitMs !== undefined ? { answerWaitMs } : {}),
  });
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("What surprised you?");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "answer", audio: "take" });
  await tick();
  assert.equal(loop.state().phase, "transcribing");
  return { loop, h, controller, calls, storage, saves, GRILL_DRAFT_KEY };
}

const savedText = (calls) =>
  calls
    .filter((c) => c[0] === "saveNote" || c[0] === "updateNote")
    .map((c) => JSON.stringify(c))
    .join("\n");

test("End while an answer is transcribing waits for it; the answer is in the saved turns", async () => {
  const { loop, h, calls, saves } = await grillWithLoop();
  loop.end();
  await tick();
  assert.equal(loop.state().phase, "ended");
  assert.equal(calls.length, 0, "the save waits for the answer");
  h.pending.transcribe[0].resolve({ ok: true, text: "The pricing call, honestly." });
  const result = await saves[0];
  assert.equal(result.success, true);
  assert.match(savedText(calls), /The pricing call, honestly\./);
  // Ended: the answer is saved, not sent to the interviewer.
  assert.equal(h.log.filter((e) => e[0] === "send").length, 0);
});

test("unmount while an answer is transcribing puts the answer into the local grill draft", async () => {
  const { loop, h, controller, storage, GRILL_DRAFT_KEY } = await grillWithLoop({ failSave: true });
  loop.dispose();
  const unmount = controller.unmount();
  h.pending.transcribe[0].resolve({ ok: true, text: "Said just before closing." });
  await unmount;
  const draft = JSON.parse(storage.getItem(GRILL_DRAFT_KEY));
  assert.ok(
    draft.messages.some((m) => m.role === "user" && m.content === "Said just before closing."),
    "the answer is in the draft"
  );
});

test("End waits at most the answer window for a transcription that never finishes", async () => {
  const { loop, calls, saves } = await grillWithLoop({ answerWaitMs: 20 });
  loop.end();
  await tick();
  const result = await saves[0];
  assert.equal(result.success, true);
  assert.ok(calls.some((c) => c[0] === "saveNote"));
});

test("the answer window defaults to 30 seconds", async () => {
  const { GRILL_ANSWER_WAIT_MS } = await load();
  assert.equal(GRILL_ANSWER_WAIT_MS, 30_000);
});

// --- G2c-fix2: a take closing at End, and a take that fails after End --------

// A grill whose loop is listening; the mic's take closes only when the test
// resolves it (MediaRecorder onstop comes later than the abort).
async function grillListening({ answerWaitMs } = {}) {
  const { createGrillVoiceLoop } = await load();
  const { createGrillController, planGrillSession } = await loadSession();
  const { api, calls } = notesApi();
  const messages = [
    { id: "1", role: "assistant", content: "What surprised you?", isStreaming: false },
  ];
  const controller = createGrillController({
    api,
    notify: { saved: () => {}, savedWithoutTurns: () => {}, failed: () => {} },
    storage: memoryStorage(),
    getMessages: () => messages,
    onSessionChange: () => {},
  });
  controller.begin(
    planGrillSession(
      { kind: "daily" },
      { now: new Date(2026, 8, 26, 10), events: [], meetingNotes: [] }
    ),
    77,
    messages
  );
  const saves = [];
  const h = harness({
    endSession: () => saves.push(controller.exit()),
    holdAnswer: (answer) => controller.holdAnswer(answer),
    ...(answerWaitMs !== undefined ? { answerWaitMs } : {}),
  });
  h.deps.listen = (signal) => {
    h.log.push(["listen"]);
    const d = deferred();
    d.signal = signal;
    h.pending.listen.push(d);
    return d.promise;
  };
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("What surprised you?");
  h.pending.speak[0].resolve();
  await tick();
  assert.equal(loop.state().phase, "listening");
  return { loop, h, calls, saves };
}

test("Pause, then End before the take closes: the answer is in the saved turns", async () => {
  const { GRILL_FINISH_TAKE } = await load();
  const { loop, h, calls, saves } = await grillListening();
  loop.pause();
  assert.equal(h.pending.listen[0].signal.reason, GRILL_FINISH_TAKE);
  loop.end();
  await tick();
  assert.equal(saves.length, 1);
  // The take closes after End; the save must still be waiting for it.
  h.pending.listen[0].resolve({ kind: "answer", audio: "closing-take" });
  await tick();
  assert.equal(calls.length, 0, "the save waits for the closing take");
  h.pending.transcribe[0].resolve({ ok: true, text: "Said while pausing." });
  const result = await saves[0];
  assert.equal(result.success, true);
  assert.match(savedText(calls), /Said while pausing\./);
  assert.equal(h.log.filter((e) => e[0] === "send").length, 0);
});

test("a closing take with no answer releases End at once, not after the answer window", async () => {
  const { loop, h, saves } = await grillListening({ answerWaitMs: 60_000 });
  loop.pause();
  loop.end();
  await tick();
  h.pending.listen[0].resolve({ kind: "no-speech" });
  const settled = await Promise.race([
    saves[0].then(() => "saved"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
  ]);
  assert.equal(settled, "saved");
});

test("End during transcription, then the transcription fails: the note says so and the audio is kept", async () => {
  const { loop, h, calls, saves } = await grillWithLoop();
  loop.end();
  await tick();
  h.pending.transcribe[0].resolve({
    ok: false,
    error: "model crashed",
    retry: "take",
    audioPath: "/tmp-audio/grill-take-1.webm",
  });
  const result = await saves[0];
  assert.equal(result.success, true);
  assert.match(
    savedText(calls),
    /\(An answer could not be transcribed; audio kept at \/tmp-audio\/grill-take-1\.webm\)/
  );
  assert.ok(
    h.log.some(
      (e) => e[0] === "notice" && e[1] === "answer-lost" && e[2] === "/tmp-audio/grill-take-1.webm"
    ),
    "a toast-level notice names the kept audio"
  );
});

test("unmount during transcription, then it fails: the draft keeps the line", async () => {
  const { loop, h, controller, storage, GRILL_DRAFT_KEY } = await grillWithLoop({ failSave: true });
  loop.dispose();
  const unmount = controller.unmount();
  h.pending.transcribe[0].resolve({ ok: false, error: "x", audioPath: "/a/take.webm" });
  await unmount;
  const draft = JSON.parse(storage.getItem(GRILL_DRAFT_KEY));
  assert.ok(
    draft.messages.some(
      (m) => m.content === "(An answer could not be transcribed; audio kept at /a/take.webm)"
    )
  );
  assert.ok(h.log.some((e) => e[0] === "notice" && e[1] === "answer-lost"));
});

// --- G2c-fix3: the answer window runs out while a take transcribes -----------

const loadHook = () => import("../../src/components/chat/useGrillVoiceLoop.ts");

test("temp audio is deleted only after a transcription that succeeded and was not orphaned", async () => {
  const { shouldDeleteTempAudio } = await loadHook();
  assert.equal(shouldDeleteTempAudio({ ok: true, orphaned: false }), true);
  assert.equal(shouldDeleteTempAudio({ ok: true, orphaned: true }), false);
  assert.equal(shouldDeleteTempAudio({ ok: false, orphaned: false }), false);
  assert.equal(shouldDeleteTempAudio({ ok: false, orphaned: true }), false);
});

test("the still-transcribing line reads the kept audio path, or points at the log", async () => {
  const { grillOrphanedAnswerLine } = await load();
  assert.equal(
    grillOrphanedAnswerLine("/a/take.webm"),
    "(An answer was still transcribing when the grill ended; audio kept at /a/take.webm)"
  );
  assert.equal(
    grillOrphanedAnswerLine(),
    "(An answer was still being saved when the grill ended; its audio path will be in the log)"
  );
});

// The loop over the hook's real take transcriber, with fake file and model IO.
// saveAudio: a deferred the test settles in place of the temp-audio save.
async function grillTimingOut({ saved = true, saveAudio = null } = {}) {
  const { createGrillVoiceLoop } = await load();
  const { transcribeGrillTake } = await loadHook();
  const { createGrillController, planGrillSession } = await loadSession();
  const { api, calls } = notesApi();
  const messages = [
    { id: "1", role: "assistant", content: "What surprised you?", isStreaming: false },
  ];
  const logs = [];
  const controller = createGrillController({
    api,
    notify: { saved: () => {}, savedWithoutTurns: () => {}, failed: () => {} },
    storage: memoryStorage(),
    getMessages: () => messages,
    onSessionChange: () => {},
    log: (message, meta) => logs.push([message, meta]),
  });
  controller.begin(
    planGrillSession(
      { kind: "daily" },
      { now: new Date(2026, 8, 26, 10), events: [], meetingNotes: [] }
    ),
    77,
    messages
  );
  const deleted = [];
  const model = deferred();
  const io = {
    saveTempAudio: () =>
      saveAudio
        ? saveAudio.promise
        : saved
          ? Promise.resolve({ success: true, path: "/tmp-audio/grill-take-9.webm" })
          : new Promise(() => {}),
    deleteTempAudio: async (path) => deleted.push(path),
    transcribeFile: () => model.promise,
  };
  const saves = [];
  const h = harness({
    endSession: () => saves.push(controller.exit()),
    holdAnswer: (answer) => controller.holdAnswer(answer),
    lateAnswer: (...args) => controller.lateAnswer(...args),
    transcribe: (take, ctx) => transcribeGrillTake(take, ctx, io),
    answerWaitMs: 20,
  });
  const loop = createGrillVoiceLoop(h.deps);
  loop.question("What surprised you?");
  h.pending.speak[0].resolve();
  await tick();
  h.pending.listen[0].resolve({ kind: "answer", audio: { blob: new Blob(["pcm"]) } });
  await tick();
  assert.equal(loop.state().phase, "transcribing");
  return { loop, h, calls, saves, deleted, model, logs };
}

test("End, then the answer window runs out mid-transcription: the note says so and the audio is kept", async () => {
  const { loop, h, calls, saves, deleted, model, logs } = await grillTimingOut();
  loop.end();
  await tick();
  const result = await saves[0];
  assert.equal(result.success, true);
  assert.match(
    savedText(calls),
    /\(An answer was still transcribing when the grill ended; audio kept at \/tmp-audio\/grill-take-9\.webm\)/
  );
  assert.ok(
    h.log.some(
      (e) => e[0] === "notice" && e[1] === "answer-lost" && e[2] === "/tmp-audio/grill-take-9.webm"
    ),
    "the answer-lost notice names the kept audio"
  );
  // The orphaned take then succeeds: its audio is not deleted, and its text is
  // logged by note id and length only.
  model.resolve({ success: true, text: "Late but real words." });
  await tick();
  await tick();
  assert.deepEqual(deleted, [], "the orphaned take's audio is kept");
  assert.equal(h.log.filter((e) => e[0] === "send").length, 0);
  assert.ok(!savedText(calls).includes("Late but real words."));
  const late = logs.find((l) => l[1] && l[1].noteId === 42);
  assert.ok(late, "the late answer is logged against the saved note");
  assert.deepEqual(late[1], { noteId: 42, chars: "Late but real words.".length });
  assert.ok(!JSON.stringify(logs).includes("Late but real words."), "the text is never logged");
});

test("the answer window runs out before the take was saved: the note says its path will be in the log", async () => {
  const { loop, calls, saves } = await grillTimingOut({ saved: false });
  loop.end();
  await tick();
  await saves[0];
  assert.match(
    savedText(calls),
    /\(An answer was still being saved when the grill ended; its audio path will be in the log\)/
  );
  assert.ok(!savedText(calls).includes("no audio was kept"));
});

test("a take that is not orphaned still deletes its temp audio on success", async () => {
  const { loop, deleted, model } = await grillTimingOut();
  model.resolve({ success: true, text: "On time." });
  await tick();
  await tick();
  assert.deepEqual(deleted, ["/tmp-audio/grill-take-9.webm"]);
  assert.equal(loop.state().phase, "thinking");
});

// An orphaned take whose audio was still being saved when the note was written.
async function orphanedBeforeSave() {
  const saveAudio = deferred();
  const run = await grillTimingOut({ saveAudio });
  run.loop.end();
  await tick();
  await run.saves[0];
  assert.match(
    savedText(run.calls),
    /\(An answer was still being saved when the grill ended; its audio path will be in the log\)/
  );
  return { ...run, saveAudio };
}

const settleLate = async () => {
  for (let i = 0; i < 6; i++) await tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 6; i++) await tick();
};

test("a take orphaned before its audio was saved keeps the audio and logs its path, never its text", async () => {
  const { saveAudio, model, deleted, logs } = await orphanedBeforeSave();
  saveAudio.resolve({ success: true, path: "/tmp-audio/late-saved.webm" });
  await tick();
  model.resolve({ success: true, text: "late words" });
  await settleLate();
  assert.deepEqual(deleted, [], "the orphaned take's audio is kept");
  const late = logs.find((l) => l[1] && l[1].audioPath === "/tmp-audio/late-saved.webm");
  assert.ok(late, "the kept audio path is logged");
  assert.deepEqual(late[1], {
    noteId: 42,
    audioPath: "/tmp-audio/late-saved.webm",
    chars: "late words".length,
  });
  assert.ok(!JSON.stringify(logs).includes("late words"), "the text is never logged");
});

test("a take orphaned before its audio was saved logs the path with chars 0 when transcription fails", async () => {
  const { saveAudio, model, deleted, logs } = await orphanedBeforeSave();
  saveAudio.resolve({ success: true, path: "/tmp-audio/late-saved.webm" });
  await tick();
  model.resolve({ success: false, error: "model down" });
  await settleLate();
  assert.deepEqual(deleted, []);
  const late = logs.find((l) => l[1] && "audioPath" in l[1]);
  assert.ok(late, "the kept audio path is logged");
  assert.deepEqual(late[1], { noteId: 42, audioPath: "/tmp-audio/late-saved.webm", chars: 0 });
});

test("a take orphaned before its audio was saved logs audio not saved when the save fails", async () => {
  const { saveAudio, model, logs } = await orphanedBeforeSave();
  saveAudio.reject(new Error("disk full"));
  model.resolve({ success: true, text: "never used" });
  await settleLate();
  const late = logs.find((l) => l[1] && "audioPath" in l[1]);
  assert.ok(late, "the lost audio is logged");
  assert.deepEqual(late[1], { noteId: 42, audioPath: null, chars: 0, error: "audio not saved" });
});

// Grill A saves note 42; grill B's save fails. B's late answer must not
// borrow A's note id.
async function twoGrills() {
  const { createGrillController, planGrillSession } = await loadSession();
  let saves = 0;
  const api = {
    ...notesApi().api,
    saveNote: async () =>
      saves++ === 0 ? { success: true, note: { id: 42 } } : { success: false, error: "disk full" },
  };
  const messages = [
    { id: "1", role: "assistant", content: "What surprised you?", isStreaming: false },
    { id: "2", role: "user", content: "The price.", isStreaming: false },
  ];
  const logs = [];
  const controller = createGrillController({
    api,
    notify: { saved: () => {}, savedWithoutTurns: () => {}, failed: () => {} },
    storage: memoryStorage(),
    getMessages: () => messages,
    onSessionChange: () => {},
    log: (message, meta) => logs.push([message, meta]),
  });
  const plan = planGrillSession(
    { kind: "daily" },
    { now: new Date(2026, 8, 26, 10), events: [], meetingNotes: [] }
  );
  controller.begin(plan, 1, messages);
  const a = await controller.exit();
  assert.equal(a.success, true);
  assert.equal(a.id, 42);
  controller.begin(plan, 2, messages);
  return { controller, logs };
}

test("a late answer after a later grill's failed save logs noteId null, not the earlier note", async () => {
  const { controller, logs } = await twoGrills();
  const b = await controller.exit();
  assert.equal(b.success, false);
  await controller.lateAnswer("late");
  assert.deepEqual(logs.at(-1)[1], { noteId: null, chars: 4 });
});

test("a late answer in a new grill before it saves logs noteId null", async () => {
  const { controller, logs } = await twoGrills();
  await controller.lateAnswer("late");
  assert.deepEqual(logs.at(-1)[1], { noteId: null, chars: 4 });
});

test("a take overlapping a global-hotkey dictation is never a grill answer", async () => {
  const { createGrillVoiceLoop } = await load();
  const dictation = { active: false, count: 0 };
  const h = harness({ dictation: () => ({ ...dictation }) });
  const loop = createGrillVoiceLoop({ ...h.deps, onChange: () => {} });

  loop.question("What surprised you today?");
  h.pending.speak[0].resolve();
  await tick();
  assert.equal(loop.state().phase, "listening");
  // Rico presses the dictation hotkey for another app while the grill listens.
  dictation.active = true;
  dictation.count += 1;
  dictation.active = false;
  h.pending.listen[0].resolve({ kind: "answer", audio: "message-to-claude" });
  await tick();
  assert.equal(
    h.log.some(([kind]) => kind === "transcribe" || kind === "send"),
    false
  );
  // The grill keeps listening for its own answer.
  assert.equal(loop.state().phase, "listening");
  assert.equal(h.pending.listen.length, 2);

  h.pending.listen[1].resolve({ kind: "answer", audio: "own-answer" });
  await tick();
  assert.deepEqual(
    h.log.filter(([kind]) => kind === "transcribe"),
    [["transcribe", "own-answer"]]
  );
});
