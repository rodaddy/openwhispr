import { cloudGet, cloudPost, cloudDelete } from "./cloudApi.js";

interface TranscriptionInput {
  client_transcription_id?: string;
  text: string;
  raw_text?: string | null;
  provider?: string | null;
  model?: string | null;
  language?: string | null;
  audio_duration_ms?: number | null;
  status?: string;
  created_at?: string;
}

interface CloudTranscription {
  id: string;
  client_transcription_id: string | null;
  text: string;
  raw_text: string | null;
  word_count: number;
  source: string;
  provider: string | null;
  model: string | null;
  language: string | null;
  audio_duration_ms: number | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function create(transcription: TranscriptionInput): Promise<CloudTranscription> {
  return cloudPost<CloudTranscription>("/api/transcriptions/create", transcription);
}

async function batchCreate(
  transcriptions: TranscriptionInput[]
): Promise<{ created: CloudTranscription[] }> {
  return cloudPost<{ created: CloudTranscription[] }>("/api/transcriptions/batch-create", {
    transcriptions,
  });
}

// `cursorId` is the id of the row the cursor stamp came from: the hub resumes
// strictly after (since) or before (before) that (stamp, id) pair, so a run of
// rows sharing one stamp pages without a skip or a repeat. It rides as
// `since_id` or `before_id`, and only alongside its stamp.
async function list(
  limit?: number,
  before?: string,
  since?: string,
  cursorId?: string
): Promise<{ transcriptions: CloudTranscription[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  if (since !== undefined) params.set("since", since);
  if (cursorId) {
    if (before !== undefined) params.set("before_id", cursorId);
    else if (since !== undefined) params.set("since_id", cursorId);
  }
  const query = params.toString();
  return cloudGet<{ transcriptions: CloudTranscription[] }>(
    `/api/transcriptions/list${query ? `?${query}` : ""}`
  );
}

async function deleteTranscription(id: string): Promise<void> {
  await cloudDelete("/api/transcriptions/delete", { id });
}

async function batchDelete(ids: string[]): Promise<{ deleted: string[] }> {
  return cloudPost<{ deleted: string[] }>("/api/transcriptions/batch-delete", { ids });
}

export { create, batchCreate, list, deleteTranscription, batchDelete };

export const TranscriptionsService = {
  create,
  batchCreate,
  list,
  delete: deleteTranscription,
  batchDelete,
};
