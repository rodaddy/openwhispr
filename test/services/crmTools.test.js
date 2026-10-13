const test = require("node:test");
const assert = require("node:assert/strict");

const loadTools = () => import("../../src/services/tools/crmTools.ts");

const originalWindow = global.window;
test.afterEach(() => {
  if (originalWindow === undefined) delete global.window;
  else global.window = originalWindow;
});

function opportunity(id, name, status = "open") {
  return { id, name, status, pipelineId: "pipe-1", pipelineStageId: "stage-1" };
}

function stubBridge({
  contacts = [],
  opportunities = [opportunity("opp-1", "Website rebuild")],
  note = { id: 42, title: "Discovery notes" },
  syncResult,
} = {}) {
  const calls = { search: [], listOpportunities: [], getNote: [], sync: [] };
  global.window = {
    electronAPI: {
      crmSearchContacts: async (query) => {
        calls.search.push(query);
        return { success: true, contacts };
      },
      crmListOpportunities: async (contactId) => {
        calls.listOpportunities.push(contactId);
        return { success: true, opportunities };
      },
      getNote: async (id) => {
        calls.getNote.push(id);
        return note;
      },
      crmSyncNote: async (noteId, target) => {
        calls.sync.push({ noteId, target });
        return (
          syncResult ?? {
            success: true,
            state: {
              noteId: "ghl-note-1",
              contactId: target.contactId,
              opportunityId: target.opportunityId,
              syncedAt: "2026-10-07T20:00:00.000Z",
              url: "https://app.gohighlevel.com/v2/location/loc/contacts/detail/contact-1",
            },
          }
        );
      },
    },
  };
  return calls;
}

const rico = { id: "contact-1", name: "Rico Rojas", email: "rico@example.com" };

test("contact search returns at most five contacts and is read-only", async () => {
  const { findCrmContactTool } = await loadTools();
  const calls = stubBridge({
    contacts: Array.from({ length: 7 }, (_, index) => ({
      id: `contact-${index}`,
      name: `Rico ${index}`,
      email: `rico${index}@example.com`,
    })),
  });

  const result = await findCrmContactTool.execute({ query: "  Rico " });

  assert.equal(result.success, true);
  assert.equal(result.data.length, 5);
  assert.deepEqual(calls.search, ["Rico"]);
  assert.equal(findCrmContactTool.readOnly, true);
  assert.match(findCrmContactTool.description, /GoHighLevel/);
});

test("contact search reports blank queries, no matches and bridge failures", async () => {
  const { findCrmContactTool } = await loadTools();
  const blankCalls = stubBridge();
  const blank = await findCrmContactTool.execute({ query: "  " });
  assert.equal(blank.data.code, "CONTACT_QUERY_REQUIRED");
  assert.deepEqual(blankCalls.search, []);

  stubBridge({ contacts: [] });
  const empty = await findCrmContactTool.execute({ query: "Nobody" });
  assert.equal(empty.data.code, "CONTACT_NOT_FOUND");

  global.window.electronAPI.crmSearchContacts = async () => {
    throw new Error("bridge down");
  };
  const failed = await findCrmContactTool.execute({ query: "Rico" });
  assert.equal(failed.data.code, "CRM_SEARCH_FAILED");
});

test("attachment asks instead of guessing on ambiguous or empty contacts", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  const ambiguousCalls = stubBridge({
    contacts: [rico, { id: "contact-2", name: "Rico Jones" }],
  });
  const ambiguous = await attachNoteToCrmContactTool.execute({ noteId: 42, contact: "Rico" });
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.data.code, "CONTACT_AMBIGUOUS");
  assert.equal(ambiguous.data.contacts.length, 2);
  assert.deepEqual(ambiguousCalls.listOpportunities, []);
  assert.deepEqual(ambiguousCalls.sync, []);

  const emptyCalls = stubBridge({ contacts: [] });
  const empty = await attachNoteToCrmContactTool.execute({ noteId: 42, contact: "Nobody" });
  assert.equal(empty.data.code, "CONTACT_NOT_FOUND");
  assert.deepEqual(emptyCalls.sync, []);
});

test("attachment rejects non-string and blank contacts before every CRM call", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  for (const contact of [123, { name: "Rico" }, null, "   "]) {
    const calls = stubBridge({ contacts: [rico] });

    const result = await attachNoteToCrmContactTool.execute({ noteId: 42, contact });

    assert.equal(result.data.code, "CONTACT_QUERY_REQUIRED");
    assert.deepEqual(calls.search, []);
    assert.deepEqual(calls.getNote, []);
    assert.deepEqual(calls.sync, []);
  }
});

test("attachment uses the only opportunity when none is named", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  const calls = stubBridge({ contacts: [rico] });

  const result = await attachNoteToCrmContactTool.execute({
    noteId: 42,
    contact: "rico@example.com",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.noteId, "ghl-note-1");
  assert.deepEqual(calls.listOpportunities, ["contact-1"]);
  assert.deepEqual(calls.sync, [
    { noteId: 42, target: { contactId: "contact-1", opportunityId: "opp-1" } },
  ]);
  assert.match(result.displayText, /Discovery notes/);
  assert.match(result.displayText, /Rico Rojas/);
  assert.match(result.displayText, /Website rebuild/);
});

test("attachment matches a named opportunity by id or case-insensitive name", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  const opportunities = [
    opportunity("opp-1", "Website rebuild"),
    opportunity("opp-2", "Retainer 2027", "won"),
  ];
  for (const [named, expected] of [
    ["opp-2", "opp-2"],
    ["retainer", "opp-2"],
    ["WEBSITE", "opp-1"],
  ]) {
    const calls = stubBridge({ contacts: [rico], opportunities });
    const result = await attachNoteToCrmContactTool.execute({
      noteId: 42,
      contact: "Rico Rojas",
      opportunity: named,
    });
    assert.equal(result.success, true, named);
    assert.equal(calls.sync[0].target.opportunityId, expected, named);
  }
});

test("attachment asks instead of guessing on ambiguous or missing opportunities", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  const two = [
    opportunity("opp-1", "Website rebuild"),
    opportunity("opp-2", "Website care", "lost"),
  ];

  const unnamedCalls = stubBridge({ contacts: [rico], opportunities: two });
  const unnamed = await attachNoteToCrmContactTool.execute({ noteId: 42, contact: "Rico" });
  assert.equal(unnamed.data.code, "OPPORTUNITY_AMBIGUOUS");
  assert.deepEqual(unnamed.data.opportunities, [
    { id: "opp-1", name: "Website rebuild", status: "open" },
    { id: "opp-2", name: "Website care", status: "lost" },
  ]);
  assert.deepEqual(unnamedCalls.sync, []);

  const ambiguousCalls = stubBridge({ contacts: [rico], opportunities: two });
  const ambiguous = await attachNoteToCrmContactTool.execute({
    noteId: 42,
    contact: "Rico",
    opportunity: "website",
  });
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.data.code, "OPPORTUNITY_AMBIGUOUS");
  assert.deepEqual(ambiguousCalls.sync, []);

  const missingCalls = stubBridge({ contacts: [rico], opportunities: two });
  const missing = await attachNoteToCrmContactTool.execute({
    noteId: 42,
    contact: "Rico",
    opportunity: "hosting",
  });
  assert.equal(missing.success, false);
  assert.equal(missing.data.code, "OPPORTUNITY_NOT_FOUND");
  assert.deepEqual(missingCalls.sync, []);

  const noneCalls = stubBridge({ contacts: [rico], opportunities: [] });
  const none = await attachNoteToCrmContactTool.execute({ noteId: 42, contact: "Rico" });
  assert.equal(none.data.code, "OPPORTUNITY_NOT_FOUND");
  assert.deepEqual(noneCalls.getNote, []);
  assert.deepEqual(noneCalls.sync, []);
});

test("attaching the same note twice to the same target sends identical sync calls", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  const calls = stubBridge({ contacts: [rico] });
  const args = { noteId: 42, contact: "Rico Rojas", opportunity: "Website rebuild" };

  const first = await attachNoteToCrmContactTool.execute(args);
  const second = await attachNoteToCrmContactTool.execute(args);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  const expected = { noteId: 42, target: { contactId: "contact-1", opportunityId: "opp-1" } };
  assert.deepEqual(calls.sync, [expected, expected]);
  assert.equal(first.data.noteId, "ghl-note-1");
  assert.equal(second.data.noteId, first.data.noteId);
});

test("attachment rejects a missing saved note before CRM mutation", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  const calls = stubBridge({ contacts: [rico], note: null });

  const result = await attachNoteToCrmContactTool.execute({ noteId: 999, contact: "Rico Rojas" });

  assert.equal(result.data.code, "NOTE_NOT_FOUND");
  assert.deepEqual(calls.sync, []);
});

test("connector failures remain typed and clear", async () => {
  const { attachNoteToCrmContactTool } = await loadTools();
  stubBridge({
    contacts: [rico],
    syncResult: {
      success: false,
      code: "TARGET_CHANGED",
      error: "This note is already linked to a different contact",
    },
  });

  const result = await attachNoteToCrmContactTool.execute({ noteId: 42, contact: "Rico Rojas" });

  assert.equal(result.success, false);
  assert.deepEqual(result.data, { code: "TARGET_CHANGED" });
  assert.equal(result.displayText, "This note is already linked to a different contact");
});

test("registry exposes CRM search as read-only and attachment as mutating", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const registry = createToolRegistry({
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  });

  assert.equal(registry.get("find_crm_contact")?.readOnly, true);
  assert.equal(registry.get("attach_note_to_crm_contact")?.readOnly, false);
});
