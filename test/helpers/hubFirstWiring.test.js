const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createHubFirst } = require("../../src/helpers/hubFirst");
const {
  transcribeSelfHostedDictation,
} = require("../../src/helpers/selfHostedDictationTranscription");
const { createAssistantSpeechService } = require("../../src/helpers/selfHostedAssistantSpeech");
const { transcribeSelfHostedChunk } = require("../../src/helpers/selfHostedMeetingTranscription");

// rtech-whisper#104 part 2: dictation and Skippy's voice try the hub first.

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

function hubWith({ url = "https://hub.example", key = "device-key", answer }) {
  const calls = [];
  const hubFirst = createHubFirst({
    getHubUrl: () => url,
    getDeviceKey: () => key,
    fetchImpl: async (target, init) => {
      calls.push({ target, init });
      return answer();
    },
  });
  return { hubFirst, calls };
}

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

function dictation(hubFirst) {
  const direct = [];
  const run = () =>
    transcribeSelfHostedDictation({
      audioBuffer: Buffer.from("recording"),
      endpoint: "https://stt.example/v1/audio/transcriptions",
      model: "parakeet",
      language: "en",
      normalizeAudio: async () => wavWithSeconds(5),
      trimAudio: (wav) => ({ wav, hasSpeech: true }),
      sleep: async () => {},
      transcribeChunk: async ({ endpoint }) => {
        direct.push(endpoint);
        return { success: true, text: "direct words" };
      },
      hubFirst,
    });
  return { run, direct };
}

test("dictation with no hub configured uses only the direct request", async () => {
  const { hubFirst, calls } = hubWith({ url: "", answer: () => reply(200, { text: "hub" }) });
  const d = dictation(hubFirst);
  const result = await d.run();
  assert.equal(result.text, "direct words");
  assert.equal(calls.length, 0);
  assert.deepEqual(d.direct, ["https://stt.example/v1/audio/transcriptions"]);
});

test("dictation with a hub answering 200 uses the hub, marks the chunk trimmed, skips direct", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(200, { text: "hub words" }) });
  const d = dictation(hubFirst);
  const result = await d.run();
  assert.equal(result.text, "hub words");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "https://hub.example/api/voice/v1/audio/transcriptions");
  assert.equal(calls[0].init.headers["x-rtech-client-trimmed"], "1");
  assert.equal(calls[0].init.headers.authorization, "Bearer device-key");
  assert.deepEqual(d.direct, []);
});

test("dictation falls back to direct when the hub answers 503", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(503, { code: "upstream_down" }) });
  const d = dictation(hubFirst);
  const result = await d.run();
  assert.equal(result.text, "direct words");
  assert.equal(calls.length, 1);
  assert.equal(d.direct.length, 1);
});

test("dictation surfaces a hub 401 without calling direct or retrying the hub", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(401, { code: "bad_key" }) });
  const d = dictation(hubFirst);
  await assert.rejects(d.run(), /Hub voice request failed \(401\)/);
  assert.equal(calls.length, 1);
  assert.deepEqual(d.direct, []);
});

function speech(hubFirst) {
  const direct = [];
  const service = createAssistantSpeechService({
    getConfig: async () => ({
      endpoint: "http://voice.local",
      referenceAudioBase64: "reference-audio",
      promptText: "Use the reference voice",
    }),
    fetchImpl: async (url) => {
      direct.push(url);
      return reply(200, { audio_base64: Buffer.from("direct").toString("base64") });
    },
    hubFirst,
  });
  return { speak: () => service.synthesize("desktop", "r1", " Hello "), direct };
}

const audioText = (result) => Buffer.from(result.audio).toString();

test("speech with no hub configured uses only the direct request", async () => {
  const { hubFirst, calls } = hubWith({ key: "", answer: () => reply(200, {}) });
  const s = speech(hubFirst);
  assert.equal(audioText(await s.speak()), "direct");
  assert.equal(calls.length, 0);
  assert.deepEqual(s.direct, ["http://voice.local/upstream/omnivoice/synthesize"]);
});

test("speech with a hub answering 200 uses the hub and skips direct", async () => {
  const { hubFirst, calls } = hubWith({
    answer: () => reply(200, { audio_base64: Buffer.from("hub").toString("base64") }),
  });
  const s = speech(hubFirst);
  assert.equal(audioText(await s.speak()), "hub");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "https://hub.example/api/voice/upstream/omnivoice/synthesize");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: "Hello",
    audio_base64: "reference-audio",
    prompt_text: "Use the reference voice",
  });
  assert.deepEqual(s.direct, []);
});

test("speech falls back to direct when the hub answers 503", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(503, {}) });
  const s = speech(hubFirst);
  assert.equal(audioText(await s.speak()), "direct");
  assert.equal(calls.length, 1);
  assert.equal(s.direct.length, 1);
});

// rtech-whisper#104 part 3: meeting and live-preview chunks, and grill speech.

function meetingChunk(hubFirst) {
  const direct = [];
  const run = () =>
    transcribeSelfHostedChunk({
      endpoint: "https://stt.example/v1/audio/transcriptions",
      model: "parakeet",
      language: "en",
      wav: wavWithSeconds(1),
      fetchImpl: async (url) => {
        direct.push(url);
        return reply(200, { text: "direct words" });
      },
      hubFirst,
    });
  return { run, direct };
}

test("a meeting chunk with no hub configured uses only the direct request", async () => {
  const { hubFirst, calls } = hubWith({ url: "", answer: () => reply(200, { text: "hub" }) });
  const m = meetingChunk(hubFirst);
  assert.deepEqual(await m.run(), { success: true, text: "direct words" });
  assert.equal(calls.length, 0);
  assert.deepEqual(m.direct, ["https://stt.example/v1/audio/transcriptions"]);
});

test("a meeting chunk goes to the hub without the client-trimmed header", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(200, { text: "hub words" }) });
  const m = meetingChunk(hubFirst);
  assert.deepEqual(await m.run(), { success: true, text: "hub words" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "https://hub.example/api/voice/v1/audio/transcriptions");
  assert.equal("x-rtech-client-trimmed" in calls[0].init.headers, false);
  assert.equal(calls[0].init.body.get("language"), "en");
  assert.deepEqual(m.direct, []);
});

test("a meeting chunk falls back to direct when the hub answers 504", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(504, { code: "upstream_timeout" }) });
  const m = meetingChunk(hubFirst);
  assert.deepEqual(await m.run(), { success: true, text: "direct words" });
  assert.equal(calls.length, 1);
  assert.equal(m.direct.length, 1);
});

test("a meeting chunk surfaces a hub 401 without calling direct", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(401, { code: "bad_key" }) });
  const m = meetingChunk(hubFirst);
  await assert.rejects(m.run(), (error) => error.status === 401);
  assert.equal(calls.length, 1);
  assert.deepEqual(m.direct, []);
});

test("grill speech in a chosen voice uses the hub", async () => {
  const { hubFirst, calls } = hubWith({
    answer: () => reply(200, { audio_base64: Buffer.from("hub").toString("base64") }),
  });
  const direct = [];
  const grill = createAssistantSpeechService({
    getConfig: async (voice) => ({
      endpoint: "http://voice.local",
      referenceAudioBase64: `${voice}-audio`,
      promptText: `${voice} prompt`,
    }),
    fetchImpl: async (url) => {
      direct.push(url);
      return reply(200, { audio_base64: Buffer.from("direct").toString("base64") });
    },
    hubFirst,
  });
  const result = await grill.synthesize("grill", "g1", "Why?", "rico");
  assert.equal(audioText(result), "hub");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: "Why?",
    audio_base64: "rico-audio",
    prompt_text: "rico prompt",
  });
  assert.deepEqual(direct, []);
});

// The call sites live inside the IPCHandlers registration closure, so — like
// meetingStreamingWiring.test.js — the wiring is pinned at the source level.
// Each pin names one call site; dropping its hubFirst argument fails it.
const ipcSource = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
const callSite = (anchor) => {
  const start = ipcSource.indexOf(anchor);
  assert.notEqual(start, -1, `call site not found: ${anchor}`);
  return ipcSource.slice(start, ipcSource.indexOf("});", start));
};

test("the meeting chunk call passes hubFirst", () => {
  assert.match(callSite("endpoint: meetingSelfHostedEndpoint,"), /\bhubFirst,/);
});

test("the live preview chunk call passes hubFirst", () => {
  assert.match(callSite("endpoint: dictationPreviewEndpoint,"), /\bhubFirst,/);
});

test("the dictation call passes hubFirst", () => {
  assert.match(callSite("audioBuffer: Buffer.from(options.audioBuffer),"), /\bhubFirst,/);
});

test("the retry-transcription dictation call passes hubFirst", () => {
  assert.match(
    callSite("audioBuffer: buffer,\n            endpoint: route.endpoint,"),
    /\bhubFirst,/
  );
});

test("assistant speech and grill speech services pass hubFirst", () => {
  assert.match(callSite("getConfig: async () => assistantSpeechProfile.read(),"), /\bhubFirst,/);
  assert.match(
    callSite("getConfig: async (voice) => grillVoiceStore.resolveConfig(voice),"),
    /\bhubFirst,/
  );
});

test("speech surfaces a hub 401 and does not call direct", async () => {
  const { hubFirst, calls } = hubWith({ answer: () => reply(401, { code: "bad_key" }) });
  const s = speech(hubFirst);
  await assert.rejects(s.speak(), (error) => error.status === 401);
  assert.equal(calls.length, 1);
  assert.deepEqual(s.direct, []);
});
