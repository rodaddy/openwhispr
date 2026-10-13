// Dictation hotkey activation modes.
//
//   tap    -- a press toggles recording on/off.
//   push   -- recording runs only while the key is held.
//   hybrid -- a short tap latches recording on until the next tap; a press
//             held past HYBRID_TAP_THRESHOLD_MS records while held and stops
//             on release. The same threshold/latch behaviour as the
//             "Automatic (Both)" mode in FluidVoice, reimplemented here.
//
// Pure decisions only; the main-process key handlers own the timers and IPC.
// ESM like the other renderer-shared helpers; main-process callers require() it.

export const ACTIVATION_MODES = Object.freeze(["tap", "push", "hybrid"]);
export const DEFAULT_ACTIVATION_MODE = "hybrid";
export const HYBRID_TAP_THRESHOLD_MS = 400;

export function normalizeActivationMode(mode) {
  return mode === "push" || mode === "hybrid" ? mode : "tap";
}

// Whether the mode needs key-release events (native listeners, push plumbing).
export function usesKeyRelease(mode) {
  return normalizeActivationMode(mode) !== "tap";
}

// The hotkey-manager side only knows tap vs push; hybrid rides on push plumbing.
export function toHotkeyRegistrationMode(mode) {
  return usesKeyRelease(mode) ? "push" : "tap";
}

// A hybrid stop tap this soon after the take began is a double tap, not a
// stop: the take keeps recording instead of collapsing empty (#549).
export const MIN_LATCHED_STOP_MS = 400;

// What a hotkey press does, before any press state exists.
//   "toggle" -- tap mode
//   "stop"   -- hybrid with a latched recording running: this press ends it
//   "ignore" -- hybrid stop tap within MIN_LATCHED_STOP_MS of the take's start
//   "hold"   -- push/hybrid: start the press state machine
// `activeForMs` is how long the current take has been active; unknown is
// treated as long enough to stop.
export function resolveDictationPress({ mode, isRecording = false, activeForMs = Infinity }) {
  const normalized = normalizeActivationMode(mode);
  if (normalized === "tap") return "toggle";
  if (normalized === "hybrid" && isRecording) {
    return activeForMs < MIN_LATCHED_STOP_MS ? "ignore" : "stop";
  }
  return "hold";
}

// How long a press must be held before recording starts. Push needs the delay
// to filter accidental taps; hybrid decides tap-vs-hold on release and can
// record from the press itself, so the user hears the cue immediately.
export function resolveHoldStartDelayMs(mode, holdDelayMs) {
  return normalizeActivationMode(mode) === "hybrid" ? 0 : holdDelayMs;
}

// Native input timestamps are captured before stdout and the main-process
// queue can delay delivery. Prefer them when they form a valid interval.
export function resolveHeldDurationMs({
  pressedEventTimeMs,
  releasedEventTimeMs,
  pressedAtMs,
  releasedAtMs,
}) {
  if (
    Number.isFinite(pressedEventTimeMs) &&
    Number.isFinite(releasedEventTimeMs) &&
    releasedEventTimeMs >= pressedEventTimeMs
  ) {
    return releasedEventTimeMs - pressedEventTimeMs;
  }
  return Math.max(0, releasedAtMs - pressedAtMs);
}

// A press that landed while the previous transcript was still processing is
// held and replayed once the lifecycle returns to idle, instead of vanishing.
export const PENDING_PRESS_TTL_MS = 1500;

export function shouldReplayPendingPress({
  mode,
  pressedAt,
  now,
  released = false,
  ttlMs = PENDING_PRESS_TTL_MS,
}) {
  if (now - pressedAt > ttlMs) return false;
  // Push records only while held: a press already released has nothing to do.
  if (normalizeActivationMode(mode) === "push") return !released;
  return true;
}

// What the release of a tracked press does.
//   "latch"  -- hybrid tap: recording keeps running until the next press
//   "stop"   -- the press was recording: stop now
//   "cancel" -- the press never reached recording: drop the preparation
export function resolveDictationRelease({
  mode,
  heldMs,
  isRecording = false,
  force = false,
  thresholdMs = HYBRID_TAP_THRESHOLD_MS,
}) {
  const normalized = normalizeActivationMode(mode);
  if (!force && normalized === "hybrid" && heldMs < thresholdMs) return "latch";
  return isRecording ? "stop" : "cancel";
}
