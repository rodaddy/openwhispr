const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGrillSessionPayload,
  createPipelineConnector,
  PipelineError,
} = require("../../src/helpers/pipelineConnector.js");

const TOKEN = "smp-bearer-token-do-not-leak";
const BASE = "https://smp.example.test";

const TURNS = [
  { role: "assistant", text: "What surprised you yesterday?", source: "system" },
  { role: "user", text: "Honestly the gate bug.", source: "mic" },
  {
    role: "assistant",
    text: "OpenAI News says X. Agree or disagree?",
    source: "system",
    question_id: "fq-1",
  },
  { role: "user", text: "Disagree, clients miss the cost.", source: "mic" },
];

const META = {
  kind: "daily",
  chapter: null,
  startedAt: "2026-09-27T14:00:05.000Z",
  endedAt: "2026-09-27T14:13:40.000Z",
};

function grillNote(overrides = {}) {
  return {
    id: 42,
    title: "Grill 2026-09-27",
    created_at: "2026-09-27 14:13:41",
    updated_at: "2026-09-27 14:13:42",
    transcript: JSON.stringify(TURNS),
    grill_meta: JSON.stringify(META),
    ...overrides,
  };
}

function makeStore({ token = TOKEN, baseUrl = BASE, notes, pending } = {}) {
  let settings = { baseUrl };
  let secret = token;
  const noteMap = new Map((notes || [grillNote()]).map((n) => [n.id, n]));
  const states = new Map();
  const metas = new Map();
  return {
    async getSettings() {
      return settings;
    },
    async saveSettings(value) {
      settings = value;
    },
    async getToken() {
      return secret;
    },
    async saveToken(value) {
      secret = value;
    },
    async getNote(id) {
      const note = noteMap.get(Number(id));
      if (!note) return null;
      return metas.has(Number(id))
        ? { ...note, grill_meta: JSON.stringify(metas.get(Number(id))) }
        : note;
    },
    async saveGrillMeta(id, meta) {
      metas.set(Number(id), meta);
      const prior = states.get(Number(id));
      if (prior) states.set(Number(id), { ...prior, notSendable: false });
    },
    async saveSyncState(id, state) {
      states.set(Number(id), { ...(states.get(Number(id)) || {}), ...state });
    },
    async getSyncState(id) {
      return states.get(Number(id)) || null;
    },
    async listPendingNoteIds() {
      return (
        pending ||
        [...noteMap.keys()].filter(
          (id) => !states.get(id)?.syncedAt && !states.get(id)?.notSendable
        )
      );
    },
    states,
    metas,
    noteMap,
    get settings() {
      return settings;
    },
    get token() {
      return secret;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}

function recordingLog() {
  const lines = [];
  const write =
    (level) =>
    (...args) =>
      lines.push([level, ...args]);
  return {
    lines,
    log: { info: write("info"), warn: write("warn"), error: write("error"), debug: write("debug") },
    text: () => JSON.stringify(lines),
  };
}

const okSession = (call) =>
  jsonResponse({ ok: true, note_id: call.body.note_id, pieces_added: 3, pieces_rejected: 1 });

test("the session post matches the grill contract field for field", () => {
  const payload = buildGrillSessionPayload(grillNote());
  assert.deepEqual(payload, {
    note_id: "whisper-42",
    session_kind: "daily",
    chapter: null,
    title: "Grill 2026-09-27",
    started_at: "2026-09-27T14:00:05.000Z",
    ended_at: "2026-09-27T14:13:40.000Z",
    turns: [
      { role: "interviewer", text: "What surprised you yesterday?", question_id: null },
      { role: "rico", text: "Honestly the gate bug.", question_id: null },
      { role: "interviewer", text: "OpenAI News says X. Agree or disagree?", question_id: "fq-1" },
      { role: "rico", text: "Disagree, clients miss the cost.", question_id: null },
    ],
  });
});

test("a lifetime session carries its chapter; a session of only feed questions is 'feed'", () => {
  const lifetime = buildGrillSessionPayload(
    grillNote({
      title: "Life Story ch 3: School",
      grill_meta: JSON.stringify({ ...META, kind: "lifetime", chapter: 3 }),
    })
  );
  assert.equal(lifetime.session_kind, "lifetime");
  assert.equal(lifetime.chapter, 3);

  const feedOnly = buildGrillSessionPayload(
    grillNote({ transcript: JSON.stringify(TURNS.slice(2)) })
  );
  assert.equal(feedOnly.session_kind, "feed");
  assert.equal(feedOnly.chapter, null);
});

test("a grill note saved before the connector existed is derived from its title and timestamps", () => {
  const payload = buildGrillSessionPayload(grillNote({ grill_meta: null }));
  assert.equal(payload.session_kind, "daily");
  assert.equal(payload.started_at, "2026-09-27T14:13:41.000Z");
  assert.equal(payload.ended_at, "2026-09-27T14:13:42.000Z");
  const chapter = buildGrillSessionPayload(
    grillNote({ grill_meta: null, title: "Life Story ch 7: Why it matters" })
  );
  assert.equal(chapter.session_kind, "lifetime");
  assert.equal(chapter.chapter, 7);
});

test("a note without role-tagged turns is not a grill session", () => {
  assert.throws(
    () => buildGrillSessionPayload(grillNote({ transcript: "plain text" })),
    (error) => error instanceof PipelineError && error.code === "NO_TURNS"
  );
});

test("sending posts to /internal/grill/sessions with the bearer header and stores the sync state", async () => {
  const store = makeStore();
  const { calls, fetchImpl } = recordingFetch(okSession);
  const connector = createPipelineConnector({
    store,
    fetchImpl,
    now: () => new Date("2026-09-27T15:00:00.000Z"),
  });
  const result = await connector.sendNote(42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/internal/grill/sessions`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers.get("content-type"), "application/json");
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[0].body.note_id, "whisper-42");
  assert.deepEqual(result, {
    syncedAt: "2026-09-27T15:00:00.000Z",
    lastError: null,
    piecesAdded: 3,
    notSendable: false,
  });
  assert.deepEqual(store.states.get(42), result);
});

for (const [status, body, code] of [
  [401, { detail: "unauthorized" }, "UNAUTHORIZED"],
  [400, { ok: false, error: "invalid_body", reason: "turns[0].role: bad" }, "BAD_REQUEST"],
  [502, { ok: false, error: "extraction_failed" }, "UPSTREAM_FAILED"],
]) {
  test(`a ${status} keeps the error on the note and never marks it synced`, async () => {
    const store = makeStore();
    const { fetchImpl } = recordingFetch(() => jsonResponse(body, status));
    const connector = createPipelineConnector({ store, fetchImpl });
    await assert.rejects(
      () => connector.sendNote(42),
      (error) => error instanceof PipelineError && error.code === code && error.status === status
    );
    const state = store.states.get(42);
    assert.equal(state.syncedAt, undefined);
    assert.match(state.lastError, new RegExp(String(status)));
    assert.equal(state.lastError.includes(TOKEN), false);
    if (status === 400) assert.match(state.lastError, /turns\[0\]\.role: bad/);
  });
}

test("an unreachable pipeline is recorded as unreachable", async () => {
  const store = makeStore();
  const connector = createPipelineConnector({
    store,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(() => connector.sendNote(42), { code: "UNREACHABLE" });
  assert.match(store.states.get(42).lastError, /unreachable/i);
});

test("redirects are refused and never followed", async () => {
  const store = makeStore();
  const { calls, fetchImpl } = recordingFetch(
    () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } })
  );
  const connector = createPipelineConnector({ store, fetchImpl });
  await assert.rejects(() => connector.sendNote(42), { code: "REDIRECT_BLOCKED" });
  assert.equal(calls.length, 1);
});

test("submitting a saved grill stores its meta and never waits on the post", async () => {
  const store = makeStore({ notes: [grillNote({ grill_meta: null })] });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { calls, fetchImpl } = recordingFetch(async (call) => {
    await gate;
    return okSession(call);
  });
  const connector = createPipelineConnector({ store, fetchImpl });
  const result = await connector.submitGrillNote(42, META);
  assert.deepEqual(result, { queued: true });
  assert.deepEqual(store.metas.get(42), META);
  release();
  await connector.idle();
  assert.equal(calls[0].body.started_at, META.startedAt);
  assert.ok(store.states.get(42).syncedAt);
});

test("a failed post is retried on the next app start and on the next save", async () => {
  const notes = [grillNote({ id: 1 }), grillNote({ id: 2 })];
  const store = makeStore({ notes });
  let up = false;
  const { calls, fetchImpl } = recordingFetch((call) =>
    up ? okSession(call) : jsonResponse({ ok: false, error: "extraction_failed" }, 502)
  );
  const connector = createPipelineConnector({ store, fetchImpl });
  await assert.rejects(() => connector.sendNote(1));
  assert.ok(store.states.get(1).lastError);

  // Next app start.
  up = true;
  const started = await connector.retryPending();
  assert.deepEqual(started, { attempted: 2, sent: 2, failed: 0 });
  assert.ok(store.states.get(1).syncedAt);
  assert.equal(store.states.get(1).lastError, null);

  // Next save: a new grill plus anything still pending.
  up = false;
  store.states.clear();
  await connector.submitGrillNote(2, META);
  await connector.idle();
  assert.ok(store.states.get(1).lastError, "note 1 retried on note 2's save");
  up = true;
  await connector.submitGrillNote(2, META);
  await connector.idle();
  assert.ok(store.states.get(1).syncedAt);
  assert.ok(store.states.get(2).syncedAt);
  assert.ok(calls.length >= 6);
});

test("an unconfigured pipeline leaves grills pending without errors or requests", async () => {
  const store = makeStore({ token: "" });
  const { calls, fetchImpl } = recordingFetch(okSession);
  const connector = createPipelineConnector({ store, fetchImpl });
  assert.deepEqual(await connector.retryPending(), { attempted: 0, sent: 0, failed: 0 });
  await connector.submitGrillNote(42, META);
  await connector.idle();
  assert.equal(calls.length, 0);
  assert.equal(store.states.get(42), undefined);
});

test("re-sending one note is serialized and posts the same note_id", async () => {
  const store = makeStore();
  let inFlight = 0;
  let maxInFlight = 0;
  const { calls, fetchImpl } = recordingFetch(async (call) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return okSession(call);
  });
  const connector = createPipelineConnector({ store, fetchImpl });
  await Promise.all([connector.sendNote(42), connector.sendNote(42)]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    calls.map((c) => c.body.note_id),
    ["whisper-42", "whisper-42"]
  );
});

test("the Test button reports ok, unauthorized, or unreachable from GET /internal/grill/questions", async () => {
  const store = makeStore();
  const ok = recordingFetch(() => jsonResponse({ questions: [] }));
  assert.deepEqual(
    await createPipelineConnector({ store, fetchImpl: ok.fetchImpl }).testConnection(),
    {
      result: "ok",
      status: 200,
    }
  );
  assert.equal(ok.calls[0].url, `${BASE}/internal/grill/questions`);
  assert.equal(ok.calls[0].method, "GET");
  assert.equal(ok.calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);

  const denied = recordingFetch(() => jsonResponse({ detail: "no" }, 401));
  assert.deepEqual(
    await createPipelineConnector({ store, fetchImpl: denied.fetchImpl }).testConnection(),
    { result: "unauthorized", status: 401 }
  );

  const down = createPipelineConnector({
    store,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.deepEqual(await down.testConnection(), { result: "unreachable" });
});

test("feed questions are read from the pipeline and malformed entries are dropped", async () => {
  const store = makeStore();
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse({
      questions: [
        {
          id: "fq-1",
          source: "OpenAI News",
          title: "T",
          url: "https://x",
          tags: [],
          question: "Q1?",
        },
        { id: "", question: "no id" },
        { id: "fq-2", question: "" },
        { id: "fq-3", question: "Q3?" },
      ],
    })
  );
  const connector = createPipelineConnector({ store, fetchImpl });
  assert.deepEqual(await connector.fetchQuestions(), {
    configured: true,
    questions: [
      { id: "fq-1", question: "Q1?" },
      { id: "fq-3", question: "Q3?" },
    ],
  });
  const unconfigured = createPipelineConnector({ store: makeStore({ baseUrl: "" }), fetchImpl });
  assert.deepEqual(await unconfigured.fetchQuestions(), { configured: false, questions: [] });
});

test("the token never reaches the settings payload or any log line", async () => {
  const store = makeStore({ token: "" });
  const { log, text } = recordingLog();
  const responses = [
    (call) => okSession(call),
    () => jsonResponse({ detail: "unauthorized" }, 401),
    () => jsonResponse({ ok: false, error: "invalid_body", reason: "turns[0].role: bad" }, 400),
    () => jsonResponse({ ok: false, error: "extraction_failed" }, 502),
  ];
  const { fetchImpl } = recordingFetch((call, n) => responses[(n - 1) % responses.length](call));
  const connector = createPipelineConnector({ store, fetchImpl, log });

  const saved = await connector.saveSettings({ baseUrl: `${BASE}/`, token: TOKEN });
  assert.deepEqual(saved, { baseUrl: BASE, hasToken: true, configured: true });
  assert.equal(store.token, TOKEN);
  assert.deepEqual(store.settings, { baseUrl: BASE }, "the token is never in the settings file");
  assert.equal(JSON.stringify(await connector.getSettings()).includes(TOKEN), false);

  await connector.idle();
  for (let i = 0; i < 4; i += 1) await connector.sendNote(42).catch(() => {});
  await connector.testConnection();

  const logged = text();
  assert.ok(logged.length > 2, "the connector logs");
  assert.equal(logged.includes(TOKEN), false);
  for (const turn of TURNS) assert.equal(logged.includes(turn.text), false, "no turn text in logs");
  assert.match(logged, /42/);
});

test("saving settings rejects a URL with credentials, query, or fragment", async () => {
  const connector = createPipelineConnector({ store: makeStore(), fetchImpl: async () => null });
  for (const baseUrl of ["ftp://x", "https://u:p@x.test", "https://x.test/?a=1", "not a url"]) {
    await assert.rejects(() => connector.saveSettings({ baseUrl }), { code: "INVALID_SETTINGS" });
  }
});

test("the title is capped at 500 characters, matching SMP GrillSessionRequest.title", () => {
  const payload = buildGrillSessionPayload(grillNote({ title: "x".repeat(600) }));
  assert.equal(payload.title.length, 500);
  assert.equal(buildGrillSessionPayload(grillNote({ title: "y".repeat(500) })).title.length, 500);
});

test("the title cap counts code points and never splits an emoji", () => {
  // 499 ASCII then an emoji (two UTF-16 units) straddling the 500 boundary.
  const title = `${"x".repeat(499)}\u{1F525}tail`;
  const capped = buildGrillSessionPayload(grillNote({ title })).title;
  assert.equal(Array.from(capped).length, 500);
  assert.equal(capped, `${"x".repeat(499)}\u{1F525}`);
  assert.equal(capped.isWellFormed(), true);
  // 500 emoji: 1000 UTF-16 units, 500 code points, kept whole.
  const emoji = "\u{1F600}".repeat(600);
  const cappedEmoji = buildGrillSessionPayload(grillNote({ title: emoji })).title;
  assert.equal(Array.from(cappedEmoji).length, 500);
  assert.equal(cappedEmoji.isWellFormed(), true);
});

test("a 400 records SMP's reason rule, not only its error code", async () => {
  const store = makeStore();
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse({ ok: false, error: "invalid_body", reason: "title: too long" }, 400)
  );
  const connector = createPipelineConnector({ store, fetchImpl });
  await assert.rejects(() => connector.sendNote(42), { code: "BAD_REQUEST" });
  assert.match(store.states.get(42).lastError, /title: too long/);
  assert.equal(store.states.get(42).notSendable, undefined);
});

for (const [label, notes] of [
  ["deleted", [grillNote({ deleted_at: "2026-09-27 15:00:00" }), grillNote({ id: 2 })]],
  ["out of account scope", [grillNote({ id: 2 })]],
]) {
  test(`a pending note that no longer resolves (${label}) leaves the retry set, logged once, nothing recorded`, async () => {
    const store = makeStore({ notes, pending: [42, 2] });
    const recorded = [];
    const saveSyncState = store.saveSyncState;
    store.saveSyncState = async (id, state) => {
      recorded.push(Number(id));
      if (Number(id) === 42) throw new Error("Note not found");
      return saveSyncState(id, state);
    };
    if (label === "out of account scope")
      store.getNote = async (id) => (Number(id) === 2 ? grillNote({ id: 2 }) : null);
    const logger = recordingLog();
    const { calls, fetchImpl } = recordingFetch(okSession);
    const connector = createPipelineConnector({ store, fetchImpl, log: logger.log });

    assert.deepEqual(await connector.retryPending(), { attempted: 2, sent: 1, failed: 1 });
    assert.deepEqual(await connector.retryPending(), { attempted: 1, sent: 1, failed: 0 });
    await assert.rejects(() => connector.sendNote(42), { code: "NOTE_NOT_FOUND" });

    assert.equal(recorded.includes(42), false);
    assert.equal(store.states.has(42), false);
    assert.equal(calls.filter((c) => c.body.note_id === "whisper-42").length, 0);
    const goneLines = logger.lines.filter(
      ([, message, fields]) => /no longer resolves/.test(message) && fields?.noteId === 42
    );
    assert.equal(goneLines.length, 1);
  });
}

test("a note that resolves again after being dropped rejoins the retry set when saved", async () => {
  const store = makeStore({ notes: [grillNote({ id: 2 })], pending: [42] });
  const { calls, fetchImpl } = recordingFetch(okSession);
  const connector = createPipelineConnector({ store, fetchImpl });
  assert.deepEqual(await connector.retryPending(), { attempted: 1, sent: 0, failed: 1 });
  store.noteMap.set(42, grillNote());
  await connector.submitGrillNote(42, META);
  await connector.idle();
  assert.ok(store.states.get(42).syncedAt);
  assert.equal(calls.filter((c) => c.body.note_id === "whisper-42").length, 1);
});

for (const [code, overrides] of [
  ["NO_TURNS", { transcript: "plain text" }],
  [
    "INVALID_NOTE",
    { title: "Chapter", grill_meta: JSON.stringify({ ...META, kind: "lifetime", chapter: null }) },
  ],
]) {
  test(`${code} marks the note not sendable until it is saved again with valid turns`, async () => {
    const store = makeStore({ notes: [grillNote({ id: 1, ...overrides }), grillNote({ id: 2 })] });
    const { calls, fetchImpl } = recordingFetch(okSession);
    const connector = createPipelineConnector({ store, fetchImpl });
    await assert.rejects(() => connector.sendNote(1), { code });
    assert.match(store.states.get(1).lastError, new RegExp(code));
    assert.equal(store.states.get(1).notSendable, true);
    assert.equal(calls.length, 0);

    // Next app start: only the sendable note is retried.
    assert.deepEqual(await connector.retryPending(), { attempted: 1, sent: 1, failed: 0 });
    assert.deepEqual(
      calls.map((c) => c.body.note_id),
      ["whisper-2"]
    );
    // Another note saved: still not retried.
    await connector.submitGrillNote(2, META);
    await connector.idle();
    assert.equal(calls.filter((c) => c.body.note_id === "whisper-1").length, 0);

    // Saved again with valid turns: the state clears and it sends.
    store.noteMap.set(1, grillNote({ id: 1 }));
    await connector.submitGrillNote(1, META);
    await connector.idle();
    assert.equal(store.states.get(1).notSendable, false);
    assert.equal(store.states.get(1).lastError, null);
    assert.ok(store.states.get(1).syncedAt);
  });
}

// D-L1-5: the bank store tags interviewer turns with "gq-" ids and follow_up_of,
// but SMP rejects unknown fields and treats every tagged turn as a feed session
// until pipeline lane L2 widens the contract.
test("bank question ids and follow_up_of are not sent; an fq- id still is", () => {
  const stored = [
    {
      role: "assistant",
      text: "What surprised you yesterday?",
      source: "system",
      question_id: "gq-1111",
    },
    { role: "user", text: "Honestly the gate bug.", source: "mic" },
    {
      role: "assistant",
      text: "Say more about the gate.",
      source: "system",
      follow_up_of: "gq-1111",
    },
    { role: "user", text: "It refused a literal path.", source: "mic" },
    {
      role: "assistant",
      text: "OpenAI News says X. Agree or disagree?",
      source: "system",
      question_id: "fq-1",
    },
    { role: "user", text: "Disagree, clients miss the cost.", source: "mic" },
  ];
  const payload = buildGrillSessionPayload(grillNote({ transcript: JSON.stringify(stored) }));
  assert.equal(payload.session_kind, "daily");
  assert.deepEqual(
    payload.turns.map((turn) => turn.question_id),
    [null, null, null, null, "fq-1", null]
  );
  for (const turn of payload.turns) {
    assert.deepEqual(Object.keys(turn), ["role", "text", "question_id"]);
  }
  assert.equal(JSON.stringify(payload).includes("follow_up_of"), false);
  assert.equal(JSON.stringify(payload).includes("gq-"), false);
});

// The closing feedback question is tagged locally as
// "feedback"; SMP knows only "fq-" ids until pipeline lane L5 widens the
// contract, so it is sent as null.
test("a feedback question_id is sent as null", () => {
  const stored = [
    {
      role: "assistant",
      text: "Before we stop: which question today got your best answer, and which one fell flat?",
      source: "system",
      question_id: "feedback",
    },
    { role: "user", text: "The pricing one landed.", source: "mic" },
  ];
  const payload = buildGrillSessionPayload(grillNote({ transcript: JSON.stringify(stored) }));
  assert.deepEqual(
    payload.turns.map((turn) => turn.question_id),
    [null, null]
  );
  assert.equal(JSON.stringify(payload).includes('feedback"'), false);
});
