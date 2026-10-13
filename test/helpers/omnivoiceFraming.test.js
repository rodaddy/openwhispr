const test = require("node:test");
const assert = require("node:assert/strict");

const {
  finalizeWav,
  parseSidecarWav,
  buildWav,
  splitForSidecar,
  toSingleLine,
} = require("../../src/helpers/omnivoiceFraming");

const PLACEHOLDER_SIZE = 0x7fffffff;
const NO_AUDIO = { message: "Local speech returned no audio" };
const codepoints = (value) => Array.from(value).length;

// The sidecar-shaped WAV: 44-byte header with placeholder sizes, then PCM.
function wavChunk(pcmBytes) {
  const pcm = Buffer.isBuffer(pcmBytes) ? pcmBytes : Buffer.from(pcmBytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(PLACEHOLDER_SIZE, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(PLACEHOLDER_SIZE, 40);
  return Buffer.concat([header, pcm]);
}

function assertWav(wav, pcmBytes) {
  const pcm = Buffer.from(pcmBytes);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("latin1", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
}

function assertSegments(segments, limit) {
  for (const segment of segments) {
    assert.ok(segment.length > 0, "no empty segment");
    assert.equal(segment, segment.trim(), "no leading or trailing whitespace");
    assert.ok(codepoints(segment) <= limit, `segment of ${codepoints(segment)} codepoints`);
  }
}

test("toSingleLine collapses whitespace and rejects non-strings", () => {
  assert.equal(toSingleLine(" hello\nworld "), "hello world");
  assert.equal(toSingleLine("a \t\r\n  b\n\nc"), "a b c");
  assert.equal(toSingleLine("   \n "), "");
  assert.equal(toSingleLine(undefined), "");
  assert.equal(toSingleLine(42), "");
  assert.equal(toSingleLine(null), "");
});

test("finalizeWav patches both size fields on a new buffer", () => {
  const raw = wavChunk([1, 2, 3, 4, 5, 6]);
  const wav = finalizeWav(raw);
  assert.notEqual(wav, raw);
  assertWav(wav, [1, 2, 3, 4, 5, 6]);
  assert.equal(raw.readUInt32LE(4), PLACEHOLDER_SIZE, "input must not be mutated");
  assert.equal(raw.readUInt32LE(40), PLACEHOLDER_SIZE, "input must not be mutated");
});

test("finalizeWav throws without RIFF, without a data tag, or without PCM", () => {
  const noAudio = { message: "Local speech returned no audio" };
  const noRiff = wavChunk([1, 2]);
  noRiff.write("JUNK", 0, "latin1");
  assert.throws(() => finalizeWav(noRiff), noAudio);

  const noData = wavChunk([1, 2]);
  noData.write("zzzz", 36, "latin1");
  assert.throws(() => finalizeWav(noData), noAudio);

  // A valid header whose data chunk starts past the 256-byte scan limit: a 300-byte chunk first.
  const plain = wavChunk([1, 2]);
  const filler = Buffer.alloc(8 + 300);
  filler.write("LIST", 0, "latin1");
  filler.writeUInt32LE(300, 4);
  const lateData = Buffer.concat([plain.subarray(0, 36), filler, plain.subarray(36)]);
  assert.throws(() => finalizeWav(lateData), noAudio);
  // The same chunk at 100 bytes keeps the data chunk inside the limit: accepted.
  const nearFiller = Buffer.alloc(8 + 100);
  nearFiller.write("LIST", 0, "latin1");
  nearFiller.writeUInt32LE(100, 4);
  assert.doesNotThrow(() =>
    finalizeWav(Buffer.concat([plain.subarray(0, 36), nearFiller, plain.subarray(36)]))
  );

  assert.throws(() => finalizeWav(wavChunk([])), noAudio);
  assert.throws(() => finalizeWav(Buffer.alloc(0)), noAudio);
});

test("splitForSidecar keeps short text as one line and empty text as none", () => {
  assert.deepEqual(splitForSidecar(" hello\nworld. Again! "), ["hello world. Again!"]);
  assert.deepEqual(splitForSidecar(" \n "), []);
  assert.deepEqual(splitForSidecar(42), []);
  assert.deepEqual(splitForSidecar("x".repeat(600)), ["x".repeat(600)]);
});

test("splitForSidecar packs sentences into segments of at most 600 codepoints", () => {
  const marks = [".", "!", "?", "…"];
  const sentences = [];
  for (let index = 0; index < 40; index += 1) {
    sentences.push(`Sentence number ${index} has a few plain words in it${marks[index % 4]}`);
  }
  const text = sentences.join("\n ");
  assert.ok(text.length > 1500);

  const segments = splitForSidecar(text);
  assert.ok(segments.length >= 3);
  assertSegments(segments, 600);
  assert.equal(segments.join(" "), toSingleLine(text));
  for (const segment of segments) assert.match(segment, /[.!?…]$/, "cut only at sentence ends");
});

test("splitForSidecar cuts a long sentence at spaces", () => {
  const text = Array.from({ length: 201 }, (_, index) => `w${String(index).padStart(3, "0")}`).join(
    " "
  );
  assert.equal(text.length, 1004);

  const segments = splitForSidecar(text);
  assert.equal(segments.length, 2);
  assertSegments(segments, 600);
  assert.equal(segments.join(" "), toSingleLine(text));
  // The cut is at the last space at or before the limit: one more word would not have fitted.
  assert.ok(codepoints(segments[0]) + 1 + codepoints(segments[1].split(" ")[0]) > 600);
});

test("splitForSidecar hard-cuts a run with no space and counts codepoints", () => {
  const run = splitForSidecar("z".repeat(700));
  assert.deepEqual(
    run.map((segment) => segment.length),
    [600, 100]
  );
  assert.equal(run.join(""), "z".repeat(700));

  const emoji = splitForSidecar("😀".repeat(700));
  assert.deepEqual(emoji.map(codepoints), [600, 100]);
  assert.equal(emoji.join(""), "😀".repeat(700));

  assert.deepEqual(splitForSidecar("aa bb. cc dd", 5), ["aa", "bb.", "cc dd"]);
});

test("parseSidecarWav walks chunks: a LIST chunk holding the bytes `data` is skipped", () => {
  const list = Buffer.alloc(16);
  list.write("LIST", 0, "latin1");
  list.writeUInt32LE(8, 4);
  list.write("data", 8, "latin1");
  list.writeUInt32LE(PLACEHOLDER_SIZE, 12);
  const plain = wavChunk([1, 2, 3, 4]);
  const raw = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);

  const { header, pcm } = parseSidecarWav(raw);
  assert.equal(header.length, 60);
  assert.equal(header.toString("latin1", 52, 56), "data");
  assert.deepEqual(pcm, Buffer.from([1, 2, 3, 4]));

  const wav = buildWav(header, [pcm, Buffer.from([5, 6])]);
  assert.equal(wav.length, 66);
  assert.equal(wav.readUInt32LE(4), 58);
  assert.equal(wav.readUInt32LE(56), 6);
  assert.equal(wav.readUInt32LE(48), PLACEHOLDER_SIZE, "the LIST payload is left alone");
  assert.deepEqual(wav.subarray(60), Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.equal(raw.readUInt32LE(4), PLACEHOLDER_SIZE, "input must not be mutated");
  assert.equal(raw.readUInt32LE(56), PLACEHOLDER_SIZE, "input must not be mutated");
  assertWav(finalizeWav(plain), [1, 2, 3, 4]);
});

test("parseSidecarWav rejects a missing WAVE tag, odd PCM, one PCM byte and a second header", () => {
  const noWave = wavChunk([1, 2]);
  noWave.write("JUNK", 8, "latin1");
  assert.throws(() => parseSidecarWav(noWave), NO_AUDIO);
  assert.throws(() => parseSidecarWav(wavChunk([1, 2, 3])), NO_AUDIO);
  assert.throws(() => parseSidecarWav(wavChunk([1])), NO_AUDIO);
  assert.throws(
    () => parseSidecarWav(Buffer.concat([wavChunk([1, 2]), wavChunk([3, 4])])),
    NO_AUDIO
  );
  assert.throws(() => parseSidecarWav("RIFF"), NO_AUDIO);
});

test("parseSidecarWav wants the sidecar's format: a fmt chunk saying 16-bit mono PCM", () => {
  const noFmt = Buffer.concat([
    Buffer.from("RIFF\xff\xff\xff\x7fWAVEdata\xff\xff\xff\x7f", "latin1"),
    Buffer.from([1, 2]),
  ]);
  assert.throws(() => parseSidecarWav(noFmt), NO_AUDIO);

  const stereo = wavChunk([1, 2, 3, 4]);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => parseSidecarWav(stereo), NO_AUDIO);

  const eightBit = wavChunk([1, 2]);
  eightBit.writeUInt16LE(8, 34);
  assert.throws(() => parseSidecarWav(eightBit), NO_AUDIO);

  const float = wavChunk([1, 2]);
  float.writeUInt16LE(3, 20);
  assert.throws(() => parseSidecarWav(float), NO_AUDIO);
});

test("PCM that happens to spell RIFF and WAVE is not taken for a second header", () => {
  const pcm = Buffer.from("RIFFabcdWAVE", "latin1");
  assert.deepEqual(parseSidecarWav(wavChunk(pcm)).pcm, pcm);
});

test("buildWav refuses to build a WAV with no audio in it", () => {
  const { header } = parseSidecarWav(wavChunk([1, 2]));
  assert.throws(() => buildWav(header, []), NO_AUDIO);
  assert.throws(() => buildWav(header, [Buffer.alloc(0)]), NO_AUDIO);
});
