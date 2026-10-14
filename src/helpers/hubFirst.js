const { normalizeHubUrl } = require("./hubSync");

// Hub-first voice calls (hub protocol section 10). The hub
// is tried first; the self-hosted server is called directly only when the hub is unreachable
// (network error, client timeout) or answers 408/502/503/504 (protocol 10.7;
// 408 is the hub's request_timeout, and 10.7 falls back on "a timeout").
// A 429 is retried against the hub with backoff that honors Retry-After
// (protocol 10.5; the per-key in-flight cap is 2, 10.3) and never falls back
// to direct (10.7). Every other hub answer, including 400/401/413/415 and a
// 429 that outlasts the retry bound, is final and throws.

const TRANSCRIPTION_PATH = "/api/voice/v1/audio/transcriptions";
const SYNTHESIS_PATH = "/api/voice/upstream/omnivoice/synthesize";
const FALLBACK_STATUSES = new Set([408, 502, 503, 504]);
// The hub's own ceilings are 180 s (transcription total) and 90 s (synthesis),
// so the client waits a little longer to see the hub's 504 first.
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 190000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 100000;
// 429 retries: attempts after the first, and the ceiling on any single wait.
const DEFAULT_RATE_LIMIT_RETRIES = 4;
const MAX_RATE_LIMIT_WAIT_MS = 10000;
// Hub request ceilings (protocol 10): a prompt over 1000 chars is a final 400
// and a synthesis body over 4 MB a final 413, neither of which falls back.
const MAX_PROMPT_CHARS = 1000;
const MAX_SYNTHESIS_BODY_BYTES = 4 * 1024 * 1024;

// The hub counts prompt chars as UTF-16 units (JS string length). Cut there,
// without leaving half a surrogate pair at the end.
function capPrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length <= MAX_PROMPT_CHARS) return prompt;
  const end = /[\uD800-\uDBFF]/.test(prompt[MAX_PROMPT_CHARS - 1])
    ? MAX_PROMPT_CHARS - 1
    : MAX_PROMPT_CHARS;
  return prompt.slice(0, end);
}

// Retry-After is delta-seconds or an HTTP date (RFC 9110 10.2.3). Missing or
// unparseable falls back to exponential backoff (1 s, 2 s, 4 s, ...).
function rateLimitWaitMs(retryAfter, attempt, now = Date.now()) {
  let ms = NaN;
  if (typeof retryAfter === "string" && retryAfter.trim()) {
    const value = retryAfter.trim();
    ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  }
  if (!Number.isFinite(ms) || ms < 0) ms = 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RATE_LIMIT_WAIT_MS);
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

class HubError extends Error {
  constructor(message, { status, code, fallback }) {
    super(message);
    this.name = "HubError";
    this.status = status;
    this.code = code;
    this.fallback = fallback;
  }
}

function shouldFallBack(error) {
  return error instanceof HubError && error.fallback === true;
}

function createHubFirst({
  getHubUrl,
  getDeviceKey,
  fetchImpl = globalThis.fetch,
  logger,
  transcriptionTimeoutMs = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  synthesisTimeoutMs = DEFAULT_SYNTHESIS_TIMEOUT_MS,
  rateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES,
  sleep = defaultSleep,
}) {
  const config = async () => {
    const url = normalizeHubUrl(getHubUrl()) || "";
    const key = await getDeviceKey();
    return url && typeof key === "string" && key ? { url, key } : null;
  };

  async function send(path, init, timeoutMs, signal) {
    const hub = await config();
    if (!hub) {
      throw new HubError("Hub is not configured", { code: "hub_not_configured", fallback: true });
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await sendOnce(hub, path, init, timeoutMs, signal);
      } catch (error) {
        if (!(error instanceof HubError) || error.status !== 429 || attempt >= rateLimitRetries) {
          throw error;
        }
        const waitMs = rateLimitWaitMs(error.retryAfter, attempt);
        logger?.warn?.("Hub rate limited the voice call, retrying", {
          attempt: attempt + 1,
          waitMs,
        });
        await sleep(waitMs, signal);
      }
    }
  }

  async function sendOnce(hub, path, init, timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${hub.url}${path}`, {
        method: "POST",
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${hub.key}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      // A caller cancel is not a hub failure: never fall back on it.
      if (signal?.aborted) throw error;
      const timedOut = timeout.aborted || error?.name === "TimeoutError";
      throw new HubError(timedOut ? "Hub request timed out" : "Hub is unreachable", {
        code: timedOut ? "hub_timeout" : "hub_unreachable",
        fallback: true,
      });
    }
    if (!response.ok) {
      let code;
      try {
        code = (await response.json())?.code;
      } catch {
        code = undefined;
      }
      const error = new HubError(`Hub voice request failed (${response.status})`, {
        status: response.status,
        code,
        fallback: FALLBACK_STATUSES.has(response.status),
      });
      error.retryAfter = response.headers?.get?.("retry-after") ?? undefined;
      throw error;
    }
    // A 2xx body that is not JSON (a proxy or login page) or stalls past the
    // timeout is a hub failure like an unreachable hub, so it falls back too.
    try {
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      const timedOut = timeout.aborted || error?.name === "TimeoutError";
      throw new HubError(timedOut ? "Hub response timed out" : "Hub response is not JSON", {
        status: response.status,
        code: timedOut ? "hub_timeout" : "invalid_response",
        fallback: true,
      });
    }
  }

  return {
    async transcribeViaHub(wavBuffer, { language, prompt, clientTrimmed, signal } = {}) {
      const form = new FormData();
      form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
      if (language) form.append("language", language);
      if (prompt) form.append("prompt", capPrompt(prompt));
      const headers = clientTrimmed ? { "x-rtech-client-trimmed": "1" } : {};
      const body = await send(
        TRANSCRIPTION_PATH,
        { headers, body: form },
        transcriptionTimeoutMs,
        signal
      );
      if (typeof body?.text !== "string") {
        throw new HubError("Hub transcription response is missing a text string", {
          code: "invalid_response",
          fallback: false,
        });
      }
      return { text: body.text };
    },

    async synthesizeViaHub({ text, audio_base64, prompt_text, signal } = {}) {
      const payload = { text };
      if (audio_base64 !== undefined) payload.audio_base64 = audio_base64;
      if (prompt_text !== undefined) payload.prompt_text = prompt_text;
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json, "utf8") > MAX_SYNTHESIS_BODY_BYTES) {
        throw new HubError("Hub synthesis body exceeds 4 MB", {
          status: 413,
          code: "payload_too_large",
          fallback: false,
        });
      }
      const body = await send(
        SYNTHESIS_PATH,
        { headers: { "content-type": "application/json" }, body: json },
        synthesisTimeoutMs,
        signal
      );
      if (typeof body?.audio_base64 !== "string" || !body.audio_base64) {
        throw new HubError("Hub synthesis response has no audio", {
          code: "invalid_response",
          fallback: false,
        });
      }
      return { audio_base64: body.audio_base64, sample_rate: body.sample_rate };
    },

    async withFallback(hubCall, directCall) {
      if (!(await config())) {
        return { ...(await directCall()), via: "direct" };
      }
      try {
        return { ...(await hubCall()), via: "hub" };
      } catch (error) {
        if (!shouldFallBack(error)) throw error;
        logger?.warn?.("Hub voice call failed, falling back to direct", {
          status: error.status,
          code: error.code,
        });
        return { ...(await directCall()), via: "direct" };
      }
    },
  };
}

module.exports = {
  createHubFirst,
  HubError,
  rateLimitWaitMs,
  capPrompt,
  MAX_PROMPT_CHARS,
  MAX_SYNTHESIS_BODY_BYTES,
  TRANSCRIPTION_PATH,
  SYNTHESIS_PATH,
};
