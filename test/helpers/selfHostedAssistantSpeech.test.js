const assert = require("node:assert/strict");
const test = require("node:test");

function loadService() {
  return require("../../src/helpers/selfHostedAssistantSpeech.js");
}

function response(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  };
}

test("synthesizes through the upstream endpoint and returns the complete WAV", async () => {
  const { createAssistantSpeechService } = loadService();
  const calls = [];
  const wav = Uint8Array.from([82, 73, 70, 70, 1, 2, 3]);
  const service = createAssistantSpeechService({
    getConfig: async () => ({
      endpoint: "http://voice.local",
      referenceAudioBase64: "reference-audio",
      promptText: "Use the reference voice",
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({
        audio_base64: Buffer.from(wav).toString("base64"),
        sample_rate: 24000,
      });
    },
  });

  const result = await service.synthesize("desktop", "request-1", "Hello there");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://voice.local/upstream/omnivoice/synthesize");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: "Hello there",
    audio_base64: "reference-audio",
    prompt_text: "Use the reference voice",
    seed: 42,
    num_steps: 16,
    language: "en",
    guidance_scale: 1.2,
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(result.audio instanceof Uint8Array);
  assert.deepEqual(Array.from(result.audio), Array.from(wav));
  assert.equal(result.mimeType, "audio/wav");
});

test("missing speech profile and invalid text fail before making a request", async () => {
  let fetchCalls = 0;
  const service = createService({
    getConfig: async () => null,
    fetchImpl: async () => {
      fetchCalls += 1;
      return response({});
    },
  });

  await assert.rejects(service.synthesize("desktop", "missing-profile", "Hello"));
  assert.equal(fetchCalls, 0);

  const invalidTextService = createService({
    getConfig: async () => ({
      endpoint: "http://voice.local",
      referenceAudioBase64: "reference-audio",
      promptText: "Use the reference voice",
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return response({});
    },
  });

  await assert.rejects(invalidTextService.synthesize("desktop", "empty", ""));
  await assert.rejects(invalidTextService.synthesize("desktop", "non-string", 42));
  assert.equal(fetchCalls, 0);
});

test("invalid upstream audio response fails", async () => {
  const service = createService({
    getConfig: async () => ({
      endpoint: "http://voice.local",
      referenceAudioBase64: "reference-audio",
      promptText: "Use the reference voice",
    }),
    fetchImpl: async () => response({ sample_rate: 24000 }),
  });

  await assert.rejects(service.synthesize("desktop", "bad-response", "Hello"));
});

test("cancellation is scoped to the owner and prevents a late result", async () => {
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const service = createService({
    getConfig: async () => ({
      endpoint: "http://voice.local",
      referenceAudioBase64: "reference-audio",
      promptText: "Use the reference voice",
    }),
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        fetchStarted({ init });
        init.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      }),
  });

  const pending = service.synthesize("desktop", "request-1", "Hello");
  const { init } = await fetchStartedPromise;

  service.cancel("other-owner", "request-1");
  assert.equal(init.signal.aborted, false);

  service.cancel("desktop", "request-1");
  assert.equal(init.signal.aborted, true);
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

function createService(options) {
  return loadService().createAssistantSpeechService(options);
}

// --- provider switch (rtech-whisper#630) ---

const HUB_WAV = Uint8Array.from([82, 73, 70, 70, 1, 2, 3]);
const LOCAL_WAV = Buffer.from([82, 73, 70, 70, 9, 8, 7, 6]);
const LOCAL_PATHS = {
  referenceWavPath: "/profile/reference-1.wav",
  referenceTextPath: "/profile/reference-1.txt",
};
const hubConfig = {
  endpoint: "http://voice.local",
  referenceAudioBase64: "reference-audio",
  promptText: "Use the reference voice",
};

function abortError() {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

// Rejects with AbortError when its signal aborts; never resolves otherwise.
function pendingUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function fakeLocal(provider, overrides = {}) {
  const local = {
    calls: [],
    getProvider: () => provider,
    isAvailable: () => true,
    getPaths: () => LOCAL_PATHS,
    synthesize: async () => LOCAL_WAV,
    ...overrides,
  };
  const synthesize = local.synthesize;
  local.synthesize = (args) => {
    local.calls.push(args);
    return synthesize(args);
  };
  return local;
}

// A hub side that counts its calls; `fetchImpl` defaults to a successful WAV.
function fakeHub(fetchImpl) {
  const hub = { configCalls: 0, fetchCalls: 0 };
  hub.getConfig = async () => {
    hub.configCalls += 1;
    return hubConfig;
  };
  hub.fetchImpl = async (url, init) => {
    hub.fetchCalls += 1;
    return fetchImpl
      ? fetchImpl(url, init)
      : response({ audio_base64: Buffer.from(HUB_WAV).toString("base64") });
  };
  return hub;
}

test("without a local argument the fetch path is used", async () => {
  const hub = fakeHub();
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl });

  const result = await service.synthesize("desktop", "request-1", "Hello");

  assert.equal(hub.fetchCalls, 1);
  assert.deepEqual(Array.from(result.audio), Array.from(HUB_WAV));
});

test("hub provider and unknown provider strings use fetch and never the local engine", async () => {
  for (const provider of ["hub", "fish", undefined]) {
    const hub = fakeHub();
    const local = fakeLocal(provider);
    const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

    const result = await service.synthesize("desktop", "request-1", "Hello");

    assert.equal(hub.fetchCalls, 1, String(provider));
    assert.equal(local.calls.length, 0, String(provider));
    assert.deepEqual(Array.from(result.audio), Array.from(HUB_WAV));
  }
});

test("local provider synthesizes on device without touching config or fetch", async () => {
  const hub = fakeHub();
  const local = fakeLocal("local");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const result = await service.synthesize("desktop", "request-1", "  Hello there  ");

  assert.equal(hub.configCalls, 0);
  assert.equal(hub.fetchCalls, 0);
  assert.equal(local.calls.length, 1);
  assert.equal(local.calls[0].text, "Hello there");
  assert.equal(local.calls[0].referenceWavPath, LOCAL_PATHS.referenceWavPath);
  assert.equal(local.calls[0].referenceTextPath, LOCAL_PATHS.referenceTextPath);
  assert.ok(local.calls[0].signal instanceof AbortSignal);
  assert.ok(result.audio instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(result.audio), false);
  assert.deepEqual(Array.from(result.audio), Array.from(LOCAL_WAV));
  assert.equal(result.mimeType, "audio/wav");
});

test("local provider reports a missing profile, a missing engine and invalid audio", async () => {
  const hub = fakeHub();
  const run = (overrides) => {
    const local = fakeLocal("local", overrides);
    const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });
    return { local, pending: service.synthesize("desktop", "request-1", "Hello") };
  };

  const noProfile = run({ getPaths: () => null });
  await assert.rejects(noProfile.pending, {
    message: "Assistant speech profile is not configured",
  });
  assert.equal(noProfile.local.calls.length, 0);

  const notInstalled = run({ isAvailable: () => false });
  await assert.rejects(notInstalled.pending, { message: "Local speech is not installed" });
  assert.equal(notInstalled.local.calls.length, 0);

  for (const bad of [Buffer.alloc(0), "RIFF", null]) {
    await assert.rejects(run({ synthesize: async () => bad }).pending, {
      message: "Speech service returned invalid audio",
    });
  }
  assert.equal(hub.fetchCalls, 0);
});

test("local provider: cancel aborts the engine call and a newer request supersedes", async () => {
  const local = fakeLocal("local", { synthesize: ({ signal }) => pendingUntilAborted(signal) });
  const service = createService({ getConfig: async () => hubConfig, local });

  const cancelled = service.synthesize("desktop", "request-1", "Hello");
  await Promise.resolve();
  service.cancel("other-owner", "request-1");
  assert.equal(local.calls[0].signal.aborted, false);
  service.cancel("desktop", "request-1");
  assert.equal(local.calls[0].signal.aborted, true);
  await assert.rejects(cancelled, (error) => error.name === "AbortError");

  // A superseded engine call that resolves late is still rejected.
  const releases = [];
  const lateLocal = fakeLocal("local", {
    synthesize: () => new Promise((resolve) => releases.push(resolve)),
  });
  const lateService = createService({ getConfig: async () => hubConfig, local: lateLocal });
  const first = lateService.synthesize("desktop", "request-2", "First");
  const second = lateService.synthesize("desktop", "request-2", "Second");
  assert.equal(lateLocal.calls[0].signal.aborted, true);
  assert.equal(lateLocal.calls[1].signal.aborted, false);
  releases.forEach((release) => release(LOCAL_WAV));
  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.deepEqual(Array.from((await second).audio), Array.from(LOCAL_WAV));
});

test("auto provider keeps the hub result and never calls the local engine", async () => {
  const hub = fakeHub();
  const local = fakeLocal("auto");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const result = await service.synthesize("desktop", "request-1", "Hello");

  assert.equal(hub.fetchCalls, 1);
  assert.equal(local.calls.length, 0);
  assert.deepEqual(Array.from(result.audio), Array.from(HUB_WAV));
});

test("auto provider falls back to the local engine when the hub fails", async () => {
  const hub = fakeHub(async () => response({}, false));
  const local = fakeLocal("auto");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const result = await service.synthesize("desktop", "request-1", " Hello ");

  assert.equal(hub.fetchCalls, 1);
  assert.equal(local.calls.length, 1);
  assert.equal(local.calls[0].text, "Hello");
  assert.deepEqual(Array.from(result.audio), Array.from(LOCAL_WAV));
  assert.equal(result.mimeType, "audio/wav");

  // A hub side with no profile configured falls back too.
  const unconfigured = createService({
    getConfig: async () => null,
    fetchImpl: hub.fetchImpl,
    local,
  });
  const fallback = await unconfigured.synthesize("desktop", "request-2", "Hello");
  assert.deepEqual(Array.from(fallback.audio), Array.from(LOCAL_WAV));
});

test("auto provider rethrows the hub error when the local engine cannot take over", async () => {
  const hub = fakeHub(async () => response({}, false));
  for (const overrides of [{ isAvailable: () => false }, { getPaths: () => null }]) {
    const local = fakeLocal("auto", overrides);
    const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

    await assert.rejects(service.synthesize("desktop", "request-1", "Hello"), {
      message: "Speech service failed (500)",
    });
    assert.equal(local.calls.length, 0);
  }
});

test("auto provider throws the local error with the hub error as its cause", async () => {
  const hub = fakeHub(async () => response({}, false));
  const local = fakeLocal("auto", {
    synthesize: async () => {
      throw new Error("engine crashed");
    },
  });
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  await assert.rejects(service.synthesize("desktop", "request-1", "Hello"), (error) => {
    assert.equal(error.message, "engine crashed");
    assert.equal(error.cause?.message, "Speech service failed (500)");
    return true;
  });
});

test("auto provider never falls back for a request cancelled while the hub call is pending", async () => {
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const hub = fakeHub((_url, init) => {
    fetchStarted(init);
    return pendingUntilAborted(init.signal);
  });
  const local = fakeLocal("auto");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const pending = service.synthesize("desktop", "request-1", "Hello");
  const init = await fetchStartedPromise;
  service.cancel("desktop", "request-1");

  assert.equal(init.signal.aborted, true);
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(local.calls.length, 0);
});

// --- speech tags (rtech-whisper#635) ---

test("the direct path sends known tags and drops unknown ones", async () => {
  const bodies = [];
  const hub = fakeHub(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response({ audio_base64: Buffer.from(HUB_WAV).toString("base64") });
  });
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl });

  await service.synthesize("desktop", "request-1", "[sigh] Fine. [whispers] Look.");

  assert.equal(bodies[0].text, "[sigh] Fine. Look.");
});

test("the local engine receives no tags, and a tag-only reply is refused", async () => {
  const local = fakeLocal("local");
  const service = createService({ getConfig: async () => hubConfig, local });

  await service.synthesize("desktop", "request-1", "[sigh] Fine. [whispers] Look.");
  assert.equal(local.calls[0].text, "Fine. Look.");

  await assert.rejects(service.synthesize("desktop", "request-2", "[sigh]"), {
    message: "Speech text is required",
  });
  assert.equal(local.calls.length, 1);
});

// --- review fixes for the provider switch (rtech-whisper#630) ---

const hubFailure = () => fakeHub(async () => response({}, false));

test("a request that names a voice uses the hub path whatever the provider", async () => {
  const voices = [];
  const hub = fakeHub();
  const local = fakeLocal("local");
  const service = createService({
    getConfig: async (voice) => {
      voices.push(voice);
      return hubConfig;
    },
    fetchImpl: hub.fetchImpl,
    local,
  });

  const result = await service.synthesize("desktop", "request-1", "Hello", "grill-voice");

  assert.deepEqual(voices, ["grill-voice"]);
  assert.equal(hub.fetchCalls, 1);
  assert.equal(local.calls.length, 0);
  assert.deepEqual(Array.from(result.audio), Array.from(HUB_WAV));

  // "auto" with a voice: the hub error stands, no fallback.
  const failing = hubFailure();
  const autoLocal = fakeLocal("auto");
  const autoService = createService({
    getConfig: failing.getConfig,
    fetchImpl: failing.fetchImpl,
    local: autoLocal,
  });
  await assert.rejects(autoService.synthesize("desktop", "request-2", "Hello", "grill-voice"), {
    message: "Speech service failed (500)",
  });
  assert.equal(failing.fetchCalls, 1);
  assert.equal(autoLocal.calls.length, 0);
});

test("local provider checks the install before touching the profile", async () => {
  let pathCalls = 0;
  const local = fakeLocal("local", {
    isAvailable: () => false,
    getPaths: () => {
      pathCalls += 1;
      return LOCAL_PATHS;
    },
  });
  const service = createService({ getConfig: async () => hubConfig, local });

  await assert.rejects(service.synthesize("desktop", "request-1", "Hello"), {
    message: "Local speech is not installed",
  });
  assert.equal(pathCalls, 0);
  assert.equal(local.calls.length, 0);
});

test("local provider: a cancel during the engine call is an AbortError, other engine errors surface", async () => {
  const engineError = new Error("engine exited 143");
  const local = fakeLocal("local", {
    synthesize: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(engineError), { once: true });
      }),
  });
  const service = createService({ getConfig: async () => hubConfig, local });

  const cancelled = service.synthesize("desktop", "request-1", "Hello");
  await Promise.resolve();
  assert.equal(local.calls.length, 1);
  service.cancel("desktop", "request-1");
  await assert.rejects(cancelled, (error) => {
    assert.equal(error.name, "AbortError");
    assert.notEqual(error, engineError);
    return true;
  });

  const crashing = fakeLocal("local", {
    synthesize: async () => {
      throw engineError;
    },
  });
  const crashingService = createService({ getConfig: async () => hubConfig, local: crashing });
  await assert.rejects(crashingService.synthesize("desktop", "request-2", "Hello"), (error) => {
    assert.equal(error, engineError);
    assert.equal(error.name, "Error");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("auto provider falls back when the hub fails with an AbortError that is not a cancel", async () => {
  const hub = fakeHub(async () => {
    throw abortError();
  });
  const local = fakeLocal("auto");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const result = await service.synthesize("desktop", "request-1", "Hello");

  assert.equal(hub.fetchCalls, 1);
  assert.equal(local.calls.length, 1);
  assert.deepEqual(Array.from(result.audio), Array.from(LOCAL_WAV));
});

test("auto provider never falls back for a cancelled request whose hub call fails with a plain error", async () => {
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const hub = fakeHub(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        fetchStarted(init);
        init.signal.addEventListener("abort", () => reject(new Error("socket hang up")), {
          once: true,
        });
      })
  );
  const local = fakeLocal("auto");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const pending = service.synthesize("desktop", "request-1", "Hello");
  await fetchStartedPromise;
  service.cancel("desktop", "request-1");

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(local.calls.length, 0);
});

test("auto provider never falls back for a request superseded while its hub call is pending", async () => {
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  let fetches = 0;
  const hub = fakeHub((_url, init) => {
    fetches += 1;
    if (fetches > 1) return response({ audio_base64: Buffer.from(HUB_WAV).toString("base64") });
    fetchStarted(init);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("socket hang up")), {
        once: true,
      });
    });
  });
  const local = fakeLocal("auto");
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const first = service.synthesize("desktop", "request-1", "First");
  const firstInit = await fetchStartedPromise;
  const second = service.synthesize("desktop", "request-1", "Second");

  assert.equal(firstInit.signal.aborted, true);
  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.deepEqual(Array.from((await second).audio), Array.from(HUB_WAV));
  assert.equal(local.calls.length, 0);
});

test("auto provider treats a throwing profile lookup as a local failure caused by the hub error", async () => {
  const hub = hubFailure();
  const lookupError = new Error("EACCES");
  let pathCalls = 0;
  const local = fakeLocal("auto", {
    getPaths: () => {
      pathCalls += 1;
      throw lookupError;
    },
  });
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  await assert.rejects(service.synthesize("desktop", "request-1", "Hello"), (error) => {
    assert.equal(error, lookupError);
    assert.equal(error.cause?.message, "Speech service failed (500)");
    return true;
  });
  assert.equal(pathCalls, 1);
  assert.equal(local.calls.length, 0);

  // A successful fallback looks the paths up once too.
  let okPathCalls = 0;
  const okLocal = fakeLocal("auto", {
    getPaths: () => {
      okPathCalls += 1;
      return LOCAL_PATHS;
    },
  });
  const okService = createService({
    getConfig: hub.getConfig,
    fetchImpl: hub.fetchImpl,
    local: okLocal,
  });
  await okService.synthesize("desktop", "request-2", "Hello");
  assert.equal(okPathCalls, 1);
});

test("auto provider keeps a cause the local error already carries", async () => {
  const hub = hubFailure();
  const rootCause = new Error("model file missing");
  const local = fakeLocal("auto", {
    synthesize: async () => {
      throw new Error("engine crashed", { cause: rootCause });
    },
  });
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  await assert.rejects(service.synthesize("desktop", "request-1", "Hello"), (error) => {
    assert.equal(error.message, "engine crashed");
    assert.equal(error.cause, rootCause);
    return true;
  });
});

test("auto provider: a cancel during the fallback engine call is an AbortError without a cause", async () => {
  const hub = hubFailure();
  let engineStarted;
  const engineStartedPromise = new Promise((resolve) => {
    engineStarted = resolve;
  });
  const local = fakeLocal("auto", {
    synthesize: ({ signal }) =>
      new Promise((_resolve, reject) => {
        engineStarted();
        signal.addEventListener("abort", () => reject(new Error("engine exited 143")), {
          once: true,
        });
      }),
  });
  const service = createService({ getConfig: hub.getConfig, fetchImpl: hub.fetchImpl, local });

  const pending = service.synthesize("desktop", "request-1", "Hello");
  await engineStartedPromise;
  service.cancel("desktop", "request-1");

  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.cause, undefined);
    return true;
  });
});

// --- render settings (rtech-whisper#635) ---

test("the direct request is pinned by the config's render settings, and the hub request is not", async () => {
  const bodies = [];
  const hubCalls = [];
  const wav = { audio_base64: Buffer.from(HUB_WAV).toString("base64") };
  const speak = (config, hubFirst) =>
    createService({
      getConfig: async () => ({ ...hubConfig, ...config }),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return response(wav);
      },
      hubFirst,
    }).synthesize("desktop", "request-1", "Hello");
  const pinned = ({ seed, num_steps, language, guidance_scale }) => ({
    seed,
    num_steps,
    language,
    guidance_scale,
  });

  await speak({ seed: 7, numSteps: 12, language: "fr" });
  await speak({});
  await speak({ seed: 5000, numSteps: 99, language: "" });
  assert.deepEqual(bodies.map(pinned), [
    { seed: 7, num_steps: 12, language: "fr", guidance_scale: 1.2 },
    { seed: 42, num_steps: 16, language: "en", guidance_scale: 1.2 },
    { seed: 42, num_steps: 16, language: "en", guidance_scale: 1.2 },
  ]);

  await speak(
    { seed: 7, numSteps: 12, language: "fr" },
    {
      withFallback: (viaHub) => viaHub(),
      synthesizeViaHub: async (args) => {
        hubCalls.push(args);
        return wav;
      },
    }
  );
  assert.equal(bodies.length, 3);
  assert.deepEqual(Object.keys(hubCalls[0]).sort(), [
    "audio_base64",
    "prompt_text",
    "signal",
    "text",
  ]);
});
