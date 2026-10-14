// Hub mode: sync runs against the rTech Whisper hub
// exactly when a hub URL AND a device key are set. The device key replaces the
// sign-in session, so hub mode never has a user id and never goes near the
// account-scope reconcile (authAccountScope), whose "purge" deletes local rows.

import { swapHubCursors } from "./hubCursors";

export interface HubModeState {
  hasUrl: boolean;
  hasKey: boolean;
  /** tokenStore generation of the device key; the request fence. */
  generation: number | null;
}

const OFF: HubModeState = { hasUrl: false, hasKey: false, generation: null };
let state: HubModeState = OFF;

export function isHubMode(): boolean {
  return state.hasUrl && state.hasKey && state.generation != null;
}

/** The generation SyncService fences hub requests on, or null outside hub mode. */
export function getHubModeGeneration(): number | null {
  return isHubMode() ? state.generation : null;
}

export function setHubModeState(next: HubModeState): void {
  state = { ...next };
}

/**
 * Re-read the hub URL and device-key presence from the main process. Any
 * failure reads as hub mode off: turning sync off deletes nothing.
 */
export async function refreshHubMode(): Promise<boolean> {
  try {
    const api = typeof window === "undefined" ? undefined : window.electronAPI;
    const [url, keyState] = await Promise.all([api?.hubGetUrl?.(), api?.hubGetDeviceKeyState?.()]);
    const generation = keyState?.generation;
    if (typeof url === "string" && url) swapHubCursors(url);
    setHubModeState({
      hasUrl: typeof url === "string" && url.length > 0,
      hasKey: Boolean(keyState?.hasKey),
      generation: Number.isSafeInteger(generation) ? (generation as number) : null,
    });
  } catch {
    setHubModeState(OFF);
  }
  return isHubMode();
}

// A hub 401 (revoked or mistyped device key) is recorded
// in localStorage so every window sees it, against the renderer's current key
// generation (Test passes the generation it sent). A late 401 for an old key
// cannot land on a new one only because the main process fences it
// (cloudApiRequest.js assertCurrent) before replying.
// Ambient sync passes back off while it stands, and the settings page says the
// key was rejected. A new key is a new generation, which clears it.
const AUTH_REJECTED_KEY = "hubSync.authRejected";
export const HUB_AUTH_BACKOFF_MS = 10 * 60_000;

interface HubAuthRejection {
  generation: number;
  at: number;
}

function storage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function readHubAuthRejection(): HubAuthRejection | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(AUTH_REJECTED_KEY) ?? "null");
    return Number.isSafeInteger(parsed?.generation) && Number.isFinite(parsed?.at) ? parsed : null;
  } catch {
    return null;
  }
}

// Listeners for a change to the rejection record: the
// settings page reads it live instead of once on mount.
const rejectionListeners = new Set<() => void>();

function notifyRejectionChanged(): void {
  for (const listener of rejectionListeners) {
    try {
      listener();
    } catch {
      // A broken listener must not stop the others or the request path.
    }
  }
}

/**
 * Calls `listener` whenever the rejection record changes, in this window or
 * (through the storage event) in another. Returns the unsubscribe function.
 */
export function subscribeHubAuthRejection(listener: () => void): () => void {
  rejectionListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUTH_REJECTED_KEY || event.key === null) listener();
  };
  const win = typeof window === "undefined" ? undefined : window;
  win?.addEventListener?.("storage", onStorage);
  return () => {
    rejectionListeners.delete(listener);
    win?.removeEventListener?.("storage", onStorage);
  };
}

// Recording a rejection is bookkeeping: a storage failure (quota, security)
// must not turn the hub's answer into a different error.
function writeRejection(value: HubAuthRejection | null): void {
  try {
    if (value) storage()?.setItem(AUTH_REJECTED_KEY, JSON.stringify(value));
    else storage()?.removeItem(AUTH_REJECTED_KEY);
  } catch {
    return;
  }
  notifyRejectionChanged();
}

/**
 * Records a hub answer for a key generation. The rule is deliberately simple:
 * a 401 records the rejection at its arrival
 * time, always; a success clears the record when it is for the same key
 * generation. Responses are not ordered by send time, so two races are
 * accepted: a stale 200 arriving after a newer 401 clears it (costing at most
 * one extra ambient pass, whose own 401 records it again), and a stale 401
 * arriving after a newer 200 records it (costing at most one backoff window,
 * which the next success or its expiry lifts). Both self-heal.
 * The generation defaults to the current hub-mode generation; Test passes the
 * generation it sent so its answer counts even before hub mode is re-read.
 */
export function noteHubAuthResult(
  result: { success?: boolean; status?: number } | undefined,
  generation: number | null = getHubModeGeneration()
): void {
  if (generation == null) return;
  if (result?.status === 401) {
    writeRejection({ generation, at: Date.now() });
  } else if (result?.success && readHubAuthRejection()?.generation === generation) {
    writeRejection(null);
  }
}

/**
 * Forgets a rejection when the key is replaced or cleared, or the hub URL
 * changes. Generations restart with the app, so a stale record must not
 * outlive the key it was about.
 */
export function clearHubAuthRejection(): void {
  writeRejection(null);
}

/**
 * Moves a rejection from one key generation to another, keeping its time:
 * a failed clear bumps the generation of a key that did
 * not change, and the hub's verdict on that key must follow it.
 */
export function carryHubAuthRejection(from: number | null, to: number): void {
  const rejection = readHubAuthRejection();
  if (from == null || from === to || rejection?.generation !== from) return;
  writeRejection({ generation: to, at: rejection.at });
}

/** Whether the hub rejected the key with this generation (default: the current one). */
export function isHubAuthRejected(generation: number | null = getHubModeGeneration()): boolean {
  const rejection = readHubAuthRejection();
  return generation != null && rejection?.generation === generation;
}

/** Whether ambient passes should wait: the current key was rejected recently. */
export function isHubAuthBackingOff(now = Date.now()): boolean {
  const rejection = readHubAuthRejection();
  if (!isHubAuthRejected() || rejection == null) return false;
  // A record from the future (the clock stepped back) counts as expired.
  const age = now - rejection.at;
  return age >= 0 && age < HUB_AUTH_BACKOFF_MS;
}

export function resetHubModeForTests(): void {
  state = OFF;
  rejectionListeners.clear();
}
