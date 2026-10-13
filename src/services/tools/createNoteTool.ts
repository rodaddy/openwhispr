import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveSpace } from "./utils";
import { syncService } from "../SyncService.js";
import {
  normalizeNoteKind,
  revalidateDestination,
  type RequestNoteDestination,
} from "./noteDestination";

export function createNoteTool({
  requestNoteDestination,
  getNoteDestinationCancellationGeneration,
}: {
  requestNoteDestination?: RequestNoteDestination;
  getNoteDestinationCancellationGeneration?: () => number;
} = {}): ToolDefinition {
  return {
    name: "create_note",
    description:
      "Creates a note with title, content, optional folder, and optional space. Meeting and personal note kinds use their existing database-owned defaults. For any other destination, ask the user to choose; use an existing folder only when the user names it, and propose a new folder for explicit confirmation before creation. When space is omitted, the note and its folder stay in the user's private space. To file a note into a team space, pass space explicitly.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The title of the note",
        },
        content: {
          type: "string",
          description: "The content of the note",
        },
        folder: {
          type: "string",
          description:
            "User-chosen folder name, resolved within the target space. A missing folder requires explicit user confirmation before creation.",
        },
        noteType: {
          type: "string",
          enum: ["meeting", "personal"],
          description: "Known note kind. Omit when the destination should be chosen by the user.",
        },
        space: {
          type: "string",
          description:
            "Space name to create the note in. Omit for the user's personal space — required when filing into a team space.",
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const title = args.title as string;
      const content = args.content as string;
      const folderName = typeof args.folder === "string" ? args.folder.trim() : undefined;
      const spaceName = args.space as string | undefined;
      const noteKind = normalizeNoteKind(args.noteType);

      try {
        let spaceId: number | null = null;
        const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
        if (spaceName) {
          const resolved = resolveSpace(spaces, spaceName);
          if (resolved.error) {
            return { success: false, data: null, displayText: resolved.error };
          }
          spaceId = resolved.space.id;
        } else {
          // No space argument means the user's private space: folder resolution
          // must never match a team folder, or the note would silently inherit
          // the team audience (D2 derives space from folder).
          spaceId = spaces.find((s) => s.kind === "private")?.id ?? null;
        }

        let folderId: number | null = null;
        if (folderName) {
          const folders = (await window.electronAPI.getFolders?.(spaceId)) ?? [];
          const matches = folders.filter(
            (folder) =>
              folder.space_id === spaceId && folder.name.toLowerCase() === folderName.toLowerCase()
          );
          if (matches.length === 1) {
            folderId = matches[0].id;
          } else {
            if (!requestNoteDestination) {
              return {
                success: false,
                data: null,
                displayText: "Choose a note destination in the app",
              };
            }
            const cancellationGeneration = getNoteDestinationCancellationGeneration?.();
            const choice = await requestNoteDestination({
              operation: "create",
              noteKind,
              spaceId,
              requestedFolderName: folderName,
              candidateFolders: folders,
            });
            folderId = await revalidateDestination(choice, spaceId);
            if (
              folderId === undefined ||
              (cancellationGeneration !== undefined &&
                cancellationGeneration !== getNoteDestinationCancellationGeneration?.())
            ) {
              return {
                success: false,
                data: null,
                displayText: "Note destination was cancelled or is no longer available",
              };
            }
          }
        } else if (noteKind === "unknown") {
          const folders = (await window.electronAPI.getFolders?.(spaceId)) ?? [];
          if (!requestNoteDestination) {
            return {
              success: false,
              data: null,
              displayText: "Choose a note destination in the app",
            };
          }
          const cancellationGeneration = getNoteDestinationCancellationGeneration?.();
          const choice = await requestNoteDestination({
            operation: "create",
            noteKind,
            spaceId,
            candidateFolders: folders,
          });
          folderId = await revalidateDestination(choice, spaceId);
          if (
            folderId === undefined ||
            (cancellationGeneration !== undefined &&
              cancellationGeneration !== getNoteDestinationCancellationGeneration?.())
          ) {
            return {
              success: false,
              data: null,
              displayText: "Note destination was cancelled or is no longer available",
            };
          }
        }

        const result = await window.electronAPI.saveNote(
          title,
          content,
          noteKind === "unknown" ? "personal" : noteKind,
          null,
          null,
          folderId,
          spaceId
        );

        if (!result.success || !result.note) {
          return { success: false, data: null, displayText: "Failed to create note" };
        }

        if (typeof localStorage !== "undefined") {
          try {
            syncService.debouncedPush("note", result.note.id);
          } catch (error) {
            console.warn("Failed to schedule note sync", error);
          }
        }

        return {
          success: true,
          data: { id: result.note.id, title: result.note.title, folder_id: folderId },
          displayText: `Created note: "${title}"`,
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Failed to create note: ${(error as Error).message}`,
        };
      }
    },
  };
}
