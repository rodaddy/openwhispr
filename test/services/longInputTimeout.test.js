const test = require("node:test");
const assert = require("node:assert/strict");

const loadOpenai = () => import("../../src/services/ai/inferenceProviders/openai.ts");

const ctx = {
  getApiKey: async () => "test-key",
  getSystemPrompt: () => "Format the notes",
  getCustomDictionary: () => [],
  getPreferredLanguage: () => "en",
  getUiLanguage: () => "en",
  callChatCompletionsApi: async () => {
    throw new Error("Unexpected chat completions delegation");
  },
  calculateMaxTokens: () => 4096,
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

// POSTs never answer until their abort signal fires.
function hangingFetch(posts) {
  return async (input, init = {}) => {
    if ((init.method || "GET") === "GET") {
      return new Response("{}", { status: 404 });
    }
    posts.push(String(input));
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };
}

function callProvider(openaiProvider, config) {
  return openaiProvider.call({
    text: "a meeting transcript",
    model: "note-model",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: "https://notes.example/v1",
      customApiKey: "test-key",
      systemPrompt: "Format the notes",
      ...config,
    },
    ctx,
  });
}

test("processText's timeoutSeconds sets the request deadline and a timeout is not retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const posts = [];
  globalThis.fetch = hangingFetch(posts);

  const { openaiProvider } = await loadOpenai();
  let settled = false;
  const result = callProvider(openaiProvider, { timeoutSeconds: 240 });
  result.then(
    () => (settled = true),
    () => (settled = true)
  );

  await flush();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(settled, false, "the 30s default must not apply when a per-call timeout is set");

  t.mock.timers.tick(210_000);
  await assert.rejects(result, /timed out after 240s/);
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(posts.length, 1, "a timed-out long call must not be retried");
});

test("the deadline also covers a response body that stalls after its headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // Headers arrive at once; the body never finishes until the signal aborts.
  globalThis.fetch = async (_input, init = {}) => {
    if ((init.method || "GET") === "GET") {
      return new Response("{}", { status: 404 });
    }
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    };
  };

  const { openaiProvider } = await loadOpenai();
  const result = callProvider(openaiProvider, {
    baseUrl: "https://stall.example/v1",
    timeoutSeconds: 120,
  });
  result.catch(() => {});

  await flush();
  t.mock.timers.tick(120_000);
  await assert.rejects(result, /timed out after 120s/);
});

test("without timeoutSeconds a request keeps the 30-second default and its retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const posts = [];
  globalThis.fetch = hangingFetch(posts);

  const { openaiProvider } = await loadOpenai();
  const result = callProvider(openaiProvider, { baseUrl: "https://cleanup.example/v1" });
  result.catch(() => {});

  await flush();
  for (let round = 0; round < 8; round++) {
    t.mock.timers.tick(30_000);
    await flush();
  }
  await assert.rejects(result, /timed out after 30s/);
  assert.ok(posts.length > 1, `the default path retries timeouts (got ${posts.length})`);
});
