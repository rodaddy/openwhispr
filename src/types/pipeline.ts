// The social-media-pipeline connector as the renderer sees it. The bearer
// token is write-only here: settings report hasToken, never the value.
export interface PipelineSettings {
  baseUrl: string;
  hasToken: boolean;
  configured: boolean;
}

export interface PipelineSaveSettingsInput {
  baseUrl: string;
  /** Present to set or clear the token; omitted keeps the saved one. */
  token?: string;
}

export interface PipelineFeedQuestion {
  id: string;
  question: string;
}

export interface PipelineGrillMeta {
  kind: "daily" | "lifetime";
  chapter: number | null;
  startedAt: string | null;
  endedAt: string;
}

export interface PipelineSyncState {
  syncedAt: string | null;
  lastError: string | null;
  piecesAdded: number | null;
  /** The note cannot become a valid session; automatic retries skip it until it is saved again. */
  notSendable?: boolean;
  /** The note holds role-tagged grill turns and can be sent. */
  eligible?: boolean;
}

export type PipelineFailure = {
  success: false;
  error: string;
  code?: string;
  status?: number;
};

export type PipelineSettingsResult =
  { success: true; settings: PipelineSettings } | PipelineFailure;
export type PipelineTestConnectionResult =
  | { success: true; result: "ok"; status: number }
  | { success: true; result: "unauthorized"; status: number }
  | { success: true; result: "unreachable" }
  | PipelineFailure;
export type PipelineQuestionsResult =
  { success: true; configured: boolean; questions: PipelineFeedQuestion[] } | PipelineFailure;
export type PipelineSubmitResult = { success: true; queued: boolean } | PipelineFailure;
export type PipelineSendResult = { success: true; state: PipelineSyncState } | PipelineFailure;
export type PipelineGetSyncStateResult =
  { success: true; state: PipelineSyncState | null } | PipelineFailure;
