const LLM_REQUEST_TIMEOUT_SECONDS = 30;
const LLM_STREAMING_TIMEOUT_SECONDS = 60;

// Note and action generation send whole transcripts (a 1h meeting is ~150K
// chars) through a non-streaming request, so their wait grows with the input.
const LONG_INPUT_TIMEOUT_FLOOR_SECONDS = 60;
const LONG_INPUT_TIMEOUT_CEILING_SECONDS = 600;
const LONG_INPUT_SECONDS_PER_10K_CHARS = 30;

/** @param {{ streaming?: boolean, timeoutSeconds?: number }} [options] */
export function getLlmRequestTimeoutSeconds({ streaming = false, timeoutSeconds } = {}) {
  if (typeof timeoutSeconds === "number" && timeoutSeconds > 0) return timeoutSeconds;
  return streaming ? LLM_STREAMING_TIMEOUT_SECONDS : LLM_REQUEST_TIMEOUT_SECONDS;
}

/** @param {number} inputChars */
export function getLongInputTimeoutSeconds(inputChars) {
  const chars = Number.isFinite(inputChars) && inputChars > 0 ? inputChars : 0;
  const scaled =
    LONG_INPUT_TIMEOUT_FLOOR_SECONDS +
    Math.ceil((chars / 10_000) * LONG_INPUT_SECONDS_PER_10K_CHARS);
  return Math.min(LONG_INPUT_TIMEOUT_CEILING_SECONDS, scaled);
}
