const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/selfHostedDictationTranscription.js");

function wavWithSeconds(seconds) {
  const data = Buffer.alloc(seconds * 16000 * 2);
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

const base = (overrides = {}) => ({
  audioBuffer: Buffer.from("recording"),
  endpoint: "https://stt.example/v1/audio/transcriptions",
  model: "parakeet",
  language: "en",
  normalizeAudio: async () => wavWithSeconds(58),
  trimAudio: (wav) => ({ wav, hasSpeech: true, keptMs: 0, originalMs: 0 }),
  sleep: async () => {},
  ...overrides,
});

test("long self-hosted dictation is serialized into shorter ordered chunks", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const calls = [];
  const result = await transcribeSelfHostedDictation(
    base({
      transcribeChunk: async ({ wav, model, language }) => {
        calls.push({ wav, model, language });
        return { success: true, text: `part ${calls.length}` };
      },
    })
  );

  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ wav }) => wav.length <= 44 + 26 * 16000 * 2));
  assert.deepEqual(
    calls.map(({ model }) => model),
    ["parakeet", "parakeet", "parakeet"]
  );
  assert.deepEqual(
    calls.map(({ language }) => language),
    ["en", "en", "en"]
  );
  assert.equal(result.text, "part 1 part 2 part 3");
});

test("a failed middle chunk rejects instead of returning a partial transcript", async () => {
  const { transcribeSelfHostedDictation } = await load();
  let calls = 0;
  await assert.rejects(
    transcribeSelfHostedDictation(
      base({
        maxAttempts: 1,
        transcribeChunk: async () => {
          calls += 1;
          if (calls === 2) throw Object.assign(new Error("bad request"), { status: 400 });
          return { success: true, text: `part ${calls}` };
        },
      })
    ),
    /chunk 2 of 3.*bad request/
  );
});

test("transient failures retry only to the configured bound", async () => {
  const { transcribeSelfHostedDictation } = await load();
  let attempts = 0;
  await assert.rejects(
    transcribeSelfHostedDictation(
      base({
        maxAttempts: 3,
        transcribeChunk: async () => {
          attempts += 1;
          throw Object.assign(new Error("busy"), { status: 503 });
        },
      })
    ),
    /chunk 1 of 3.*busy/
  );
  assert.equal(attempts, 3);
});

test("a transient middle-chunk failure recovers without resending completed chunks", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const attempts = [];
  let completed = 0;
  let middleAttempts = 0;
  const result = await transcribeSelfHostedDictation(
    base({
      transcribeChunk: async () => {
        const chunk = completed + 1;
        attempts.push(chunk);
        if (chunk === 2) {
          middleAttempts += 1;
          if (middleAttempts === 1) throw Object.assign(new Error("busy"), { status: 503 });
        }
        completed += 1;
        return { success: true, text: `part ${chunk}` };
      },
    })
  );

  assert.deepEqual(attempts, [1, 2, 2, 3]);
  assert.equal(result.text, "part 1 part 2 part 3");
});

test("cancellation stops before the next chunk", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    transcribeSelfHostedDictation(
      base({
        signal: controller.signal,
        transcribeChunk: async () => {
          calls += 1;
          controller.abort();
          return { success: true, text: "first" };
        },
      })
    ),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
});

test("a timed out request goes to away mode once, without becoming user cancellation", async () => {
  const { transcribeSelfHostedDictation, AWAY_NO_LOCAL_ENGINE_CODE } = await load();
  let attempts = 0;
  await assert.rejects(
    transcribeSelfHostedDictation(
      base({
        requestTimeoutMs: 5,
        maxAttempts: 3,
        transcribeChunk: ({ signal }) => {
          attempts += 1;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      })
    ),
    (error) => {
      assert.notEqual(error.name, "AbortError");
      assert.equal(error.code, AWAY_NO_LOCAL_ENGINE_CODE);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("a direct-path timeout reaches the installed local engine", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const result = await transcribeSelfHostedDictation(
    base({
      requestTimeoutMs: 5,
      transcribeChunk: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      localEngine: { name: "whisper", transcribe: async () => ({ success: true, text: "local" }) },
    })
  );
  assert.equal(result.via, "local");
  assert.equal(result.text, "local");
});

test("overlap merge removes only an exact repeated boundary", async () => {
  const { mergeChunkTexts } = await load();
  assert.equal(
    mergeChunkTexts(["one two three four", "two three four five"]),
    "one two three four five"
  );
  assert.equal(mergeChunkTexts(["one two", "one two"]), "one two one two");
  assert.equal(
    mergeChunkTexts(["one two three", "too three four"]),
    "one two three too three four"
  );
});

test("audio the trimmer finds silent returns empty text without any request", async () => {
  const { transcribeSelfHostedDictation } = await load();
  let calls = 0;
  const result = await transcribeSelfHostedDictation(
    base({
      trimAudio: (wav) => ({ wav, hasSpeech: false, keptMs: 0, originalMs: 20500 }),
      transcribeChunk: async () => {
        calls += 1;
        return { success: true, text: "invented words" };
      },
    })
  );

  assert.equal(calls, 0);
  assert.deepEqual(result, { success: true, text: "", noSpeech: true });
});

test("the trimmed wav is what gets sent, not the normalized one", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const trimmed = wavWithSeconds(2);
  const sent = [];
  await transcribeSelfHostedDictation(
    base({
      trimAudio: () => ({ wav: trimmed, hasSpeech: true, keptMs: 2000, originalMs: 58000 }),
      transcribeChunk: async ({ wav }) => {
        sent.push(wav);
        return { success: true, text: "ok." };
      },
    })
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, trimmed.length);
});

test("repeated sentences in the merged transcript collapse to one", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const result = await transcribeSelfHostedDictation(
    base({
      normalizeAudio: async () => wavWithSeconds(2),
      transcribeChunk: async () => ({
        success: true,
        text: "The meeting starts at noon. The meeting starts at noon. The meeting starts at noon.",
      }),
    })
  );

  assert.equal(result.text, "The meeting starts at noon.");
});

// Away mode: hub, then the self-hosted server directly, then the local engine.
const enotfound = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND llama-swap.example.internal"), {
      code: "ENOTFOUND",
    }),
  });

// A hub that is down, so every chunk fails over to the direct path.
const hubDown = {
  withFallback: async (_hubCall, directCall) => ({ ...(await directCall()), via: "direct" }),
  transcribeViaHub: async () => {
    throw new Error("hub should not be called directly");
  },
};

test("the direct path fails fast on ENOTFOUND instead of retrying", async () => {
  const { transcribeSelfHostedDictation } = await load();
  let attempts = 0;
  await assert.rejects(
    transcribeSelfHostedDictation(
      base({
        maxAttempts: 3,
        transcribeChunk: async () => {
          attempts += 1;
          throw enotfound();
        },
      })
    ),
    /no local engine is installed/
  );
  assert.equal(attempts, 1);
});

test("the direct path still retries a 503", async () => {
  const { transcribeSelfHostedDictation } = await load();
  let attempts = 0;
  const result = await transcribeSelfHostedDictation(
    base({
      normalizeAudio: async () => wavWithSeconds(5),
      maxAttempts: 3,
      transcribeChunk: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { status: 503 });
        return { success: true, text: "ok" };
      },
    })
  );
  assert.equal(attempts, 3);
  assert.equal(result.text, "ok");
});

test("hub down and the self-hosted server unresolvable uses the installed local engine", async () => {
  const { transcribeSelfHostedDictation } = await load();
  const local = [];
  const result = await transcribeSelfHostedDictation(
    base({
      hubFirst: hubDown,
      transcribeChunk: async () => {
        throw enotfound();
      },
      localEngine: {
        name: "whisper",
        transcribe: async (audio, { language }) => {
          local.push({ audio: audio.toString(), language });
          return { success: true, text: "from the local engine" };
        },
      },
    })
  );
  assert.deepEqual(local, [{ audio: "recording", language: "en" }]);
  assert.equal(result.text, "from the local engine");
  assert.equal(result.via, "local");
});

test("hub down and the self-hosted server unresolvable with no local engine gives the clear error", async () => {
  const { transcribeSelfHostedDictation, AWAY_NO_LOCAL_ENGINE_CODE } = await load();
  await assert.rejects(
    transcribeSelfHostedDictation(
      base({
        hubFirst: hubDown,
        transcribeChunk: async () => {
          throw enotfound();
        },
        localEngine: null,
      })
    ),
    (error) => {
      assert.equal(
        error.message,
        "Can't reach the hub or the self-hosted server, and no local engine is installed"
      );
      assert.equal(error.code, AWAY_NO_LOCAL_ENGINE_CODE);
      return true;
    }
  );
});

test("Electron's net error for an unresolvable host counts as a connection error", async () => {
  const { isConnectionError } = await load();
  assert.equal(isConnectionError(new Error("net::ERR_NAME_NOT_RESOLVED")), true);
  assert.equal(isConnectionError(enotfound()), true);
  for (const net of ["CONNECTION_TIMED_OUT", "TIMED_OUT", "NETWORK_CHANGED", "CONNECTION_RESET"]) {
    assert.equal(isConnectionError(new Error(`net::ERR_${net}`)), true, net);
  }
  for (const code of ["ETIMEDOUT", "ECONNRESET"]) {
    assert.equal(isConnectionError(Object.assign(new Error("x"), { code })), true, code);
  }
  assert.equal(isConnectionError(new DOMException("timed out", "TimeoutError")), true);
  assert.equal(isConnectionError(Object.assign(new Error("busy"), { status: 503 })), false);
  assert.equal(
    isConnectionError(new Error("Self-hosted API response is missing a text string")),
    false
  );
});
