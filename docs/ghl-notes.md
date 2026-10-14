# Sync to CRM: GoHighLevel notes

"Sync to CRM" sends a note to GoHighLevel (GHL), as a note on a contact that is
linked to one of that contact's opportunities. It replaces the old in-house CRM
connector.

## Account and token

- One sub-account only. Its location id comes from the SDK's `ACCOUNTS`
  profile named by `GHL_ACCOUNT` (default `rtech`, the author's; see README,
  "CRM connector"); the app does not ask for it. The SDK is an optional install:
  without it the CRM channels fail with code `NOT_INSTALLED`.
- The user pastes a GHL Private Integration token (PIT) in Settings >
  Integrations > GoHighLevel. It is stored in the encrypted secret store under
  `GHL_PRIVATE_TOKEN` and never goes back to the renderer.

## Flow

1. Search a contact (`crm-search-contacts`).
2. Pick one of its opportunities (`crm-list-opportunities`).
3. Sync (`crm-sync-note`). The first sync creates a GHL note on the contact
   with the opportunity in its relations; a later sync updates the same GHL
   note. Syncing a note to a different contact fails with `TARGET_CHANGED`.

## IPC channels

All return `{ success: true, <key> }` or `{ success: false, error, code?, status? }`.

| Channel                  | Arguments                              | Success key     |
| ------------------------ | -------------------------------------- | --------------- |
| `crm-get-settings`       |                                        | `settings`      |
| `crm-save-settings`      | `{ token }`                            | `settings`      |
| `crm-test-connection`    |                                        | `locationName`  |
| `crm-search-contacts`    | `query`                                | `contacts`      |
| `crm-list-opportunities` | `contactId`                            | `opportunities` |
| `crm-sync-note`          | `noteId, { contactId, opportunityId }` | `state`         |
| `crm-get-sync-state`     | `noteId`                               | `state`         |

Error codes: `NOT_CONFIGURED`, `QUERY_REQUIRED`, `INVALID_TARGET`,
`NOTE_NOT_FOUND`, `TARGET_CHANGED`, `SETTINGS_CHANGED`, `AUTH_FAILED`,
`RATE_LIMITED`, `TIMEOUT`, `GHL_ERROR`. Messages never carry the token or
GHL's raw response text.

## Stored link

The note row keeps the GHL note id (`crm_activity_id`), the contact id
(`crm_target_id`), the opportunity id (`crm_opportunity_id`), the sync time
and a `ghl:` scope. Links left by the old CRM are cleared once at startup.
