import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { NoteDestinationResult } from "../../services/tools/noteDestination";
import type { PendingNoteDestination } from "../../hooks/useNoteDestinationRequest";

export function NoteDestinationDialog({
  pending,
  onResolve,
  onCreateFolder,
}: {
  pending: PendingNoteDestination | null;
  onResolve: (requestId: number, result: NoteDestinationResult) => void;
  onCreateFolder: (folderName?: string) => Promise<boolean>;
}) {
  const [folderName, setFolderName] = useState("");
  const request = pending?.request ?? null;
  useEffect(() => {
    setFolderName(request?.requestedFolderName ?? "");
  }, [pending?.id, request?.requestedFolderName]);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) =>
        !open && pending && onResolve(pending.id, { kind: "cancelled", reason: "dismissed" })
      }
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose a note destination</DialogTitle>
          <DialogDescription>
            Select an existing folder or create one after confirming its name.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-56 gap-2 overflow-y-auto">
          {request?.candidateFolders.map((folder) => (
            <Button
              key={folder.id}
              type="button"
              variant="outline"
              onClick={() =>
                pending &&
                onResolve(pending.id, {
                  kind: "existing",
                  folderId: folder.id,
                  spaceId: folder.space_id,
                })
              }
            >
              {folder.name}
            </Button>
          ))}
        </div>
        <input
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={folderName}
          onChange={(event) => setFolderName(event.target.value)}
          placeholder="New folder name"
          aria-label="New folder name"
        />
        {pending?.error && (
          <p role="alert" className="text-sm text-destructive">
            {pending.error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => pending && onResolve(pending.id, { kind: "cancelled", reason: "user" })}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!folderName.trim() || pending?.creating}
            onClick={() => void onCreateFolder(folderName)}
          >
            {pending?.creating ? "Creating…" : "Create folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
