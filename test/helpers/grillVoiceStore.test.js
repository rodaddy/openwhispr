const assert = require("node:assert/strict");
const test = require("node:test");
const { createGrillVoiceStore } = require("../../src/helpers/grillVoiceStore");
const { createAssistantSpeechService } = require("../../src/helpers/selfHostedAssistantSpeech");

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const copies = [];
  return {
    files,
    copies,
    existsSync: (file) => files.has(file),
    readFileSync: (file) => Buffer.from(files.get(file)),
    mkdirSync: () => {},
    copyFileSync: (source, destination) => {
      copies.push([source, destination]);
      files.set(destination, "clip-bytes");
    },
  };
}

const ASSISTANT_PROFILE = {
  endpoint: "http://voice",
  promptText: "Skippy transcript",
  referenceAudioBase64: "skippy-audio",
};

function store(fs, overrides = {}) {
  return createGrillVoiceStore({
    fs,
    voicesDir: "/user/grill-voices",
    endpoint: "http://voice",
    readAssistantProfile: () => ASSISTANT_PROFILE,
    chooseWav: async () => "/picked/morgan.wav",
    ...overrides,
  });
}

test("no voice (Skippy) resolves to the assistant's voice profile", () => {
  const voices = store(fakeFs());
  assert.deepEqual(voices.resolveConfig(null), ASSISTANT_PROFILE);
  assert.deepEqual(voices.resolveConfig(undefined), ASSISTANT_PROFILE);
  assert.deepEqual(
    voices.resolveConfig({ referenceAudioPath: "", promptText: "" }),
    ASSISTANT_PROFILE
  );
});

test("a custom voice resolves to its own clip and transcript", () => {
  const fs = fakeFs({ "/user/grill-voices/voice-1.wav": "morgan-bytes" });
  const config = store(fs).resolveConfig({
    referenceAudioPath: "/user/grill-voices/voice-1.wav",
    promptText: " Hi, this is Morgan. ",
  });
  assert.deepEqual(config, {
    endpoint: "http://voice",
    promptText: "Hi, this is Morgan.",
    referenceAudioBase64: Buffer.from("morgan-bytes").toString("base64"),
  });
});

test("a clip outside the voices folder, a missing clip, or no transcript is not configured", () => {
  const fs = fakeFs({ "/etc/passwd": "x", "/user/grill-voices/voice-1.wav": "y" });
  const voices = store(fs);
  assert.equal(voices.resolveConfig({ referenceAudioPath: "/etc/passwd", promptText: "t" }), null);
  assert.equal(
    voices.resolveConfig({
      referenceAudioPath: "/user/grill-voices/../../etc/passwd",
      promptText: "t",
    }),
    null
  );
  assert.equal(
    voices.resolveConfig({ referenceAudioPath: "/user/grill-voices/missing.wav", promptText: "t" }),
    null
  );
  assert.equal(
    voices.resolveConfig({ referenceAudioPath: "/user/grill-voices/voice-1.wav", promptText: " " }),
    null
  );
});

test("importing a clip copies the chosen WAV into the voices folder", async () => {
  const fs = fakeFs();
  const result = await store(fs).importClip();
  assert.equal(result.success, true);
  assert.equal(fs.copies[0][0], "/picked/morgan.wav");
  assert.match(result.referenceAudioPath, /^\/user\/grill-voices\/voice-.*\.wav$/);
  assert.equal(fs.copies[0][1], result.referenceAudioPath);

  const canceled = await store(fakeFs(), { chooseWav: async () => null }).importClip();
  assert.deepEqual(canceled, { success: false, canceled: true });
});

test("the grill speech service posts the selected voice's clip; the assistant call is unchanged", async () => {
  const fs = fakeFs({ "/user/grill-voices/voice-1.wav": "morgan-bytes" });
  const voices = store(fs);
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ audio_base64: "AAAA" }) };
  };
  const assistantConfigArgs = [];
  const assistant = createAssistantSpeechService({
    fetchImpl,
    getConfig: async (...args) => {
      assistantConfigArgs.push(args);
      return ASSISTANT_PROFILE;
    },
  });
  const grill = createAssistantSpeechService({
    fetchImpl,
    getConfig: async (voice) => voices.resolveConfig(voice),
  });

  await assistant.synthesize("chat-view", "r1", "Hello");
  await grill.synthesize("grill", "r2", "Next question?", {
    referenceAudioPath: "/user/grill-voices/voice-1.wav",
    promptText: "Hi.",
  });
  await grill.synthesize("grill", "r3", "Skippy question?", null);

  assert.deepEqual(bodies[0], {
    text: "Hello",
    audio_base64: "skippy-audio",
    prompt_text: "Skippy transcript",
    seed: 42,
    num_steps: 16,
    language: "en",
    guidance_scale: 1.2,
  });
  // The non-grill assistant call passes no voice to its profile reader.
  assert.equal(assistantConfigArgs[0][0], undefined);
  assert.deepEqual(bodies[1], {
    text: "Next question?",
    audio_base64: Buffer.from("morgan-bytes").toString("base64"),
    prompt_text: "Hi.",
    seed: 42,
    num_steps: 16,
    language: "en",
    guidance_scale: 1.2,
  });
  assert.equal(bodies[2].audio_base64, "skippy-audio");
});
