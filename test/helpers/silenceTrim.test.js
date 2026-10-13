const test = require("node:test");
const assert = require("node:assert/strict");

const { trimSilence } = require("../../src/helpers/silenceTrim");
const { makePcmWav, findWavData } = require("../../src/helpers/selfHostedDictationTranscription");

const SAMPLE_RATE = 16000;

function silence(ms) {
  return Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE) * 2);
}

function speech(ms) {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE) * 0.2;
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return pcm;
}

const wavOf = (...parts) => makePcmWav(Buffer.concat(parts));
const pcmMs = (wav) => {
  const { size } = findWavData(wav);
  return Math.round((size / 2 / SAMPLE_RATE) * 1000);
};

test("pure silence reports no speech and returns the wav untouched", () => {
  const wav = wavOf(silence(2000));
  const result = trimSilence(wav);
  assert.equal(result.hasSpeech, false);
  assert.equal(result.wav, wav);
  assert.equal(result.originalMs, 2000);
});

test("trailing silence is cut back to the speech plus the pad", () => {
  const result = trimSilence(wavOf(speech(1000), silence(10000)));
  assert.equal(result.hasSpeech, true);
  assert.equal(result.originalMs, 11000);
  assert.ok(result.keptMs >= 1250 && result.keptMs <= 1360, `keptMs=${result.keptMs}`);
  assert.equal(pcmMs(result.wav), result.keptMs);
});

test("a long inner gap is shortened to the kept gap length", () => {
  const result = trimSilence(wavOf(speech(1000), silence(3000), speech(1000)));
  assert.equal(result.hasSpeech, true);
  assert.ok(result.keptMs >= 2350 && result.keptMs <= 2500, `keptMs=${result.keptMs}`);
});

test("leading silence is kept up to the pad", () => {
  const result = trimSilence(wavOf(silence(2000), speech(1000)));
  assert.ok(result.keptMs >= 1250 && result.keptMs <= 1360, `keptMs=${result.keptMs}`);
});

// A real mic's "silence" is room noise, not zeros. Rico's dictations measured
// RMS 0.007-0.009 in their quiet frames (2026-09-29); a fixed 0.01 threshold
// kept all of it. Deterministic noise at that level stands in for the room.
function roomNoise(ms, rms = 0.008) {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const pcm = Buffer.alloc(samples * 2);
  let seed = 12345;
  for (let index = 0; index < samples; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const uniform = seed / 2147483648 - 0.5; // RMS of uniform(-0.5, 0.5) is 0.2887
    pcm.writeInt16LE(Math.round((uniform / 0.2887) * rms * 32767), index * 2);
  }
  return pcm;
}

test("a noisy silent tail is trimmed, not mistaken for speech", () => {
  const result = trimSilence(wavOf(roomNoise(500), speech(3000), roomNoise(13000)));
  assert.equal(result.hasSpeech, true);
  assert.equal(result.originalMs, 16500);
  assert.ok(result.keptMs >= 3500 && result.keptMs <= 3700, `keptMs=${result.keptMs}`);
});

test("room noise alone reports no speech", () => {
  const result = trimSilence(wavOf(roomNoise(5000)));
  assert.equal(result.hasSpeech, false);
});
