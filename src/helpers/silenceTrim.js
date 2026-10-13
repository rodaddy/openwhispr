const { findWavData, makePcmWav } = require("./selfHostedDictationTranscription");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

const msToBytes = (ms) => Math.round((ms / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE;
const bytesToMs = (bytes) => Math.round((bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000);

function frameRms(pcm, start, end) {
  let sum = 0;
  let count = 0;
  for (let offset = start; offset + 1 < end; offset += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(offset) / 32768;
    sum += sample * sample;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

/**
 * Trim leading/trailing silence and shorten long inner silences in a
 * 16 kHz mono PCM16 WAV buffer. Pure; no I/O.
 *
 * The speech threshold adapts to the recording: a real mic's "silence" is room
 * noise, not zero. Measured on Rico's dictations (2026-09-29) the quiet frames
 * sat at RMS 0.007-0.009, so a fixed 0.01 kept every frame and trimmed nothing.
 * Default threshold = noiseFactor x the 10th-percentile frame RMS, floored at
 * minSpeechRms. Passing speechRms overrides it.
 */
function trimSilence(wavBuffer, options = {}) {
  const {
    frameMs = 30,
    speechRms,
    minSpeechRms = 0.004,
    noiseFactor = 2.5,
    padMs = 300,
    maxGapMs = 1000,
    keepGapMs = 400,
  } = options;

  const { offset, size } = findWavData(wavBuffer);
  const pcm = wavBuffer.subarray(offset, offset + size);
  const originalMs = bytesToMs(pcm.length);
  const frameBytes = msToBytes(frameMs);
  if (!frameBytes || !pcm.length) {
    return { wav: wavBuffer, hasSpeech: false, keptMs: originalMs, originalMs };
  }

  const frameCount = Math.ceil(pcm.length / frameBytes);
  const rms = new Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    const start = index * frameBytes;
    rms[index] = frameRms(pcm, start, Math.min(start + frameBytes, pcm.length));
  }
  let threshold = speechRms;
  if (threshold === undefined) {
    const sorted = [...rms].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(0.1 * (sorted.length - 1))];
    threshold = Math.max(minSpeechRms, noiseFloor * noiseFactor);
  }

  const speech = new Array(frameCount);
  let first = -1;
  let last = -1;
  for (let index = 0; index < frameCount; index += 1) {
    const isSpeech = rms[index] >= threshold;
    speech[index] = isSpeech;
    if (isSpeech) {
      if (first === -1) first = index;
      last = index;
    }
  }
  if (first === -1) {
    return { wav: wavBuffer, hasSpeech: false, keptMs: 0, originalMs };
  }

  const padFrames = Math.ceil(padMs / frameMs);
  const startFrame = Math.max(0, first - padFrames);
  const endFrame = Math.min(frameCount - 1, last + padFrames);
  const maxGapBytes = msToBytes(maxGapMs);
  const keepEdgeBytes = msToBytes(keepGapMs / 2);

  const pieces = [];
  let runStart = startFrame;
  const flushRun = (runEndFrame) => {
    const startByte = runStart * frameBytes;
    const endByte = Math.min((runEndFrame + 1) * frameBytes, pcm.length);
    const length = endByte - startByte;
    if (length <= 0) return;
    if (speech[runStart] || length <= maxGapBytes) {
      pieces.push(pcm.subarray(startByte, endByte));
      return;
    }
    pieces.push(pcm.subarray(startByte, startByte + keepEdgeBytes));
    pieces.push(pcm.subarray(endByte - keepEdgeBytes, endByte));
  };

  for (let index = startFrame + 1; index <= endFrame; index += 1) {
    if (speech[index] !== speech[runStart]) {
      flushRun(index - 1);
      runStart = index;
    }
  }
  flushRun(endFrame);

  const trimmed = Buffer.concat(pieces);
  return {
    wav: makePcmWav(trimmed),
    hasSpeech: true,
    keptMs: bytesToMs(trimmed.length),
    originalMs,
  };
}

module.exports = { trimSilence };
