import type { CrmContact, CrmFailure, CrmOpportunity } from "../../types/crm";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const MAX_CONTACT_RESULTS = 5;

function failure(
  code: string,
  displayText: string,
  data: Record<string, unknown> = {}
): ToolResult {
  return { success: false, data: { code, ...data }, displayText };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contactQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.trim();
  return query || null;
}

async function searchContacts(query: string): Promise<ToolResult | CrmContact[]> {
  const normalized = query.trim();
  if (!normalized) return failure("CONTACT_QUERY_REQUIRED", "Which contact should I look for?");
  try {
    const result = await window.electronAPI.crmSearchContacts(normalized);
    if (!("contacts" in result)) {
      return failure(result.code ?? "CRM_SEARCH_FAILED", result.error);
    }
    return result.contacts;
  } catch (error) {
    return failure(
      "CRM_SEARCH_FAILED",
      `Failed to search GoHighLevel contacts: ${errorMessage(error)}`
    );
  }
}

async function resolveOpportunity(
  contact: CrmContact,
  requested: string | null
): Promise<ToolResult | CrmOpportunity> {
  let opportunities: CrmOpportunity[];
  try {
    const result = await window.electronAPI.crmListOpportunities(contact.id);
    if (!("opportunities" in result)) {
      return failure(result.code ?? "CRM_OPPORTUNITIES_FAILED", result.error);
    }
    opportunities = result.opportunities;
  } catch (error) {
    return failure(
      "CRM_OPPORTUNITIES_FAILED",
      `Failed to list GoHighLevel opportunities: ${errorMessage(error)}`
    );
  }

  let matches = opportunities;
  if (requested) {
    const exact = opportunities.filter((opportunity) => opportunity.id === requested);
    const needle = requested.toLowerCase();
    matches = exact.length
      ? exact
      : opportunities.filter((opportunity) => opportunity.name.toLowerCase().includes(needle));
  }
  if (matches.length === 0) {
    return failure(
      "OPPORTUNITY_NOT_FOUND",
      requested
        ? `No opportunity of ${contact.name} matched "${requested}". Which opportunity did you mean?`
        : `${contact.name} has no opportunities in GoHighLevel.`
    );
  }
  if (matches.length !== 1) {
    return failure(
      "OPPORTUNITY_AMBIGUOUS",
      `${contact.name} has more than one matching opportunity. Which opportunity did you mean?`,
      {
        opportunities: matches.map(({ id, name, status }) => ({ id, name, status })),
      }
    );
  }
  return matches[0];
}

export const findCrmContactTool: ToolDefinition = {
  name: "find_crm_contact",
  description:
    "Search existing GoHighLevel contacts by name, email or phone. Returns at most five reviewable matches. Never creates contacts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Existing contact name, email or phone" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  readOnly: true,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = contactQuery(args.query);
    if (!query) return failure("CONTACT_QUERY_REQUIRED", "Which contact should I look for?");
    const result = await searchContacts(query);
    if (!Array.isArray(result)) return result;
    const contacts = result.slice(0, MAX_CONTACT_RESULTS);
    if (contacts.length === 0) {
      return failure(
        "CONTACT_NOT_FOUND",
        "No existing GoHighLevel contacts matched. Which contact did you mean?"
      );
    }
    return {
      success: true,
      data: contacts,
      displayText: `Found ${contacts.length} matching GoHighLevel contact${contacts.length === 1 ? "" : "s"}`,
    };
  },
};

export const attachNoteToCrmContactTool: ToolDefinition = {
  name: "attach_note_to_crm_contact",
  description:
    "Sync an existing saved note to GoHighLevel as a note on one uniquely matched existing contact, linked to one of that contact's opportunities. Use only when the user explicitly asks for it. Use search_notes to resolve the note ID first. Pass `opportunity` (its name or id) when the contact may have more than one opportunity; without it, the contact's only opportunity is used. If the contact or opportunity is ambiguous or absent, ask the user instead of guessing.",
  parameters: {
    type: "object",
    properties: {
      noteId: { type: "number", description: "ID of the existing saved note" },
      contact: {
        type: "string",
        description: "Name, email or phone that uniquely identifies the contact",
      },
      opportunity: {
        type: "string",
        description:
          "Optional name (or part of it) or id of the contact's opportunity to link the note to",
      },
    },
    required: ["noteId", "contact"],
    additionalProperties: false,
  },
  readOnly: false,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const noteId = args.noteId;
    if (!Number.isInteger(noteId) || Number(noteId) <= 0) {
      return failure("NOTE_ID_REQUIRED", "Which saved note should I attach?");
    }
    const query = contactQuery(args.contact);
    if (!query) return failure("CONTACT_QUERY_REQUIRED", "Which contact should I look for?");
    const contacts = await searchContacts(query);
    if (!Array.isArray(contacts)) return contacts;
    if (contacts.length === 0) {
      return failure(
        "CONTACT_NOT_FOUND",
        "No existing GoHighLevel contact matched. Which contact did you mean?"
      );
    }
    if (contacts.length !== 1) {
      return failure(
        "CONTACT_AMBIGUOUS",
        "More than one GoHighLevel contact matched. Which contact did you mean?",
        { contacts: contacts.slice(0, MAX_CONTACT_RESULTS) }
      );
    }

    const contact = contacts[0];
    const opportunity = await resolveOpportunity(contact, contactQuery(args.opportunity));
    if (!("id" in opportunity)) return opportunity;

    let note;
    try {
      note = await window.electronAPI.getNote(Number(noteId));
    } catch (error) {
      return failure("NOTE_LOOKUP_FAILED", `Failed to load the saved note: ${errorMessage(error)}`);
    }
    if (!note || note.deleted_at)
      return failure("NOTE_NOT_FOUND", `Saved note ${noteId} was not found`);

    try {
      const result = await window.electronAPI.crmSyncNote(Number(noteId), {
        contactId: contact.id,
        opportunityId: opportunity.id,
      });
      if (!("state" in result)) {
        const failed = result as CrmFailure;
        return failure(failed.code ?? "CRM_SYNC_FAILED", failed.error);
      }
      return {
        success: true,
        data: result.state,
        displayText: `Synced "${note.title || `Note ${noteId}`}" to ${contact.name} (${opportunity.name}) in GoHighLevel`,
      };
    } catch (error) {
      return failure("CRM_SYNC_FAILED", `Failed to sync the note: ${errorMessage(error)}`);
    }
  },
};
