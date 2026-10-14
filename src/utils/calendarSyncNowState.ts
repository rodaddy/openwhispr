// Result -> UI state for the calendar "Sync now" button.

export const SYNC_NOW_ERROR_MAX_LENGTH = 200;

export type SyncNowState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "synced"; at: number }
  | { status: "error"; message: string };

export type SyncNowStatusLine =
  | { kind: "synced"; key: "syncedJustNow" }
  | { kind: "synced"; key: "syncedMinutesAgo" | "syncedHoursAgo"; count: number }
  | { kind: "error"; text: string }
  | { kind: "error"; key: "syncFailed" };

function truncate(text: string): string {
  if (text.length <= SYNC_NOW_ERROR_MAX_LENGTH) return text;
  return `${text.slice(0, SYNC_NOW_ERROR_MAX_LENGTH - 1)}…`;
}

export function syncNowStateFromResult(
  result: { success: boolean; error?: string } | null | undefined,
  now: number
): SyncNowState {
  if (result?.success) return { status: "synced", at: now };
  return { status: "error", message: truncate((result?.error ?? "").trim()) };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export function syncNowStatusLine(state: SyncNowState, now: number): SyncNowStatusLine | null {
  if (state.status === "error") {
    return state.message
      ? { kind: "error", text: state.message }
      : { kind: "error", key: "syncFailed" };
  }
  if (state.status !== "synced") return null;
  const elapsed = Math.max(0, now - state.at);
  if (elapsed < MINUTE_MS) return { kind: "synced", key: "syncedJustNow" };
  if (elapsed < HOUR_MS) {
    return { kind: "synced", key: "syncedMinutesAgo", count: Math.floor(elapsed / MINUTE_MS) };
  }
  return { kind: "synced", key: "syncedHoursAgo", count: Math.floor(elapsed / HOUR_MS) };
}
