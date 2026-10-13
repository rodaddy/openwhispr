const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/selfHostedMeetingTranscription.js");

test("posts the wav chunk as multipart form data and returns the transcript", async () => {
  const { transcribeSelfHostedChunk } = await load();

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ text: " hello " }) };
  };

  const result = await transcribeSelfHostedChunk({
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: "whisper-1",
    language: "en",
    prompt: "OpenWhispr, Parakeet",
    wav: Buffer.from([1, 2, 3, 4]),
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:8000/v1/audio/transcriptions");
  assert.equal(calls[0].init.method, "POST");

  const body = calls[0].init.body;
  assert.ok(body instanceof FormData);
  const file = body.get("file");
  assert.equal(file.name, "chunk.wav");
  assert.equal(file.type, "audio/wav");
  assert.equal(body.get("model"), "whisper-1");
  assert.equal(body.get("language"), "en");
  assert.equal(body.get("prompt"), "OpenWhispr, Parakeet");

  assert.deepEqual(result, { success: true, text: " hello " });
});

test("omits model and language when they are not set and requires a text string", async () => {
  const { transcribeSelfHostedChunk } = await load();

  let body = null;
  const fetchImpl = async (_url, init) => {
    body = init.body;
    return { ok: true, json: async () => ({ text: "" }) };
  };

  const result = await transcribeSelfHostedChunk({
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: null,
    language: null,
    wav: Buffer.from([1, 2, 3, 4]),
    fetchImpl,
  });

  assert.equal(body.has("model"), false);
  assert.equal(body.has("language"), false);
  assert.deepEqual(result, { success: true, text: "" });
});

test("rejects a successful response without a text string", async () => {
  const { transcribeSelfHostedChunk } = await load();
  await assert.rejects(
    transcribeSelfHostedChunk({
      endpoint: "http://localhost:8000/v1/audio/transcriptions",
      wav: Buffer.from([1]),
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }),
    /missing a text string/
  );
});

test("throws with the status and response body on a failed request", async () => {
  const { transcribeSelfHostedChunk } = await load();

  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    text: async () => "no router",
  });

  await assert.rejects(
    () =>
      transcribeSelfHostedChunk({
        endpoint: "http://localhost:8000/v1/audio/transcriptions",
        model: "whisper-1",
        language: "en",
        wav: Buffer.from([1, 2, 3, 4]),
        fetchImpl,
      }),
    /404 no router/
  );
});

test("optionally forwards server-owned bearer auth and an abort signal", async () => {
  const { transcribeSelfHostedChunk } = await load();
  const controller = new AbortController();
  let requestInit;
  await transcribeSelfHostedChunk({
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: "whisper-1",
    wav: Buffer.from([1]),
    apiKey: "server-secret",
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      requestInit = init;
      return { ok: true, json: async () => ({ text: "ok" }) };
    },
  });
  assert.deepEqual(requestInit.headers, { authorization: "Bearer server-secret" });
  assert.equal(requestInit.signal, controller.signal);
});
