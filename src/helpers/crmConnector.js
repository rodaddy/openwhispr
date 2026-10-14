const REQUEST_TIMEOUT_MS = 10000;
const OPPORTUNITY_PAGE_SIZE = 50;
const OPPORTUNITY_MAX_PAGES = 10;
// The GoHighLevel SDK is an optional install (see README, "CRM connector").
const SDK_PACKAGE = "@rtech/connectors-highlevel";

class CrmError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "CrmError";
    this.code = code;
    if (status) this.status = status;
  }
}

function renderTranscript(note) {
  const raw = note.transcript || note.content || "";
  if (typeof raw !== "string") return String(raw || "");
  try {
    const parsed = JSON.parse(raw);
    const segments = Array.isArray(parsed) ? parsed : parsed?.segments;
    if (!Array.isArray(segments)) return raw;
    const mappings = note.speakerMappings || {};
    return segments
      .filter((segment) => segment?.text?.trim())
      .map((segment) => {
        const speaker =
          (segment.speakerName && !segment.speakerIsPlaceholder && segment.speakerName) ||
          mappings[segment.speaker] ||
          (segment.speaker === "you" || segment.source === "mic" ? "You" : null) ||
          (segment.source === "system" ? "Others" : null) ||
          (segment.speaker
            ? `Speaker ${Number.parseInt(String(segment.speaker).replace("speaker_", ""), 10) + 1}`
            : "Unknown Speaker");
        return `${speaker}: ${segment.text.trim()}`;
      })
      .join("\n\n");
  } catch {
    return raw;
  }
}

function buildActivityBody(note, timestamp) {
  const summary = String(note.enhanced_content || note.content || "").trim();
  const transcript = renderTranscript(note).trim();
  const parts = [];
  if (summary) parts.push(summary);
  if (transcript && transcript !== summary) parts.push(transcript);
  const noteId = note.id == null ? "unknown" : note.id;
  parts.push(`Synced from rTech Whisper ${noteId} on ${timestamp.toISOString()}`);
  return parts.join("\n\n---\n\n");
}

function contactUrl(locationId, contactId) {
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}`;
}

/** Map any failure to a CrmError with a fixed message: never the token or GHL's response text. */
function toCrmError(error, sdk) {
  if (error instanceof CrmError) return error;
  if (error instanceof sdk.HighLevelTimeoutError) {
    return new CrmError("GoHighLevel request timed out", "TIMEOUT");
  }
  if (error instanceof sdk.HighLevelApiError) {
    const { status } = error;
    if (status === 401 || status === 403) {
      return new CrmError(`GoHighLevel rejected the token (HTTP ${status})`, "AUTH_FAILED", status);
    }
    if (status === 429) {
      return new CrmError("GoHighLevel rate limit reached (HTTP 429)", "RATE_LIMITED", status);
    }
    return new CrmError(`GoHighLevel request failed (HTTP ${status})`, "GHL_ERROR", status);
  }
  return new CrmError("GoHighLevel request failed", "GHL_ERROR");
}

function createCrmConnector({
  store,
  fetchImpl = fetch,
  now = () => new Date(),
  loadSdk = () => import(SDK_PACKAGE),
}) {
  const noteQueues = new Map();
  let sdkPromise = null;
  // Which of the SDK's ACCOUNTS profiles to use (see README, "CRM connector").
  const account = process.env.GHL_ACCOUNT || "rtech";

  async function run(fn) {
    sdkPromise ||= Promise.resolve()
      .then(loadSdk)
      .catch((error) => {
        sdkPromise = null;
        if (error?.code === "ERR_MODULE_NOT_FOUND") {
          throw new CrmError("CRM connector not installed", "NOT_INSTALLED");
        }
        throw new CrmError("GoHighLevel library failed to load", "GHL_ERROR");
      });
    const sdk = await sdkPromise;
    try {
      return await fn(sdk, sdk.ACCOUNTS[account]?.locationId);
    } catch (error) {
      throw toCrmError(error, sdk);
    }
  }

  function clientFor(sdk, token) {
    if (!token) throw new CrmError("Add a GoHighLevel token first", "NOT_CONFIGURED");
    return sdk.createClient({
      account,
      token: String(token),
      allowWrites: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl,
    });
  }

  function receipt(state, locationId) {
    return {
      noteId: state.noteId,
      contactId: state.contactId,
      opportunityId: state.opportunityId,
      syncedAt: state.syncedAt,
      url: contactUrl(locationId, state.contactId),
    };
  }

  function syncOnce(noteId, target) {
    const contactId = String(target?.contactId || "").trim();
    const opportunityId = String(target?.opportunityId || "").trim();
    return run(async (sdk, locationId) => {
      if (!contactId || !opportunityId) {
        throw new CrmError("Choose a contact and an opportunity", "INVALID_TARGET");
      }
      const context = await store.captureSyncContext(noteId, locationId);
      if (!context) throw new CrmError("Note not found", "NOTE_NOT_FOUND");
      const client = clientFor(sdk, context.token);
      const previous = await store.getSyncState(noteId, context);
      if (previous && previous.contactId !== contactId) {
        throw new CrmError(
          "This note is already synced to a different GoHighLevel contact",
          "TARGET_CHANGED"
        );
      }
      const timestamp = now();
      const body = buildActivityBody(context.note, timestamp);
      let ghlNote = null;
      if (previous) {
        try {
          ghlNote = await sdk.updateNote(client, {
            contactId,
            noteId: previous.noteId,
            body,
            opportunityId,
          });
        } catch (error) {
          if (!(error instanceof sdk.HighLevelApiError && error.status === 404)) throw error;
        }
      }
      ghlNote ||= await sdk.createNote(client, { contactId, body, opportunityId });
      if (!(await store.validateSyncContext(context))) {
        throw new CrmError("GoHighLevel token or account changed during sync", "SETTINGS_CHANGED");
      }
      const state = {
        noteId: String(ghlNote.id),
        contactId,
        opportunityId,
        syncedAt: timestamp.toISOString(),
      };
      await store.saveSyncState(noteId, state, context);
      return receipt(state, locationId);
    });
  }

  return {
    getSettings() {
      return run(async (_sdk, locationId) => {
        const hasToken = Boolean(await store.getToken());
        return { configured: hasToken, hasToken, locationId };
      });
    },
    async saveSettings({ token } = {}) {
      if (token !== undefined) await store.saveToken(token == null ? "" : String(token).trim());
      return this.getSettings();
    },
    testConnection() {
      return run(async (sdk) => {
        const location = await sdk.getLocation(clientFor(sdk, await store.getToken()));
        return { locationName: location.name };
      });
    },
    searchContacts(query) {
      const q = String(query || "").trim();
      return run(async (sdk) => {
        if (!q) throw new CrmError("Enter a name, email or phone to search", "QUERY_REQUIRED");
        const client = clientFor(sdk, await store.getToken());
        const { contacts } = await sdk.searchContacts(client, { query: q, limit: 10 });
        return contacts.map((contact) => ({
          id: contact.id,
          name: contact.name || contact.email || contact.id,
          ...(contact.email ? { email: contact.email } : {}),
          ...(contact.phone ? { phone: contact.phone } : {}),
          ...(contact.companyName ? { companyName: contact.companyName } : {}),
        }));
      });
    },
    listOpportunities(contactId) {
      const id = String(contactId || "").trim();
      return run(async (sdk) => {
        if (!id) throw new CrmError("Choose a contact first", "INVALID_TARGET");
        const client = clientFor(sdk, await store.getToken());
        const all = [];
        let cursor = {};
        // Page until a page comes back short or carries no cursor; 10 pages is a runaway guard.
        for (let pages = 0; pages < OPPORTUNITY_MAX_PAGES; pages += 1) {
          const page = await sdk.searchOpportunities(client, {
            contactId: id,
            status: "all",
            limit: OPPORTUNITY_PAGE_SIZE,
            ...cursor,
          });
          all.push(...page.opportunities);
          if (page.opportunities.length < OPPORTUNITY_PAGE_SIZE) break;
          if (page.nextStartAfter === undefined || page.nextStartAfterId === undefined) break;
          cursor = { startAfter: page.nextStartAfter, startAfterId: page.nextStartAfterId };
        }
        return all.map((opportunity) => ({
          id: opportunity.id,
          name: opportunity.name,
          status: opportunity.status,
          pipelineId: opportunity.pipelineId,
          pipelineStageId: opportunity.pipelineStageId,
          ...(opportunity.monetaryValue === undefined
            ? {}
            : { monetaryValue: opportunity.monetaryValue }),
        }));
      });
    },
    syncNote(noteId, target) {
      const key = String(noteId);
      const prior = noteQueues.get(key) || Promise.resolve();
      const next = prior.catch(() => {}).then(() => syncOnce(noteId, target));
      noteQueues.set(key, next);
      return next.finally(() => {
        if (noteQueues.get(key) === next) noteQueues.delete(key);
      });
    },
    getSyncState(noteId) {
      return run(async (_sdk, locationId) => {
        const context = await store.captureSyncContext(noteId, locationId);
        const state = context ? await store.getSyncState(noteId, context) : null;
        return state ? receipt(state, locationId) : null;
      });
    },
  };
}

module.exports = { buildActivityBody, createCrmConnector, CrmError };
