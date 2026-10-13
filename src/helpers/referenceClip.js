const MIN_CLIP_SEC = 3;
const WHOLE_CLIP_MAX_SEC = 20;
const WINDOW_SEC = 15;
const MAX_CLIP_SEC = 75;
const TRANSCRIBE_PAD_MS = 300;

const WAV_ERROR = "Reference audio must be 16-bit PCM WAV";
const WAV_HEADER_BYTES = 44;

// Every WAV here is 16-bit PCM; the caller converts anything else first.
function readPcm16Wav(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 12 ||
    buffer.toString("latin1", 0, 4) !== "RIFF" ||
    buffer.toString("latin1", 8, 12) !== "WAVE"
  )
    throw new Error(WAV_ERROR);
  let format = null;
  let pcm = null;
  let offset = 12;
  while (offset + 8 <= buffer.length && !(format && pcm)) {
    const id = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && size >= 16 && start + 16 <= buffer.length) {
      format = {
        tag: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      // A size field past the end of the file is clamped to what is there.
      pcm = buffer.subarray(start, Math.min(start + size, buffer.length));
    }
    // Chunks are padded to an even size.
    offset = start + size + (size % 2);
  }
  if (
    !format ||
    !pcm ||
    format.tag !== 1 ||
    format.bitsPerSample !== 16 ||
    !format.channels ||
    !format.sampleRate
  )
    throw new Error(WAV_ERROR);
  const { sampleRate, channels } = format;
  return { sampleRate, channels, pcm, durationSec: pcm.length / (sampleRate * channels * 2) };
}

function buildPcm16Wav({ sampleRate, channels, pcm }) {
  const blockAlign = channels * 2;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Cut on whole frames, so a channel pair is never split.
function sliceWav(buffer, startSec, endSec) {
  const { sampleRate, channels, pcm } = readPcm16Wav(buffer);
  const frameBytes = channels * 2;
  const frames = Math.floor(pcm.length / frameBytes);
  const startFrame = Math.min(Math.max(Math.round(startSec * sampleRate), 0), frames);
  const endFrame = Math.min(Math.max(Math.round(endSec * sampleRate), startFrame), frames);
  return buildPcm16Wav({
    sampleRate,
    channels,
    pcm: pcm.subarray(startFrame * frameBytes, endFrame * frameBytes),
  });
}

// The silence goes in front of the audio.
function padSilence(buffer, ms = TRANSCRIBE_PAD_MS) {
  const { sampleRate, channels, pcm } = readPcm16Wav(buffer);
  const silence = Buffer.alloc(Math.round((sampleRate * ms) / 1000) * channels * 2);
  return buildPcm16Wav({ sampleRate, channels, pcm: Buffer.concat([silence, pcm]) });
}

function planClip(exactDurationSec) {
  // To a tenth of a second: resampling moves a clip's length by a few samples.
  const durationSec = Math.round(exactDurationSec * 10) / 10;
  if (durationSec < MIN_CLIP_SEC) return { kind: "too-short" };
  if (durationSec <= WHOLE_CLIP_MAX_SEC) return { kind: "whole" };
  if (durationSec > MAX_CLIP_SEC) return { kind: "too-long" };
  // Whole windows only: a remainder shorter than a window is left out.
  const windows = [];
  for (let index = 1; index <= Math.floor(durationSec / WINDOW_SEC); index++)
    windows.push({ index, startSec: (index - 1) * WINDOW_SEC, endSec: index * WINDOW_SEC });
  return { kind: "windows", windows };
}

// Word segmentation, so a transcript without spaces (Chinese, Japanese) counts
// its words rather than one.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function countWords(text) {
  if (typeof text !== "string") return 0;
  let words = 0;
  for (const segment of wordSegmenter.segment(text)) if (segment.isWordLike) words++;
  return words;
}

async function analyzeReference({ wav, transcribe }) {
  const { durationSec } = readPcm16Wav(wav);
  const plan = planClip(durationSec);
  if (plan.kind === "too-short" || plan.kind === "too-long")
    return { kind: plan.kind, durationSec };
  // The padding goes only on the copy that is transcribed.
  if (plan.kind === "whole") {
    const text = String((await transcribe(padSilence(wav))) ?? "").trim();
    return { kind: "whole", durationSec, text };
  }
  let best = null;
  // One window at a time: the server allows two requests at once and other
  // calls share it.
  for (const window of plan.windows) {
    const text = String(
      (await transcribe(padSilence(sliceWav(wav, window.startSec, window.endSec)))) ?? ""
    ).trim();
    const words = countWords(text);
    // Strictly more, so equal counts keep the earliest window.
    if (!best || words > best.words) best = { window, text, words };
  }
  const { index, startSec, endSec } = best.window;
  return {
    kind: "window",
    durationSec,
    text: best.text,
    window: { index, count: plan.windows.length, startSec, endSec },
  };
}

module.exports = {
  MIN_CLIP_SEC,
  WHOLE_CLIP_MAX_SEC,
  WINDOW_SEC,
  MAX_CLIP_SEC,
  TRANSCRIBE_PAD_MS,
  readPcm16Wav,
  buildPcm16Wav,
  sliceWav,
  padSilence,
  planClip,
  countWords,
  analyzeReference,
};
