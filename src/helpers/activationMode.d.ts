export type ActivationMode = "tap" | "push" | "hybrid";
export const ACTIVATION_MODES: readonly ActivationMode[];
export const DEFAULT_ACTIVATION_MODE: ActivationMode;
export const HYBRID_TAP_THRESHOLD_MS: number;
export const MIN_LATCHED_STOP_MS: number;
export function normalizeActivationMode(mode: unknown): ActivationMode;
export function usesKeyRelease(mode: unknown): boolean;
export function toHotkeyRegistrationMode(mode: unknown): "tap" | "push";
export function resolveDictationPress(input: {
  mode: unknown;
  isRecording?: boolean;
  activeForMs?: number;
}): "toggle" | "stop" | "ignore" | "hold";
export function resolveDictationRelease(input: {
  mode: unknown;
  heldMs: number;
  isRecording?: boolean;
  force?: boolean;
  thresholdMs?: number;
}): "latch" | "stop" | "cancel";
export function resolveHeldDurationMs(input: {
  pressedEventTimeMs?: number;
  releasedEventTimeMs?: number;
  pressedAtMs: number;
  releasedAtMs: number;
}): number;
