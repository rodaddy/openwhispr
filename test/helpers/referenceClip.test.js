const assert = require("node:assert/strict");
const test = require("node:test");
const {
  analyzeReference,
  buildPcm16Wav,
  countWords,
  planClip,
  readPcm16Wav,
  sliceWav,
} = require("../../src/helpers/referenceClip");

const SAMPLE_RATE = 100;

// A clip of non-zero bytes, so a slice is recognisable and silence stands out.
function makeClip(seconds, channels = 1) {
  const pcm = Buffer.alloc(seconds * SAMPLE_RATE * channels * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 251) + 1;
  return buildPcm16Wav({ sampleRate: SAMPLE_RATE, channels, pcm });
}

test("planClip refuses short and long clips, keeps a short one whole and windows the rest", () => {
  assert.deepEqual(planClip(2.9), { kind: "too-short" });
  assert.deepEqual(planClip(3), { kind: "whole" });
  assert.deepEqual(planClip(20), { kind: "whole" });
  assert.deepEqual(planClip(20.1), {
    kind: "windows",
    windows: [{ index: 1, startSec: 0, endSec: 15 }],
  });
  assert.deepEqual(planClip(47), {
    kind: "windows",
    windows: [
      { index: 1, startSec: 0, endSec: 15 },
      { index: 2, startSec: 15, endSec: 30 },
      { index: 3, startSec: 30, endSec: 45 },
    ],
  });
  assert.equal(planClip(75).windows.length, 5);
  assert.deepEqual(planClip(75.1), { kind: "too-long" });
});

test("planClip judges the length to a tenth of a second", () => {
  assert.deepEqual(planClip(20.04), { kind: "whole" });
  assert.deepEqual(planClip(2.96), { kind: "whole" });
});

test("sliceWav cuts a stereo clip to the requested time range", () => {
  const source = makeClip(45, 2);
  const slice = readPcm16Wav(sliceWav(source, 15, 30));
  const bytesPerSecond = SAMPLE_RATE * 2 * 2;
  assert.equal(slice.durationSec, 15);
  assert.equal(slice.sampleRate, SAMPLE_RATE);
  assert.equal(slice.channels, 2);
  assert.deepEqual(
    Buffer.from(slice.pcm),
    Buffer.from(readPcm16Wav(source).pcm.subarray(15 * bytesPerSecond, 30 * bytesPerSecond))
  );
});

test("a clip up to 20 s is transcribed whole, with 300 ms of silence in front", async () => {
  const clip = makeClip(10);
  const sent = [];
  const result = await analyzeReference({
    wav: clip,
    transcribe: async (wav) => {
      sent.push(wav);
      return "  the whole clip  ";
    },
  });
  assert.deepEqual(result, { kind: "whole", durationSec: 10, text: "the whole clip" });
  assert.equal(sent.length, 1);
  const padBytes = 0.3 * SAMPLE_RATE * 2;
  const padded = readPcm16Wav(sent[0]).pcm;
  assert.equal(padded.length, readPcm16Wav(clip).pcm.length + padBytes);
  assert.ok(padded.subarray(0, padBytes).every((byte) => byte === 0));
  assert.notEqual(padded[padBytes], 0);
});

test("countWords counts words in scripts with and without spaces", () => {
  assert.equal(countWords("Exact spoken words"), 3);
  assert.ok(countWords("这是一个测试") > 1);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  "), 0);
  assert.equal(countWords(null), 0);
});

test("a longer clip keeps the earliest window with the most words, one request at a time", async () => {
  const transcripts = ["one two", " one two three four five ", "five other words right here"];
  let calls = 0;
  let pending = false;
  const result = await analyzeReference({
    wav: makeClip(45),
    transcribe: async () => {
      assert.equal(pending, false, "a window started while another was pending");
      pending = true;
      const text = transcripts[calls++];
      await new Promise((resolve) => setImmediate(resolve));
      pending = false;
      return text;
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, {
    kind: "window",
    durationSec: 45,
    text: "one two three four five",
    window: { index: 2, count: 3, startSec: 15, endSec: 30 },
  });
});

test("a clip under 3 s or over 75 s is refused without transcribing", async () => {
  let calls = 0;
  const transcribe = async () => {
    calls++;
    return "never";
  };
  assert.deepEqual(await analyzeReference({ wav: makeClip(2), transcribe }), {
    kind: "too-short",
    durationSec: 2,
  });
  assert.deepEqual(await analyzeReference({ wav: makeClip(80), transcribe }), {
    kind: "too-long",
    durationSec: 80,
  });
  assert.equal(calls, 0);
});

test("readPcm16Wav refuses a float WAV", () => {
  const floatWav = makeClip(1);
  floatWav.writeUInt16LE(3, 20);
  assert.throws(() => readPcm16Wav(floatWav), {
    message: "Reference audio must be 16-bit PCM WAV",
  });
});
