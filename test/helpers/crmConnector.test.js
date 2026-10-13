const test = require("node:test");
const assert = require("node:assert/strict");

const { buildActivityBody, createCrmConnector } = require("../../src/helpers/crmConnector.js");

const LOCATION = "JlGDgu1zAhuOYSxSFeh7";
const TOKEN = "pit-secret-token";
const NOW = new Date("2026-10-07T12:00:00.000Z");

function makeStore({ token = TOKEN } = {}) {
  let current = token;
  const states = new Map();
  const note = { id: 1, enhanced_content: "The summary", transcript: "The transcript" };
  return {
    states,
    getToken: async () => current,
    saveToken: async (value) => {
      current = value || "";
    },
    async captureSyncContext(noteId, locationId) {
      if (noteId !== 1) return null;
      return { note, accountId: "acct", token: current, locationId, scope: "ghl:test" };
    },
    validateSyncContext: async (context) => context.token === current,
    getSyncState: async (noteId) => states.get(noteId) || null,
    saveSyncState: async (noteId, state) => {
      states.set(noteId, state);
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake GHL: records every call and answers by route. */
function fakeGhl(routes = {}) {
  const calls = [];
  let created = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ method, path: url.pathname, query: url.searchParams, body, auth });
    const key = `${method} ${url.pathname}`;
    if (routes[key]) return routes[key]({ body, url });
    const noteMatch = url.pathname.match(/^\/contacts\/([^/]+)\/notes(?:\/([^/]+))?$/);
    if (noteMatch && method === "POST") {
      created += 1;
      return json({ note: { id: `ghl-note-${created}`, contactId: noteMatch[1], ...body } });
    }
    if (noteMatch && (method === "GET" || method === "PUT")) {
      return json({
        note: { id: noteMatch[2], contactId: noteMatch[1], body: body?.body || "old", ...body },
      });
    }
    return json({ message: "no route" }, 500);
  };
  return { calls, fetchImpl };
}

function connectorFor(store, ghl) {
  return createCrmConnector({ store, fetchImpl: ghl.fetchImpl, now: () => NOW });
}

test("settings report the rTech location, keep, trim, and remove the token, never return it", async () => {
  const store = makeStore({ token: "" });
  const connector = connectorFor(store, fakeGhl());
  assert.deepEqual(await connector.getSettings(), {
    configured: false,
    hasToken: false,
    locationId: LOCATION,
  });
  const saved = await connector.saveSettings({ token: `  ${TOKEN}  ` });
  assert.deepEqual(saved, { configured: true, hasToken: true, locationId: LOCATION });
  assert.equal(await store.getToken(), TOKEN);
  await connector.saveSettings({});
  assert.equal(await store.getToken(), TOKEN);
  await connector.saveSettings({ token: null });
  assert.equal((await connector.getSettings()).hasToken, false);
  await connector.saveSettings({ token: TOKEN });
  await connector.saveSettings({ token: "" });
  assert.equal(await store.getToken(), "");
});

test("connection test reads the location with the bearer token; no token means no request", async () => {
  const ghl = fakeGhl({
    [`GET /locations/${LOCATION}`]: () => json({ location: { id: LOCATION, name: "rTech" } }),
  });
  assert.deepEqual(await connectorFor(makeStore(), ghl).testConnection(), {
    locationName: "rTech",
  });
  assert.equal(ghl.calls[0].auth, `Bearer ${TOKEN}`);
  const empty = fakeGhl();
  await assert.rejects(connectorFor(makeStore({ token: "" }), empty).testConnection(), {
    code: "NOT_CONFIGURED",
  });
  assert.equal(empty.calls.length, 0);
});

test("contact search trims, sends limit 10, and maps names with fallbacks", async () => {
  const ghl = fakeGhl({
    "POST /contacts/search": () =>
      json({
        contacts: [
          { id: "c1", contactName: "Ada Lovelace", email: "ada@x.io", companyName: "AE" },
          { id: "c2", email: "bob@x.io", phone: "+15550100", tags: [] },
          { id: "c3" },
        ],
      }),
  });
  const connector = connectorFor(makeStore(), ghl);
  await assert.rejects(connector.searchContacts("   "), { code: "QUERY_REQUIRED" });
  assert.equal(ghl.calls.length, 0);
  assert.deepEqual(await connector.searchContacts("  ada "), [
    { id: "c1", name: "Ada Lovelace", email: "ada@x.io", companyName: "AE" },
    { id: "c2", name: "bob@x.io", email: "bob@x.io", phone: "+15550100" },
    { id: "c3", name: "c3" },
  ]);
  assert.equal(ghl.calls[0].body.query, "ada");
  assert.equal(ghl.calls[0].body.pageLimit, 10);
  assert.equal(ghl.calls[0].body.locationId, LOCATION);
});

test("opportunities page through every page of the contact's opportunities", async () => {
  const opp = (id) => ({ id, name: id, status: "open", pipelineId: "p", pipelineStageId: "s" });
  const first = Array.from({ length: 50 }, (_, i) => opp(`o${i + 1}`));
  const ghl = fakeGhl({
    "GET /opportunities/search": ({ url }) =>
      url.searchParams.get("startAfterId") === "o50"
        ? json({ opportunities: [opp("o51")], meta: { startAfter: 2, startAfterId: "o51" } })
        : json({ opportunities: first, meta: { startAfter: 1, startAfterId: "o50" } }),
  });
  const listed = await connectorFor(makeStore(), ghl).listOpportunities("c1");
  assert.deepEqual(
    listed.map((o) => o.id),
    [...first, opp("o51")].map((o) => o.id)
  );
  assert.equal(ghl.calls.length, 2);
  assert.equal(ghl.calls[0].query.get("startAfterId"), null);
  assert.equal(ghl.calls[1].query.get("startAfter"), "1");
  assert.equal(ghl.calls[1].query.get("startAfterId"), "o50");
  assert.equal(ghl.calls[1].query.get("contact_id"), "c1");
});

test("opportunities paging stops after 10 pages", async () => {
  let n = 0;
  const ghl = fakeGhl({
    "GET /opportunities/search": () => {
      const page = Array.from({ length: 50 }, () => {
        n += 1;
        return { id: `o${n}`, name: "x", status: "open", pipelineId: "p", pipelineStageId: "s" };
      });
      return json({ opportunities: page, meta: { startAfter: n, startAfterId: `o${n}` } });
    },
  });
  const listed = await connectorFor(makeStore(), ghl).listOpportunities("c1");
  assert.equal(ghl.calls.length, 10);
  assert.equal(listed.length, 500);
});

test("opportunities ask for every status of the contact, 50 per page", async () => {
  const opportunity = {
    id: "o1",
    name: "Web",
    status: "open",
    pipelineId: "p",
    pipelineStageId: "s",
  };
  const ghl = fakeGhl({
    "GET /opportunities/search": () => json({ opportunities: [{ ...opportunity, source: "x" }] }),
  });
  const listed = await connectorFor(makeStore(), ghl).listOpportunities("c1");
  assert.deepEqual(listed, [opportunity]);
  const { query } = ghl.calls[0];
  assert.equal(query.get("contact_id"), "c1");
  assert.equal(query.get("status"), "all");
  assert.equal(query.get("limit"), "50");
});

test("activity body prefers enhanced content, retains transcript, and includes source", () => {
  const timestamp = new Date("2026-09-09T14:15:00.000Z");
  const body = buildActivityBody(
    {
      id: 1,
      enhanced_content: "The concise summary",
      transcript: "The full transcript",
    },
    timestamp
  );

  assert.ok(body.indexOf("The concise summary") < body.indexOf("The full transcript"));
  assert.match(body, /The concise summary[\s\S]+---[\s\S]+The full transcript/);
  assert.match(body, /Synced from rTech Whisper 1 on 2026-09-09T14:15:00\.000Z$/);
});

test("activity body renders persisted transcript speaker names instead of serialized JSON", () => {
  const body = buildActivityBody(
    {
      id: 2,
      enhanced_content: "Introductions and next steps",
      transcript: JSON.stringify([
        { text: "Welcome everyone", speaker: "speaker_0", speakerName: "Rico" },
        { text: "Glad to be here", speaker: "speaker_1", speakerName: "Ada" },
      ]),
    },
    new Date("2026-09-09T15:00:00.000Z")
  );

  assert.match(body, /Rico:\s*Welcome everyone/);
  assert.match(body, /Ada:\s*Glad to be here/);
  assert.doesNotMatch(body, /speaker_0|speakerName|\{"text"/);
  assert.match(body, /Synced from rTech Whisper 2 on 2026-09-09T15:00:00\.000Z$/);
});

test("first sync creates a note linked to the opportunity and returns the receipt", async () => {
  const store = makeStore();
  const ghl = fakeGhl();
  const state = await connectorFor(store, ghl).syncNote(1, {
    contactId: "c1",
    opportunityId: "o1",
  });
  const expected = {
    noteId: "ghl-note-1",
    contactId: "c1",
    opportunityId: "o1",
    syncedAt: NOW.toISOString(),
    url: `https://app.gohighlevel.com/v2/location/${LOCATION}/contacts/detail/c1`,
  };
  assert.deepEqual(state, expected);
  assert.deepEqual(
    ghl.calls.map((call) => `${call.method} ${call.path}`),
    ["POST /contacts/c1/notes"]
  );
  assert.deepEqual(ghl.calls[0].body.relations, [{ objectKey: "opportunity", recordId: "o1" }]);
  assert.match(ghl.calls[0].body.body, /The summary[\s\S]+The transcript/);
  assert.deepEqual(await connectorFor(store, ghl).getSyncState(1), expected);
  assert.equal(await connectorFor(store, ghl).getSyncState(99), null);
});

test("repeat and concurrent syncs update the one existing note with the chosen opportunity", async () => {
  const store = makeStore();
  const ghl = fakeGhl();
  const connector = connectorFor(store, ghl);
  await connector.syncNote(1, { contactId: "c1", opportunityId: "o1" });
  const [a, b] = await Promise.all([
    connector.syncNote(1, { contactId: "c1", opportunityId: "o2" }),
    connector.syncNote(1, { contactId: "c1", opportunityId: "o2" }),
  ]);
  assert.equal(a.noteId, "ghl-note-1");
  assert.equal(b.noteId, "ghl-note-1");
  assert.deepEqual(
    ghl.calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /contacts/c1/notes",
      "GET /contacts/c1/notes/ghl-note-1",
      "PUT /contacts/c1/notes/ghl-note-1",
      "GET /contacts/c1/notes/ghl-note-1",
      "PUT /contacts/c1/notes/ghl-note-1",
    ]
  );
  assert.deepEqual(ghl.calls[2].body.relations, [{ objectKey: "opportunity", recordId: "o2" }]);
  assert.equal(store.states.get(1).opportunityId, "o2");
});

test("a synced note refuses another contact before any request", async () => {
  const store = makeStore();
  const ghl = fakeGhl();
  const connector = connectorFor(store, ghl);
  await connector.syncNote(1, { contactId: "c1", opportunityId: "o1" });
  await assert.rejects(connector.syncNote(1, { contactId: "c2", opportunityId: "o1" }), {
    code: "TARGET_CHANGED",
  });
  assert.equal(ghl.calls.length, 1);
});

test("a note deleted in GoHighLevel is recreated", async () => {
  const store = makeStore();
  const ghl = fakeGhl({
    "GET /contacts/c1/notes/ghl-note-1": () => json({ message: "Note not found" }, 404),
  });
  const connector = connectorFor(store, ghl);
  await connector.syncNote(1, { contactId: "c1", opportunityId: "o1" });
  const state = await connector.syncNote(1, { contactId: "c1", opportunityId: "o1" });
  assert.equal(state.noteId, "ghl-note-2");
  assert.equal(store.states.get(1).noteId, "ghl-note-2");
});

test("invalid input, missing notes, and a token change mid-sync fail with their codes", async () => {
  const store = makeStore();
  const connector = connectorFor(store, fakeGhl());
  await assert.rejects(connector.syncNote(1, { contactId: "c1" }), { code: "INVALID_TARGET" });
  await assert.rejects(connector.syncNote(2, { contactId: "c1", opportunityId: "o1" }), {
    code: "NOTE_NOT_FOUND",
  });
  const racing = fakeGhl({
    "POST /contacts/c1/notes": async ({ body }) => {
      await store.saveToken("replacement-token");
      return json({ note: { id: "ghl-note-9", contactId: "c1", body: body.body } });
    },
  });
  await assert.rejects(
    connectorFor(store, racing).syncNote(1, { contactId: "c1", opportunityId: "o1" }),
    { code: "SETTINGS_CHANGED" }
  );
  assert.equal(store.states.size, 0);
});

test("GoHighLevel failures map to fixed codes and never leak the token or response text", async () => {
  const { HighLevelTimeoutError } = await import("@rtech/connectors-highlevel");
  const cases = [
    [() => json({ message: `bad ${TOKEN}` }, 401), "AUTH_FAILED", 401],
    [() => json({ message: "scope" }, 403), "AUTH_FAILED", 403],
    [() => json({ message: "slow down" }, 429), "RATE_LIMITED", 429],
    [() => json({ message: "boom secret-body" }, 500), "GHL_ERROR", 500],
    [() => json({ wrong: true }), "GHL_ERROR", undefined],
    [
      () => {
        throw new HighLevelTimeoutError({ method: "POST", path: "/x", timeoutMs: 10000 });
      },
      "TIMEOUT",
      undefined,
    ],
  ];
  for (const [answer, code, status] of cases) {
    const store = makeStore();
    const ghl = fakeGhl({ "POST /contacts/c1/notes": answer });
    const error = await connectorFor(store, ghl)
      .syncNote(1, { contactId: "c1", opportunityId: "o1" })
      .then(
        () => assert.fail("sync should fail"),
        (failure) => failure
      );
    assert.equal(error.name, "CrmError");
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /pit-secret|secret-body|slow down|scope/);
    assert.equal(store.states.size, 0);
  }
});
