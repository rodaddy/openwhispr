// Renderer side of the rTech Whisper hub connection check (rtech-whisper#101).
// Calls GET /api/whoami through the cloud-api-request bridge with the stored
// device key. It reads only whether a key exists and its generation; the key
// itself never reaches the renderer. Nothing here touches sync consent.

import {
  carryHubAuthRejection,
  clearHubAuthRejection,
  getHubModeGeneration,
  isHubAuthRejected,
  noteHubAuthResult,
  refreshHubMode,
} from "../lib/hubMode";

/**
 * After the hub URL or device key is saved or cleared: re-read hub mode and,
 * when it is now on, request a pass right away instead of waiting for the next
 * ambient trigger. Hub mode off requests nothing.
 */
export async function onHubSettingsChanged(sync: {
  requestSyncAll: (reason: "manual") => void;
}): Promise<boolean> {
  const on = await refreshHubMode();
  if (on) sync.requestSyncAll("manual");
  return on;
}

/**
 * Whether the hub rejected the stored device key (rtech-whisper#129). Reads
 * the key generation fresh each call, so a key saved since mount is judged by
 * its own generation. Any failure reads as not rejected.
 */
export async function readHubKeyRejected(): Promise<boolean> {
  try {
    const keyState = await window.electronAPI?.hubGetDeviceKeyState?.();
    const generation = keyState?.generation;
    return (
      Boolean(keyState?.hasKey) &&
      isHubAuthRejected(Number.isSafeInteger(generation) ? (generation as number) : null)
    );
  } catch {
    return false;
  }
}

/**
 * Whether the stored URL is unknown because its load failed (rtech-whisper#200):
 * "untouched" until the user edits the field, then "edited".
 */
export type HubUrlUnknown = "untouched" | "edited" | null;

/**
 * Whether leaving the hub URL field should save it (rtech-whisper#133): never
 * before the stored URL has loaded (null), and only when the user changed it,
 * so a blur alone can never store "off". When the load failed, any edit counts
 * as a change, so an emptied field can still store "off" (#200).
 */
export function hubUrlNeedsSave(
  savedUrl: string | null,
  draft: string,
  urlUnknown: HubUrlUnknown = null
): boolean {
  return savedUrl !== null && (urlUnknown === "edited" || draft !== savedUrl);
}

/**
 * Whether saving this draft switches hubs, which restarts the app
 * (rtech-whisper#126): a non-empty URL other than the saved one. Clearing the
 * URL turns the hub off and restarts nothing. The main process decides the
 * relaunch on the normalized URL; this only decides whether to ask first.
 */
export function isHubSwitchDraft(savedUrl: string | null, draft: string): boolean {
  const url = draft.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(url) && url !== savedUrl;
}

/**
 * Reads the stored hub URL and key presence for the settings page. A failed
 * URL read returns failed=true with an empty URL, so the field unlocks instead
 * of staying disabled with no message (rtech-whisper#148). The two reads settle
 * apart, so a key state that did load still shows Clear key (#200). A failed
 * key-state read leaves the key unknown and reads as a key, so Clear key stays
 * available while sync may still be using one (#220); keyUnknown lets the page
 * say the state is unavailable instead of claiming a saved key (#229).
 * A stored non-loopback http:// URL is hub off (#144): the field shows it with
 * insecure=true, so the page says it must be https://.
 */
export async function loadHubSettings(): Promise<{
  url: string;
  hasKey: boolean;
  keyUnknown: boolean;
  failed: boolean;
  insecure: boolean;
}> {
  const [url, keyState, insecureUrl] = await Promise.allSettled([
    Promise.resolve().then(() => window.electronAPI?.hubGetUrl?.()),
    Promise.resolve().then(() => window.electronAPI?.hubGetDeviceKeyState?.()),
    Promise.resolve().then(() => window.electronAPI?.hubGetInsecureUrl?.()),
  ]);
  const keyUnknown = keyState.status === "rejected";
  const hasKey = keyUnknown || Boolean(keyState.value?.hasKey);
  if (url.status === "rejected") {
    return { url: "", hasKey, keyUnknown, failed: true, insecure: false };
  }
  const insecure = insecureUrl.status === "fulfilled" ? insecureUrl.value || "" : "";
  if (!url.value && insecure) {
    return { url: insecure, hasKey, keyUnknown, failed: false, insecure: true };
  }
  return { url: url.value ?? "", hasKey, keyUnknown, failed: false, insecure: false };
}

/**
 * Saves the hub URL. A successful move to a different hub forgets the auth
 * rejection: the new hub has not judged the key yet (rtech-whisper#175).
 * savedUrl null means the stored URL is unknown (its load failed): it is read
 * fresh before the save, and an unreadable one keeps the rejection (#201).
 */
export async function saveHubUrl(
  draft: string,
  savedUrl: string | null
): Promise<{ success: boolean; url: string; code?: string }> {
  let before: string | undefined = savedUrl ?? undefined;
  if (savedUrl === null) {
    try {
      before = (await window.electronAPI?.hubGetUrl?.()) ?? "";
    } catch {
      before = undefined;
    }
  }
  const result = await window.electronAPI?.hubSaveUrl?.(draft);
  if (!result?.success) return { success: false, url: draft, code: result?.code };
  const url = result.url ?? "";
  if (before !== undefined && url !== before) clearHubAuthRejection();
  return { success: true, url };
}

/**
 * Saves a pasted device key (rtech-whisper#136). saved=false means the key was
 * not stored and the caller keeps the draft so the user can retry. The auth
 * rejection is forgotten only when the key actually changed: re-saving the
 * same key keeps its generation and its verdict (rtech-whisper#187).
 */
export async function saveHubDeviceKey(
  draft: string
): Promise<{ saved: boolean; hasKey: boolean | null }> {
  try {
    const before = await window.electronAPI?.hubGetDeviceKeyState?.();
    const result = await window.electronAPI?.hubSetDeviceKey?.(draft);
    if (!result?.success) return { saved: false, hasKey: null };
    if (result.generation !== before?.generation) clearHubAuthRejection();
    return { saved: true, hasKey: Boolean(result.hasKey) };
  } catch {
    return { saved: false, hasKey: null };
  }
}

/**
 * Clears the stored device key and forgets its rejection (rtech-whisper#214).
 * The rejection goes only when the answer says no key is stored: a key that
 * is still there keeps its verdict and its backoff (#221), carried to the
 * generation the failed clear bumped it to (#233). An IPC failure throws to
 * the caller. Returns whether a key is still stored.
 */
export async function clearHubDeviceKey(): Promise<boolean> {
  const before = getHubModeGeneration();
  const result = await window.electronAPI?.hubClearDeviceKey?.();
  const hasKey = Boolean(result?.hasKey);
  if (!hasKey) clearHubAuthRejection();
  else if (Number.isSafeInteger(result?.generation)) {
    carryHubAuthRejection(before, result?.generation as number);
  }
  return hasKey;
}

/** The hub settings form (rtech-whisper#148 #149 #167). */
export interface HubSettingsForm {
  hubUrl: string;
  /** The stored URL; null until it has loaded, which keeps the field disabled. */
  savedUrl: string | null;
  urlError: "invalid" | "insecure" | "loadFailed" | null;
  /** Set when the stored URL failed to load; cleared once a save stores one (#200). */
  urlUnknown: HubUrlUnknown;
  keyDraft: string;
  hasKey: boolean;
  /** The key state failed to load; hasKey is then true so Clear key shows (#229). */
  keyUnknown: boolean;
  keyError: boolean;
}

export type HubSettingsEvent =
  | { type: "loaded"; url: string; hasKey: boolean; keyUnknown?: boolean; insecure?: boolean }
  | { type: "loadFailed"; hasKey: boolean; keyUnknown?: boolean }
  | { type: "urlEdited"; value: string }
  | { type: "urlSaved"; success: boolean; url?: string; code?: string }
  | { type: "keyEdited"; value: string }
  | { type: "keySaved"; saved: boolean; hasKey: boolean | null }
  | { type: "keyCleared"; hasKey: boolean };

/**
 * The reducer event for a loadHubSettings() result. The page dispatches this
 * as is, so every field the load returns, insecure included (#144), reaches
 * the reducer and a stored http:// URL shows why sync is off.
 */
export function hubSettingsLoadEvent(
  loaded: Awaited<ReturnType<typeof loadHubSettings>>
): HubSettingsEvent {
  const { url, hasKey, keyUnknown, failed, insecure } = loaded;
  return failed
    ? { type: "loadFailed", hasKey, keyUnknown }
    : { type: "loaded", url, hasKey, keyUnknown, insecure };
}

export const INITIAL_HUB_SETTINGS_FORM: HubSettingsForm = {
  hubUrl: "",
  savedUrl: null,
  urlError: null,
  urlUnknown: null,
  keyDraft: "",
  hasKey: false,
  keyUnknown: false,
  keyError: false,
};

// An error describes the value it was about: editing the field, or clearing
// the key, drops it so a stale message never outlives its cause.
export function hubSettingsReducer(
  form: HubSettingsForm,
  event: HubSettingsEvent
): HubSettingsForm {
  switch (event.type) {
    case "loaded":
      return {
        ...form,
        hubUrl: event.url,
        savedUrl: event.url,
        urlError: event.insecure ? "insecure" : form.urlError,
        hasKey: event.hasKey,
        keyUnknown: Boolean(event.keyUnknown),
      };
    case "loadFailed":
      return {
        ...form,
        savedUrl: "",
        urlError: "loadFailed",
        urlUnknown: "untouched",
        hasKey: event.hasKey,
        keyUnknown: Boolean(event.keyUnknown),
      };
    case "urlEdited":
      return {
        ...form,
        hubUrl: event.value,
        urlError: null,
        urlUnknown: form.urlUnknown ? "edited" : null,
      };
    case "urlSaved":
      return event.success
        ? {
            ...form,
            hubUrl: event.url ?? "",
            savedUrl: event.url ?? "",
            urlError: null,
            urlUnknown: null,
          }
        : { ...form, urlError: event.code === "INSECURE_HUB_URL" ? "insecure" : "invalid" };
    case "keyEdited":
      return { ...form, keyDraft: event.value, keyError: false };
    case "keySaved":
      return event.saved
        ? {
            ...form,
            keyDraft: "",
            keyError: false,
            hasKey: Boolean(event.hasKey),
            keyUnknown: false,
          }
        : { ...form, keyError: true };
    case "keyCleared":
      return { ...form, keyError: false, hasKey: event.hasKey, keyUnknown: false };
  }
}

export type HubConnectionResult =
  | { ok: true; deviceName: string; deviceId: string }
  | { ok: false; reason: "noUrl" | "noKey" | "unauthorized" | "error"; error?: string };

interface WhoamiResponse {
  device?: { id?: unknown; name?: unknown };
}

export async function testHubConnection(): Promise<HubConnectionResult> {
  const api = window.electronAPI;
  const url = await api?.hubGetUrl?.();
  if (!url) return { ok: false, reason: "noUrl" };
  const keyState = await api?.hubGetDeviceKeyState?.();
  if (!keyState?.hasKey) return { ok: false, reason: "noKey" };

  const result = (await api?.cloudApiRequest?.({
    method: "GET",
    path: "/api/whoami",
    expectedAuthGeneration: keyState.generation,
  })) as { success: boolean; data?: unknown; status?: number; error?: string } | undefined;
  // Test's whoami answer counts like any hub answer (rtech-whisper#129): a 401
  // marks the key rejected, a success lifts the rejection and its backoff.
  noteHubAuthResult(result, Number.isSafeInteger(keyState.generation) ? keyState.generation : null);

  if (!result?.success) {
    if (result?.status === 401) return { ok: false, reason: "unauthorized" };
    return { ok: false, reason: "error", error: result?.error ?? "Hub request failed" };
  }
  const device = (result.data as WhoamiResponse | null)?.device;
  if (typeof device?.name !== "string" || typeof device?.id !== "string") {
    return { ok: false, reason: "error", error: "Unexpected whoami response" };
  }
  return { ok: true, deviceName: device.name, deviceId: device.id };
}
