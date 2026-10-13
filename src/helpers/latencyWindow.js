// ESM like analytics.js: the renderer imports this module.
export const LATENCY_WINDOW_SIZE = 10;

// Adds one dictation latency to the window of the newest `size` values
// (oldest first) and returns the window with its last value and rounded mean.
// A value that is not a finite number above 0 changes nothing.
export function pushLatency(samples, ms, size = LATENCY_WINDOW_SIZE) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { samples, lastMs: null, averageMs: null };
  }
  const next = [...samples, ms].slice(-size);
  const averageMs = Math.round(next.reduce((sum, value) => sum + value, 0) / next.length);
  return { samples: next, lastMs: ms, averageMs };
}
