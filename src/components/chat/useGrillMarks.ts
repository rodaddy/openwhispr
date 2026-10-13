import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  nextGrillMark,
  writeGrillMark,
  type GrillMarkValue,
} from "../../services/grill/grillSession";

/** The saved grill the chat is showing: its note, and which line marks which question. */
export interface SavedGrill {
  noteId: number;
  /** Chat message id -> the question id that line marks. */
  targets: Record<string, string>;
}

export interface GrillMarkState {
  mark: GrillMarkValue;
  note: string | null;
}

export interface GrillMarks {
  /** Question id -> Rico's mark on it for this note. */
  marks: Record<string, GrillMarkState>;
  /** Choosing the current mark clears it; any other sets it and keeps the note. */
  choose: (questionId: string, choice: GrillMarkValue) => Promise<boolean>;
  /** Stores a text note beside the question's current mark. */
  saveNote: (questionId: string, note: string) => Promise<boolean>;
}

export interface GrillMarkWriterDeps {
  current: (questionId: string) => GrillMarkState | null;
  apply: (questionId: string, state: GrillMarkState | null) => void;
  persist: (questionId: string, next: GrillMarkState | null) => Promise<boolean>;
  /** The stored mark, or undefined when it could not be read. */
  reload: (questionId: string) => Promise<GrillMarkState | null | undefined>;
}

/**
 * Optimistic mark writes for one note. A refused write is undone only while it
 * is still the latest write for its question, and then from what the store
 * holds, so an older failure never overwrites a newer write (rtech-whisper#134).
 */
export function createGrillMarkWriter(deps: GrillMarkWriterDeps) {
  const latest = new Map<string, number>();
  let sequence = 0;
  return async (questionId: string, next: GrillMarkState | null): Promise<boolean> => {
    const previous = deps.current(questionId);
    const mine = ++sequence;
    latest.set(questionId, mine);
    deps.apply(questionId, next);
    const ok = await deps.persist(questionId, next);
    if (ok || latest.get(questionId) !== mine) return ok;
    const stored = await deps.reload(questionId).catch(() => undefined);
    if (latest.get(questionId) === mine) {
      deps.apply(questionId, stored === undefined ? previous : stored);
    }
    return ok;
  };
}

/**
 * Marks for one saved grill note: read on open, then written through the D1
 * store one question at a time. A refused write puts the old mark back.
 */
export function useGrillMarks(saved: SavedGrill | null): GrillMarks {
  const [marks, setMarks] = useState<Record<string, GrillMarkState>>({});
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const noteId = saved?.noteId ?? null;

  useEffect(() => {
    setMarks({});
    if (noteId == null) return;
    let cancelled = false;
    void Promise.resolve(window.electronAPI?.grillMarksForNote?.(noteId))
      .then((result) => {
        if (cancelled || !result?.success) return;
        const loaded: Record<string, GrillMarkState> = {};
        for (const row of result.marks)
          loaded[row.question_id] = { mark: row.mark, note: row.note };
        setMarks(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const writer = useMemo(() => {
    if (noteId == null) return null;
    return createGrillMarkWriter({
      current: (questionId) => marksRef.current[questionId] ?? null,
      apply: (questionId, state) =>
        setMarks((current) => {
          const { [questionId]: _dropped, ...rest } = current;
          return state ? { ...rest, [questionId]: state } : rest;
        }),
      persist: (questionId, next) =>
        window.electronAPI
          ? writeGrillMark(
              window.electronAPI,
              questionId,
              noteId,
              next?.mark ?? null,
              next?.note ?? null
            )
          : Promise.resolve(false),
      reload: async (questionId) => {
        const result = await window.electronAPI?.grillMarksForNote?.(noteId);
        if (!result?.success) return undefined;
        const row = result.marks.find((m) => m.question_id === questionId);
        return row ? { mark: row.mark, note: row.note } : null;
      },
    });
  }, [noteId]);

  const write = useCallback(
    async (questionId: string, next: GrillMarkState | null) => {
      if (!writer || !window.electronAPI) return false;
      return writer(questionId, next);
    },
    [writer]
  );

  const choose = useCallback(
    (questionId: string, choice: GrillMarkValue) => {
      const current = marksRef.current[questionId] ?? null;
      const mark = nextGrillMark(current?.mark ?? null, choice);
      return write(questionId, mark ? { mark, note: current?.note ?? null } : null);
    },
    [write]
  );

  const saveNote = useCallback(
    (questionId: string, note: string) => {
      const current = marksRef.current[questionId];
      if (!current) return Promise.resolve(false);
      return write(questionId, { mark: current.mark, note: note.trim() || null });
    },
    [write]
  );

  return { marks, choose, saveNote };
}
