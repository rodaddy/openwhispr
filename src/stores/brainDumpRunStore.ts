import { create } from "zustand";
import { processDumps, type ProcessDumpsDeps } from "../services/brainDumps/processDumps";
import type { BrainDumpResult, NoteItem } from "../types/electron";

export interface BrainDumpResultRow extends BrainDumpResult {
  title: string;
  undone?: boolean;
  /** Why the last Undo was refused; the row stays undoable. */
  undoError?: string;
}

interface BrainDumpRunState {
  progress: { current: number; total: number } | null;
  results: BrainDumpResultRow[];
  error: string | null;
}

export const firstLine = (dump: NoteItem) =>
  (dump.content || dump.title || "").trim().split("\n")[0] || dump.title;

// Brain-dump run state lives at module level, not in BrainDumpsView, so a run
// that is still going when the user switches view keeps its progress and its
// Last run rows (with Undo) for when the view mounts again.
export const useBrainDumpRunStore = create<BrainDumpRunState>()(() => ({
  progress: null,
  results: [],
  error: null,
}));

export async function startBrainDumpRun(deps: Omit<ProcessDumpsDeps, "onProgress">, total: number) {
  const store = useBrainDumpRunStore;
  if (store.getState().progress) return;
  store.setState({ error: null, progress: { current: 0, total } });
  try {
    const outcome = await processDumps({
      ...deps,
      onProgress: (current, count) => store.setState({ progress: { current, total: count } }),
    });
    const titles = new Map(outcome.dumps.map((dump) => [dump.id, firstLine(dump)]));
    store.setState({
      results: outcome.results.map((r) => ({ ...r, title: titles.get(r.noteId) ?? "" })),
    });
  } catch (err) {
    store.setState({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    store.setState({ progress: null });
  }
}

export function setBrainDumpRunError(error: string | null) {
  useBrainDumpRunStore.setState({ error });
}

function updateRow(row: BrainDumpResultRow, patch: Partial<BrainDumpResultRow>) {
  useBrainDumpRunStore.setState(({ results }) => ({
    results: results.map((r) => (r === row ? { ...r, ...patch } : r)),
  }));
}

type UndoReply =
  | { success: true; undone: boolean; error?: string }
  | { success: false; error: string }
  | undefined;

// An Undo the engine refused ({ undone: false, error }) shows on its row and
// stays enabled; it is not marked undone. A failed call is the run's error.
export async function undoBrainDumpRow(
  row: BrainDumpResultRow,
  undo: (actionId: number) => Promise<UndoReply>
) {
  if (row.actionId == null) return;
  const result = await undo(row.actionId);
  if (result?.success === false) return setBrainDumpRunError(result.error);
  if (result && !result.undone && result.error) return updateRow(row, { undoError: result.error });
  updateRow(row, { undone: true, undoError: undefined });
}
