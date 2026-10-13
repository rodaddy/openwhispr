import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { syncService } from "../SyncService.js";
import {
  normalizeNoteKind,
  revalidateDestination,
  type RequestNoteDestination,
} from "./noteDestination";

export function updateNoteTool({
  requestNoteDestination,
  getNoteDestinationCancellationGeneration,
}: {
  requestNoteDestination?: RequestNoteDestination;
  getNoteDestinationCancellationGeneration?: () => number;
} = {}): ToolDefinition {
  return {
    name: "update_note",
    description:
      "Before moving to a folder, always call list_folders first. Reuse an existing folder whenever one is a reasonable semantic fit for the note's topic, even if the user didn't name it. Only pass a new folder name when nothing existing fits. Updates a note's title, content, or folder (auto-created if missing). Use the note ID from context if provided; otherwise search_notes first.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The note ID to update",
        },
        title: {
          type: "string",
          description: "New title for the note (optional)",
        },
        content: {
          type: "string",
          description: "New content for the note (optional)",
        },
        folder: {
          type: "string",
          description:
            "Folder name to move the note to. Created automatically if it does not exist.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const id = args.id as number;
      const title = args.title as string | undefined;
      const content = args.content as string | undefined;
      const folderName = typeof args.folder === "string" ? args.folder.trim() : undefined;

      if (!title && !content && !folderName) {
        return {
          success: false,
          data: null,
          displayText: "At least one of title, content, or folder must be provided",
        };
      }

      try {
        const note = await window.electronAPI.getNote(id);
        if (!note) {
          return { success: false, data: null, displayText: `Note with ID ${id} not found` };
        }

        const updates: Record<string, string | number | null> = {};
        if (title) updates.title = title;
        if (content) updates.content = content;

        if (folderName) {
          const folders = (await window.electronAPI.getFolders?.(note.space_id)) ?? [];
          const matches = folders.filter(
            (folder) =>
              folder.space_id === note.space_id &&
              folder.name.toLowerCase() === folderName.toLowerCase()
          );
          let folderId: number | undefined;
          if (matches.length === 1) folderId = matches[0].id;
          else {
            if (!requestNoteDestination)
              return {
                success: false,
                data: null,
                displayText: "Choose a note destination in the app",
              };
            const cancellationGeneration = getNoteDestinationCancellationGeneration?.();
            const choice = await requestNoteDestination({
              operation: "move",
              noteId: id,
              noteKind: normalizeNoteKind(note.note_type),
              spaceId: note.space_id,
              requestedFolderName: folderName,
              candidateFolders: folders,
            });
            folderId = await revalidateDestination(choice, note.space_id);
            if (
              folderId === undefined ||
              (cancellationGeneration !== undefined &&
                cancellationGeneration !== getNoteDestinationCancellationGeneration?.())
            )
              return {
                success: false,
                data: null,
                displayText: "Note destination was cancelled or is no longer available",
              };
          }
          updates.folder_id = folderId;
        }

        const result = await window.electronAPI.updateNote(id, updates);

        if (!result.success) {
          return { success: false, data: null, displayText: "Failed to update note" };
        }

        if (typeof localStorage !== "undefined") {
          try {
            syncService.debouncedPush("note", id);
          } catch (error) {
            console.warn("Failed to schedule note sync", error);
          }
        }

        return {
          success: true,
          data: { id, title: title || note.title },
          displayText: `Updated note: "${title || note.title}"`,
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Failed to update note: ${(error as Error).message}`,
        };
      }
    },
  };
}
