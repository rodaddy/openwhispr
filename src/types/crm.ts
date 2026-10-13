export interface CrmContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  companyName?: string;
}

export type CrmOpportunityStatus = "open" | "won" | "lost" | "abandoned";

export interface CrmOpportunity {
  id: string;
  name: string;
  status: CrmOpportunityStatus;
  pipelineId: string;
  pipelineStageId: string;
  monetaryValue?: number;
}

export interface CrmSyncTarget {
  contactId: string;
  opportunityId: string;
}

export interface CrmSettings {
  configured: boolean;
  hasToken: boolean;
  locationId: string;
}

/** `token` undefined keeps the stored token; "" or null removes it. */
export interface CrmSaveSettingsInput {
  token?: string | null;
}

export interface CrmSyncState {
  noteId: string;
  contactId: string;
  opportunityId: string;
  syncedAt: string;
  url: string;
}

export type CrmFailure = {
  success: false;
  error: string;
  code?: string;
  status?: number;
};

export type CrmSettingsResult = { success: true; settings: CrmSettings } | CrmFailure;
export type CrmTestConnectionResult = { success: true; locationName: string } | CrmFailure;
export type CrmSearchContactsResult = { success: true; contacts: CrmContact[] } | CrmFailure;
export type CrmListOpportunitiesResult =
  { success: true; opportunities: CrmOpportunity[] } | CrmFailure;
export type CrmSyncResult = { success: true; state: CrmSyncState } | CrmFailure;
export type CrmGetSyncStateResult = { success: true; state: CrmSyncState | null } | CrmFailure;
