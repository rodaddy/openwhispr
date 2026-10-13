/**
 * Pure text and WAV framing for the `omnivoice-tts` sidecar: how text is cut into the lines it
 * reads, and how the bytes it writes back become one WAV. No process and no I/O.
 *
 * Measured facts about the sidecar (`--stream-by-line -o -`):
 * - stdout carries one WAV per input line: a 44-byte header whose RIFF and data sizes are the
 *   placeholder 0x7fffffff, then 24 kHz mono s16le PCM.
 * - A line longer than 750 codepoints is rendered as several chunks, each with its own
 *   `[TTS-Stream] Done` line on stderr; a shorter line is always exactly one chunk.
 */

const NO_AUDIO_MESSAGE = "Local speech returned no audio";
const WAV_SCAN_BYTES = 256;
const MAX_LINE_CODEPOINTS = 600;

function toSingleLine(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim();
}

const codepointCount = (value) => Array.from(value).length;

function hardCut(run, limit) {
  const codepoints = Array.from(run);
  const pieces = [];
  for (let index = 0; index < codepoints.length; index += limit) {
    pieces.push(codepoints.slice(index, index + limit).join(""));
  }
  return pieces;
}

// Greedy: joins units with one space into segments of at most `limit` codepoints.
function packUnits(units, limit) {
  const segments = [];
  let segment = "";
  let length = 0;
  for (const unit of units) {
    const size = codepointCount(unit);
    if (length > 0 && length + 1 + size <= limit) {
      segment += ` ${unit}`;
      length += 1 + size;
      continue;
    }
    if (length > 0) segments.push(segment);
    segment = unit;
    length = size;
  }
  if (length > 0) segments.push(segment);
  return segments;
}

// Cuts text into lines the sidecar renders as exactly one chunk each (one Done line per line).
function splitForSidecar(text, maxCodepoints = MAX_LINE_CODEPOINTS) {
  const line = toSingleLine(text);
  if (!line) return [];
  const limit =
    Number.isInteger(maxCodepoints) && maxCodepoints > 0 ? maxCodepoints : MAX_LINE_CODEPOINTS;
  const fits = (value) => codepointCount(value) <= limit;
  if (fits(line)) return [line];

  const units = line.split(/(?<=[.!?…]) /).flatMap((sentence) => {
    if (fits(sentence)) return [sentence];
    const words = sentence
      .split(" ")
      .flatMap((word) => (fits(word) ? [word] : hardCut(word, limit)));
    return packUnits(words, limit);
  });
  return packUnits(units, limit);
}

function parseSidecarWav(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 12 ||
    buffer.toString("latin1", 0, 4) !== "RIFF" ||
    buffer.toString("latin1", 8, 12) !== "WAVE"
  ) {
    throw new Error(NO_AUDIO_MESSAGE);
  }

  // Walk the chunks: a tag match inside another chunk's payload is not the data chunk.
  let pcmOffset = -1;
  let isMono16 = false;
  let offset = 12;
  while (offset + 8 <= buffer.length && offset + 8 <= WAV_SCAN_BYTES) {
    const tag = buffer.toString("latin1", offset, offset + 4);
    if (tag === "data") {
      pcmOffset = offset + 8;
      break;
    }
    const size = buffer.readUInt32LE(offset + 4);
    // The sidecar writes 16-bit mono PCM; a header that says otherwise is not its audio.
    if (tag === "fmt " && size >= 16 && offset + 24 <= buffer.length) {
      isMono16 =
        buffer.readUInt16LE(offset + 8) === 1 &&
        buffer.readUInt16LE(offset + 10) === 1 &&
        buffer.readUInt16LE(offset + 22) === 16;
    }
    offset += 8 + size + (size % 2);
  }
  if (pcmOffset === -1 || !isMono16) throw new Error(NO_AUDIO_MESSAGE);

  const pcmBytes = buffer.length - pcmOffset;
  if (pcmBytes < 2 || pcmBytes % 2 !== 0) throw new Error(NO_AUDIO_MESSAGE);

  // A second header means two utterances ran together. The full 16-byte signature is checked so
  // that PCM which happens to spell RIFF and WAVE is not taken for one.
  for (let at = buffer.indexOf("RIFF", 1, "latin1"); at !== -1;) {
    if (buffer.toString("latin1", at + 8, at + 16) === "WAVEfmt ") {
      throw new Error(NO_AUDIO_MESSAGE);
    }
    at = buffer.indexOf("RIFF", at + 1, "latin1");
  }

  // Both are views of `buffer`, not copies: build the WAV before the buffer is reused.
  return { header: buffer.subarray(0, pcmOffset), pcm: buffer.subarray(pcmOffset) };
}

// `header` ends with the data chunk's size field, as returned by parseSidecarWav.
function buildWav(header, pcmParts) {
  if (pcmParts.every((part) => part.length === 0)) throw new Error(NO_AUDIO_MESSAGE);
  const wav = Buffer.concat([header, ...pcmParts]);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - header.length, header.length - 4);
  return wav;
}

function finalizeWav(buffer) {
  const parsed = parseSidecarWav(buffer);
  return buildWav(parsed.header, [parsed.pcm]);
}

module.exports = {
  toSingleLine,
  splitForSidecar,
  parseSidecarWav,
  buildWav,
  finalizeWav,
  NO_AUDIO_MESSAGE,
  MAX_LINE_CODEPOINTS,
};
