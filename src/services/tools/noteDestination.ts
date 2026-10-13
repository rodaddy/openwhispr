export type NoteKind = "meeting" | "personal" | "unknown";

export interface NoteDestinationFolder {
  id: number;
  name: string;
  space_id: number | null;
  is_default?: number | boolean;
}

export interface NoteDestinationRequest {
  operation: "create" | "move";
  noteId?: number;
  noteKind: NoteKind;
  spaceId: number | null;
  requestedFolderName?: string;
  candidateFolders: NoteDestinationFolder[];
}

export type NoteDestinationResult =
  | { kind: "existing"; folderId: number; spaceId: number | null }
  | { kind: "created"; folder: NoteDestinationFolder }
  | { kind: "cancelled"; reason: string };

export type RequestNoteDestination = (
  request: NoteDestinationRequest
) => Promise<NoteDestinationResult>;

export async function runNoteFolderCreation({
  lock,
  create,
  onSuccess,
  onError,
}: {
  lock: { current: boolean };
  create: () => Promise<Awaited<ReturnType<typeof window.electronAPI.createFolder>>>;
  onSuccess: (
    folder: NonNullable<Awaited<ReturnType<typeof window.electronAPI.createFolder>>["folder"]>
  ) => void;
  onError: (message: string) => void;
}) {
  if (lock.current) return false;
  lock.current = true;
  try {
    const result = await create();
    if (result.success && result.folder) onSuccess(result.folder);
    else onError(result.error || "Failed to create folder");
  } catch (error) {
    onError(error instanceof Error ? error.message : "Failed to create folder");
  } finally {
    lock.current = false;
  }
  return true;
}

export function normalizeNoteKind(value: unknown): NoteKind {
  return value === "meeting" || value === "personal" ? value : "unknown";
}

export async function revalidateDestination(
  result: NoteDestinationResult,
  spaceId: number | null
): Promise<number | null | undefined> {
  if (result.kind === "cancelled") return undefined;
  if (result.kind === "created") {
    return result.folder.space_id === spaceId ? result.folder.id : undefined;
  }
  const folderId = result.folderId;
  const resultSpaceId = result.spaceId;
  if (resultSpaceId !== spaceId) return undefined;
  const folders = (await window.electronAPI.getFolders?.(spaceId)) ?? [];
  const folder = folders.find((candidate) => candidate.id === folderId);
  return folder && folder.space_id === spaceId ? folder.id : undefined;
}
