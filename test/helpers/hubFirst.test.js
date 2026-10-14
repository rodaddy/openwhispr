// Hub-first voice helper: hub protocol 10.7 says the
// desktop falls back to the self-hosted server only on a network error, a timeout (including a
// hub 408 request_timeout), or 502/503/504.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createHubFirst } = require("../../src/helpers/hubFirst");

const HUB = "https://hub.example.test";
const DEVICE_KEY = "whk_device-key-secret-value";
const WAV = Buffer.from("RIFF....WAVEfmt fake");

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup({ hubUrl = HUB, key = DEVICE_KEY, fetchImpl, timeoutMs, sleeps = [] } = {}) {
  const calls = [];
  const logs = [];
  const log =
    (level) =>
    (...args) =>
      logs.push([level, ...args]);
  const logger = { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  };
  const hubFirst = createHubFirst({
    getHubUrl: () => hubUrl,
    getDeviceKey: () => key,
    fetchImpl: fetch,
    logger,
    ...(timeoutMs ? { transcriptionTimeoutMs: timeoutMs, synthesisTimeoutMs: timeoutMs } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  let directCalls = 0;
  const direct = async () => {
    directCalls += 1;
    return { text: "from direct" };
  };
  return { hubFirst, calls, logs, direct, directCount: () => directCalls };
}

const transcribe = (hubFirst, options) => () => hubFirst.transcribeViaHub(WAV, options);

test("a hub success does not call direct", async () => {
  const s = setup({ fetchImpl: async () => jsonResponse(200, { text: "from hub" }) });
  const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.deepEqual(result, { text: "from hub", via: "hub" });
  assert.equal(s.directCount(), 0);
  assert.equal(s.calls[0].url, `${HUB}/api/voice/v1/audio/transcriptions`);
  assert.equal(s.calls[0].init.method, "POST");
  assert.ok(s.calls[0].init.body instanceof FormData);
  assert.ok(s.calls[0].init.body.get("file") instanceof Blob);
});

test("a network error falls back to direct", async () => {
  const s = setup({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.deepEqual(result, { text: "from direct", via: "direct" });
  assert.equal(s.directCount(), 1);
});

test("a timeout falls back to direct", async () => {
  const s = setup({
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.equal(result.via, "direct");
  assert.equal(s.directCount(), 1);
});

for (const status of [408, 502, 503, 504]) {
  test(`hub ${status} falls back to direct`, async () => {
    const s = setup({
      fetchImpl: async () => jsonResponse(status, { error: { message: "x" }, code: "upstream" }),
    });
    const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
    assert.deepEqual(result, { text: "from direct", via: "direct" });
    assert.equal(s.directCount(), 1);
  });
}

for (const status of [400, 401, 413, 415]) {
  test(`hub ${status} throws and does not fall back`, async () => {
    const s = setup({
      fetchImpl: async () => jsonResponse(status, { error: { message: "no" }, code: "nope" }),
    });
    await assert.rejects(s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, "nope");
      return true;
    });
    assert.equal(s.directCount(), 0);
  });
}

test("a caller cancel does not fall back", async () => {
  const controller = new AbortController();
  const s = setup({
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        controller.abort();
      }),
  });
  await assert.rejects(
    s.hubFirst.withFallback(transcribe(s.hubFirst, { signal: controller.signal }), s.direct)
  );
  assert.equal(s.directCount(), 0);
});

for (const [label, hubUrl, key] of [
  ["no hub URL", "", DEVICE_KEY],
  ["no device key", HUB, null],
]) {
  test(`with ${label}, only direct is called`, async () => {
    const s = setup({
      hubUrl,
      key,
      fetchImpl: async () => assert.fail("hub must not be called"),
    });
    const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
    assert.deepEqual(result, { text: "from direct", via: "direct" });
    assert.equal(s.calls.length, 0);
    assert.equal(s.directCount(), 1);
  });
}

test("the Bearer header carries the device key", async () => {
  const s = setup({ fetchImpl: async () => jsonResponse(200, { text: "ok" }) });
  await s.hubFirst.transcribeViaHub(WAV);
  assert.equal(s.calls[0].init.headers.authorization, `Bearer ${DEVICE_KEY}`);
});

test("the trimmed header is sent only when asked", async () => {
  const s = setup({ fetchImpl: async () => jsonResponse(200, { text: "ok" }) });
  await s.hubFirst.transcribeViaHub(WAV, { clientTrimmed: true, language: "en", prompt: "hi" });
  await s.hubFirst.transcribeViaHub(WAV);
  assert.equal(s.calls[0].init.headers["x-rtech-client-trimmed"], "1");
  assert.equal(s.calls[0].init.body.get("language"), "en");
  assert.equal(s.calls[0].init.body.get("prompt"), "hi");
  assert.equal(s.calls[1].init.headers["x-rtech-client-trimmed"], undefined);
});

test("synthesizeViaHub posts JSON and returns audio and sample rate", async () => {
  const s = setup({
    fetchImpl: async () => jsonResponse(200, { audio_base64: "UklGRg==", sample_rate: 24000 }),
  });
  const result = await s.hubFirst.synthesizeViaHub({ text: "hello" });
  assert.deepEqual(result, { audio_base64: "UklGRg==", sample_rate: 24000 });
  assert.equal(s.calls[0].url, `${HUB}/api/voice/upstream/omnivoice/synthesize`);
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { text: "hello" });
  assert.equal(s.calls[0].init.headers.authorization, `Bearer ${DEVICE_KEY}`);
});

test("the device key never appears in logger output", async () => {
  const s = setup({ fetchImpl: async () => jsonResponse(503, { code: "upstream_busy" }) });
  await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  const n = setup({
    fetchImpl: async () => {
      throw new TypeError(`fetch failed`);
    },
  });
  await n.hubFirst.withFallback(transcribe(n.hubFirst), n.direct);
  const logs = [...s.logs, ...n.logs];
  assert.ok(logs.length > 0, "the fallback is logged");
  assert.ok(!JSON.stringify(logs).includes(DEVICE_KEY));
  assert.ok(!JSON.stringify(logs).includes("device-key-secret"));
});

function rateLimited(retryAfter) {
  const headers = { "content-type": "application/json" };
  if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
  return new Response(JSON.stringify({ error: { message: "slow down" }, code: "rate_limited" }), {
    status: 429,
    headers,
  });
}

test("a hub 429 is retried after Retry-After and then succeeds on the hub", async () => {
  const sleeps = [];
  let n = 0;
  const s = setup({
    sleeps,
    fetchImpl: async () => (++n < 3 ? rateLimited("1") : jsonResponse(200, { text: "from hub" })),
  });
  const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.deepEqual(result, { text: "from hub", via: "hub" });
  assert.equal(s.calls.length, 3);
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(s.directCount(), 0);
});

test("a hub 429 without Retry-After backs off exponentially", async () => {
  const sleeps = [];
  let n = 0;
  const s = setup({
    sleeps,
    fetchImpl: async () => (++n < 4 ? rateLimited() : jsonResponse(200, { text: "ok" })),
  });
  await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("a hub 429 that outlasts the retry bound throws and never falls back to direct", async () => {
  const sleeps = [];
  const s = setup({ sleeps, fetchImpl: async () => rateLimited("600") });
  await assert.rejects(s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "rate_limited");
    return true;
  });
  assert.equal(s.calls.length, 5);
  assert.ok(
    sleeps.every((ms) => ms === 10000),
    "each wait is capped"
  );
  assert.equal(s.directCount(), 0);
});

test("Retry-After as an HTTP date is honored", () => {
  const { rateLimitWaitMs } = require("../../src/helpers/hubFirst");
  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(rateLimitWaitMs("Tue, 29 Sep 2026 12:00:03 GMT", 0, now), 3000);
  assert.equal(rateLimitWaitMs("garbage", 1, now), 2000);
});

// A 2xx whose body is not JSON (a proxy or login page) is a
// hub failure and falls back, not a raw SyntaxError.
test("a 2xx HTML body falls back to direct", async () => {
  const s = setup({
    fetchImpl: async () =>
      new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.deepEqual(result, { text: "from direct", via: "direct" });
  assert.equal(s.directCount(), 1);
});

test("a 2xx body that stalls past the timeout falls back to direct", async () => {
  const s = setup({
    timeoutMs: 20,
    fetchImpl: async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await s.hubFirst.withFallback(transcribe(s.hubFirst), s.direct);
  assert.deepEqual(result, { text: "from direct", via: "direct" });
});

// The hub rejects a prompt over 1000 chars with a final 400
// and a synthesis body over 4 MB with a final 413.
test("the transcription prompt is capped at 1000 UTF-16 units", async () => {
  const s = setup({ fetchImpl: async () => jsonResponse(200, { text: "ok" }) });
  await s.hubFirst.transcribeViaHub(WAV, { prompt: "a".repeat(1500) });
  assert.equal(s.calls[0].init.body.get("prompt").length, 1000);
});

test("the prompt cap does not split a surrogate pair", () => {
  const { capPrompt } = require("../../src/helpers/hubFirst");
  const capped = capPrompt(`${"a".repeat(999)}\u{1F600}tail`);
  assert.equal(capped, "a".repeat(999));
  assert.equal(capPrompt("short"), "short");
});

test("a synthesis body over 4 MB is refused before it is sent", async () => {
  const s = setup({ fetchImpl: async () => jsonResponse(200, { audio_base64: "AAAA" }) });
  await assert.rejects(
    s.hubFirst.synthesizeViaHub({
      text: "hi",
      audio_base64: "A".repeat(4 * 1024 * 1024),
      prompt_text: "p",
    }),
    (error) => error.code === "payload_too_large" && error.fallback === false
  );
  assert.equal(s.calls.length, 0);
});
