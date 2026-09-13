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

  assert.deepEqual(result, { success: true, text: " hello " });
});

test("omits model and language when they are not set", async () => {
  const { transcribeSelfHostedChunk } = await load();

  let body = null;
  const fetchImpl = async (_url, init) => {
    body = init.body;
    return { ok: true, json: async () => ({}) };
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

test("sends a bearer Authorization header when apiKey is set", async () => {
  const { transcribeSelfHostedChunk } = await load();

  let init = null;
  const fetchImpl = async (_url, requestInit) => {
    init = requestInit;
    return { ok: true, json: async () => ({ text: "ok" }) };
  };

  await transcribeSelfHostedChunk({
    endpoint: "http://localhost:8000/v1/audio/transcriptions",
    model: "whisper-1",
    language: "en",
    wav: Buffer.from([1, 2, 3, 4]),
    fetchImpl,
    apiKey: "  sk-test-key  ",
  });

  assert.equal(init.headers.Authorization, "Bearer sk-test-key");
  // FormData must own the Content-Type so the multipart boundary is set.
  assert.equal(init.headers["Content-Type"], undefined);
});

test("sends no Authorization header when apiKey is missing or blank", async () => {
  const { transcribeSelfHostedChunk } = await load();

  const seen = [];
  const fetchImpl = async (_url, requestInit) => {
    seen.push(requestInit.headers);
    return { ok: true, json: async () => ({ text: "ok" }) };
  };

  for (const apiKey of [undefined, null, "", "   "]) {
    await transcribeSelfHostedChunk({
      endpoint: "http://localhost:8000/v1/audio/transcriptions",
      model: "whisper-1",
      language: "en",
      wav: Buffer.from([1, 2, 3, 4]),
      fetchImpl,
      apiKey,
    });
  }

  assert.equal(seen.length, 4);
  for (const headers of seen) {
    assert.equal(headers?.Authorization, undefined);
  }
});
