const fs = require("node:fs");
const path = require("node:path");
const { convertToWav } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { createAbortError } = require("./abortError");
const { transcribeSelfHostedChunk } = require("./selfHostedMeetingTranscription");
const { collapseRepeatedSentences } = require("./transcriptRepetition");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

function findWavData(wav) {
  let offset = 12;
  while (offset <= wav.length - 8) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return { offset: offset + 8, size: Math.min(size, wav.length - offset - 8) };
    offset += 8 + size + (size % 2);
  }
  throw new Error("Normalized WAV has no data chunk");
}

function makePcmWav(pcm) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  wav.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function splitWav(wav, chunkSeconds, overlapSeconds) {
  const { offset, size } = findWavData(wav);
  const bytesPerChunk = chunkSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;
  const step = (chunkSeconds - overlapSeconds) * SAMPLE_RATE * BYTES_PER_SAMPLE;
  const pcm = wav.subarray(offset, offset + size);
  const chunks = [];
  for (let start = 0; start < pcm.length; start += step) {
    chunks.push(makePcmWav(pcm.subarray(start, Math.min(start + bytesPerChunk, pcm.length))));
    if (start + bytesPerChunk >= pcm.length) break;
  }
  return chunks;
}

function normalizedWord(word) {
  return word.toLocaleLowerCase().replace(/^\p{P}+|\p{P}+$/gu, "");
}

function mergeChunkTexts(texts) {
  const merged = [];
  for (const text of texts) {
    const next = text.trim().split(/\s+/).filter(Boolean);
    let overlap = 0;
    const limit = Math.min(12, merged.length, next.length);
    for (let count = 3; count <= limit; count += 1) {
      const tail = merged.slice(-count).map(normalizedWord);
      const head = next.slice(0, count).map(normalizedWord);
      if (tail.every((word, index) => word && word === head[index])) overlap = count;
    }
    merged.push(...next.slice(overlap));
  }
  return merged.join(" ");
}

async function normalizeRecordedAudio(audioBuffer, signal) {
  const dir = fs.mkdtempSync(path.join(getSafeTempDir(), "openwhispr-self-hosted-"));
  const input = path.join(dir, "recording.webm");
  const output = path.join(dir, "recording.wav");
  try {
    fs.writeFileSync(input, audioBuffer);
    await convertToWav(input, output, { sampleRate: SAMPLE_RATE, channels: 1, signal });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Lazy require keeps silenceTrim.js free to reuse the WAV helpers above.
const defaultTrimAudio = (wav, options) => require("./silenceTrim").trimSilence(wav, options);

// A server answer retries only on 429 and 5xx. A DNS or connection failure
// (away from home, a LAN-only server name does not resolve), a
// dropped connection, or a timeout never retries, so the away-mode chain moves
// on to the local engine at once instead of spending 3 x requestTimeoutMs per
// chunk on a host it cannot reach.
const retryable = (error) =>
  error.status ? error.status === 429 || error.status >= 500 : !isConnectionError(error);

const CONNECTION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
// Electron net.fetch reports the Chromium net error in the message instead.
const CONNECTION_NET_ERROR =
  /net::ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED)/;

function isConnectionError(error) {
  if (!error || error.status) return false;
  // The per-attempt AbortSignal.timeout rejects the fetch with a TimeoutError.
  if (error.name === "TimeoutError" || error.cause?.name === "TimeoutError") return true;
  const code = error.code || error.cause?.code;
  if (CONNECTION_ERROR_CODES.has(code)) return true;
  return CONNECTION_NET_ERROR.test(`${error.message || ""} ${error.cause?.message || ""}`);
}

const AWAY_NO_LOCAL_ENGINE_MESSAGE =
  "Can't reach the hub or the self-hosted server, and no local engine is installed";
const AWAY_NO_LOCAL_ENGINE_CODE = "AWAY_NO_LOCAL_ENGINE";

// The last link of the away-mode chain: hub, then the self-hosted server directly, then the local
// engine the user already configured. With no local engine the error is
// thrown, so the renderer keeps the recording for retry.
async function transcribeAway({ audioBuffer, localEngine, language, signal, cause }) {
  if (!localEngine) {
    throw Object.assign(new Error(AWAY_NO_LOCAL_ENGINE_MESSAGE), {
      code: AWAY_NO_LOCAL_ENGINE_CODE,
      cause,
    });
  }
  const result = await localEngine.transcribe(Buffer.from(audioBuffer), { language, signal });
  if (signal?.aborted) throw createAbortError();
  if (result?.success === false && result.message === "No audio detected") {
    return { success: true, text: "", noSpeech: true, via: "local" };
  }
  if (typeof result?.text !== "string") {
    throw new Error(`Local ${localEngine.name || "engine"} returned no text`);
  }
  return { success: true, text: result.text, via: "local" };
}

async function transcribeWithRetry(options, maxAttempts, requestTimeoutMs, sleep) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw createAbortError();
    try {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      const attemptSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      return await options.transcribeChunk({ ...options, signal: attemptSignal });
    } catch (error) {
      if (options.signal?.aborted) throw createAbortError();
      if (!retryable(error) || attempt === maxAttempts) throw error;
      lastError = error;
      await sleep(250 * 2 ** (attempt - 1), options.signal);
    }
  }
  throw lastError;
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

async function transcribeSelfHostedDictation(options) {
  const {
    audioBuffer,
    endpoint,
    model,
    language,
    prompt,
    apiKey,
    fetchImpl = globalThis.fetch,
    signal,
    chunkSeconds = 25,
    overlapSeconds = 1,
    maxAttempts = 3,
    requestTimeoutMs = 60000,
    normalizeAudio = normalizeRecordedAudio,
    trimAudio = defaultTrimAudio,
    transcribeChunk = transcribeSelfHostedChunk,
    sleep = defaultSleep,
    // Hub-first: when set and configured, each trimmed
    // chunk goes to the hub first; the direct request below is the fallback.
    hubFirst,
    // Away mode: { name, transcribe(audioBuffer, opts) }
    // for the configured local engine, or null when none is installed.
    localEngine = null,
  } = options;
  if (
    !Number.isFinite(chunkSeconds) ||
    !Number.isFinite(overlapSeconds) ||
    chunkSeconds <= 0 ||
    overlapSeconds < 0 ||
    overlapSeconds >= chunkSeconds
  ) {
    throw new Error("Invalid self-hosted dictation chunk timing");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Invalid self-hosted dictation retry count");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Invalid self-hosted dictation request timeout");
  }
  if (signal?.aborted) throw createAbortError();
  const wav = await normalizeAudio(Buffer.from(audioBuffer), signal);
  if (signal?.aborted) throw createAbortError();
  const trimmed = trimAudio(wav);
  if (!trimmed.hasSpeech) return { success: true, text: "", noSpeech: true };
  const chunks = splitWav(trimmed.wav, chunkSeconds, overlapSeconds);
  const texts = [];
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      const wav = chunks[index];
      // Retries belong to the direct path only. The hub path never retries a
      // 4xx and falls back only on unreachable/timeout/502/503/504 (10.7).
      const direct = () =>
        transcribeWithRetry(
          {
            endpoint,
            model,
            language,
            prompt,
            apiKey,
            signal,
            fetchImpl,
            wav,
            transcribeChunk,
          },
          maxAttempts,
          requestTimeoutMs,
          sleep
        );
      const result = hubFirst
        ? await hubFirst.withFallback(
            // This path already ran trimSilence, so the hub skips its own trim.
            () => hubFirst.transcribeViaHub(wav, { language, prompt, clientTrimmed: true, signal }),
            direct
          )
        : await direct();
      texts.push(result.text);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      // The hub already failed over (or is not configured) and the self-hosted server is not
      // reachable at all: transcribe the whole recording locally instead.
      if (isConnectionError(error)) {
        return transcribeAway({ audioBuffer, localEngine, language, signal, cause: error });
      }
      throw new Error(
        `Self-hosted transcription chunk ${index + 1} of ${chunks.length} failed: ${error.message}`
      );
    }
  }
  return { success: true, text: collapseRepeatedSentences(mergeChunkTexts(texts)) };
}

module.exports = {
  AWAY_NO_LOCAL_ENGINE_CODE,
  AWAY_NO_LOCAL_ENGINE_MESSAGE,
  isConnectionError,
  findWavData,
  makePcmWav,
  mergeChunkTexts,
  transcribeSelfHostedDictation,
};
