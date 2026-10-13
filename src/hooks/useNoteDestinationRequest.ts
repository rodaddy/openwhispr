import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NoteDestinationRequest,
  NoteDestinationResult,
  RequestNoteDestination,
} from "../services/tools/noteDestination";
import { runNoteFolderCreation } from "../services/tools/noteDestination";

export type PendingNoteDestination = {
  id: number;
  request: NoteDestinationRequest;
  resolve: (result: NoteDestinationResult) => void;
  creating: boolean;
  error: string;
};

type CreateFolder = (
  name: string,
  spaceId: number | null
) => ReturnType<typeof window.electronAPI.createFolder>;

const stripTerminalSpokenPunctuation = (value: string) =>
  value
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();

const normalizeSpokenValue = (value: string) =>
  stripTerminalSpokenPunctuation(value).replace(/\s+/g, " ").toLowerCase();

const stripFolderSelectionPrefix = (value: string) =>
  value.replace(/^(?:use|choose|select)\s+/i, "").trim();

export function getPanelCloseCancellation(previousOpen: boolean, open: boolean) {
  return previousOpen && !open ? "panel-closed" : null;
}

export class NoteDestinationRequestController {
  pending: PendingNoteDestination | null = null;
  cancellationGeneration = 0;
  private nextId = 1;
  private creationLock = { current: false };
  private onChange: (pending: PendingNoteDestination | null) => void = () => {};

  constructor(
    private createFolder: CreateFolder = (name, spaceId) =>
      window.electronAPI.createFolder(name, spaceId)
  ) {}

  private publish() {
    this.onChange(this.pending);
  }

  subscribe(onChange: (pending: PendingNoteDestination | null) => void) {
    this.onChange = onChange;
    onChange(this.pending);
    return () => {
      this.onChange = () => {};
    };
  }

  request: RequestNoteDestination = (request) => {
    this.pending?.resolve({ kind: "cancelled", reason: "superseded" });
    return new Promise((resolve) => {
      this.pending = { id: this.nextId++, request, resolve, creating: false, error: "" };
      this.publish();
    });
  };

  settle = (id: number, result: NoteDestinationResult) => {
    if (this.pending?.id !== id) return;
    const current = this.pending;
    this.pending = null;
    this.publish();
    current.resolve(result);
  };

  resolveUserResult = (id: number, result: NoteDestinationResult) => {
    if (this.pending?.id !== id) return;
    if (result.kind === "cancelled") {
      this.cancel(result.reason);
      return;
    }
    if (this.pending.creating) return;
    this.settle(id, result);
  };

  cancel = (reason = "cancelled") => {
    this.cancellationGeneration += 1;
    if (this.pending) this.settle(this.pending.id, { kind: "cancelled", reason });
  };

  confirmFolderCreation = async (folderName?: string) => {
    const current = this.pending;
    const name = (folderName ?? current?.request.requestedFolderName ?? "").trim();
    if (!current || !name || this.creationLock.current) return false;

    const requestId = current.id;
    const spaceId = current.request.spaceId;
    this.pending = {
      ...current,
      request: { ...current.request, requestedFolderName: name },
      creating: true,
      error: "",
    };
    this.publish();

    await runNoteFolderCreation({
      lock: this.creationLock,
      create: () => this.createFolder(name, spaceId),
      onSuccess: (folder) => {
        if (this.pending?.id !== requestId) return;
        if (folder.space_id !== spaceId) {
          this.pending = {
            ...this.pending,
            error: "Created folder is no longer available in this space",
          };
          this.publish();
          return;
        }
        this.settle(requestId, { kind: "created", folder });
      },
      onError: (message) => {
        if (this.pending?.id !== requestId) return;
        this.pending = { ...this.pending, error: message };
        this.publish();
      },
    });

    if (this.pending?.id === requestId) {
      this.pending = { ...this.pending, creating: false };
      this.publish();
    }
    return true;
  };

  resolveVoiceCommand = (spokenText: string) => {
    const current = this.pending;
    if (!current) return false;

    const normalized = normalizeSpokenValue(spokenText);
    if (normalized === "cancel") {
      this.cancel("voice-cancelled");
      return true;
    }
    if (current.creating) return true;
    if (normalized === "yes" || normalized === "confirm") {
      void this.confirmFolderCreation();
      return true;
    }

    const createMatch = spokenText.trim().match(/^create folder\s+(.+)$/i);
    if (createMatch) {
      const proposedName = stripTerminalSpokenPunctuation(createMatch[1]);
      if (!proposedName) return true;
      this.pending = {
        ...current,
        request: { ...current.request, requestedFolderName: proposedName },
        error: "",
      };
      this.publish();
      return true;
    }

    const requestedName = normalizeSpokenValue(stripFolderSelectionPrefix(spokenText));
    const matches = current.request.candidateFolders.filter(
      (folder) => normalizeSpokenValue(folder.name) === requestedName
    );
    if (matches.length === 1) {
      const folder = matches[0];
      this.settle(current.id, {
        kind: "existing",
        folderId: folder.id,
        spaceId: folder.space_id,
      });
    }
    return true;
  };
}

export function useNoteDestinationRequest() {
  const [pending, setPending] = useState<PendingNoteDestination | null>(null);
  const controllerRef = useRef<NoteDestinationRequestController | null>(null);
  if (!controllerRef.current) controllerRef.current = new NoteDestinationRequestController();
  const controller = controllerRef.current;
  const settle = useCallback(
    (id: number, result: NoteDestinationResult) => controller.resolveUserResult(id, result),
    [controller]
  );
  const cancel = useCallback((reason?: string) => controller.cancel(reason), [controller]);
  const getCancellationGeneration = useCallback(
    () => controller.cancellationGeneration,
    [controller]
  );
  const requestNoteDestination = useCallback<RequestNoteDestination>(
    (request) => controller.request(request),
    [controller]
  );
  const resolveVoiceCommand = useCallback(
    (spokenText: string) => controller.resolveVoiceCommand(spokenText),
    [controller]
  );
  const confirmFolderCreation = useCallback(
    (folderName?: string) => controller.confirmFolderCreation(folderName),
    [controller]
  );

  useEffect(() => controller.subscribe(setPending), [controller]);

  useEffect(() => () => cancel("unmounted"), [cancel]);

  return {
    pending,
    requestNoteDestination,
    settle,
    cancel,
    getCancellationGeneration,
    resolveVoiceCommand,
    confirmFolderCreation,
  };
}

export type NoteDestinationRequestState = ReturnType<typeof useNoteDestinationRequest>;
