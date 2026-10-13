const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const unzipper = require("unzipper");

const {
  buildVoiceBundle,
  readVoiceBundle,
  BUNDLE_FORMAT,
} = require("../../src/helpers/voiceBundle.js");

// 44-byte canonical PCM header (mono, 16 kHz, 16-bit) followed by a few samples.
function makeWav(pcm = [1, 2, 3, 4, 5, 6, 7, 8]) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const validInput = (overrides = {}) => ({
  name: "Skippy",
  language: "de",
  seed: 7,
  numSteps: 24,
  transcript: "The quick brown fox.",
  wav: makeWav(),
  ...overrides,
});

async function zip(files) {
  const { ZipArchive } = await import("archiver");
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive();
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.pipe(output);
    for (const [name, data] of files) archive.append(data, { name });
    archive.finalize().catch(reject);
  });
}

// Assembles a bundle by hand so each test can break exactly one thing.
function makeRawBundle({
  manifest,
  wav = makeWav(),
  transcript = "Hello there.",
  extra = [],
} = {}) {
  const manifestBody =
    typeof manifest === "string"
      ? manifest
      : JSON.stringify({
          format: BUNDLE_FORMAT,
          name: "Skippy",
          language: "en",
          seed: 42,
          numSteps: 16,
          transcript: "Hello there.",
          wavSha256: sha256(wav),
          ...manifest,
        });
  const files = [["manifest.json", Buffer.from(manifestBody, "utf8")]];
  files.push(["reference.wav", wav]);
  if (transcript !== null) files.push(["transcript.txt", Buffer.from(transcript, "utf8")]);
  return zip([...files, ...extra]);
}

const rejectsMessage = (promise, message) => assert.rejects(promise, { name: "Error", message });

test("round trip preserves every field and the wav bytes", async () => {
  const input = validInput();
  const bundle = await buildVoiceBundle(input);
  assert.ok(Buffer.isBuffer(bundle));

  const { manifest, wav, transcript } = await readVoiceBundle(bundle);
  assert.deepEqual(manifest, {
    format: BUNDLE_FORMAT,
    name: "Skippy",
    language: "de",
    seed: 7,
    numSteps: 24,
    transcript: "The quick brown fox.",
    wavSha256: sha256(input.wav),
  });
  assert.ok(wav.equals(input.wav));
  assert.equal(transcript, "The quick brown fox.");
});

test("missing or out-of-range language, seed and numSteps fall back to the defaults", async () => {
  const built = await readVoiceBundle(
    await buildVoiceBundle({ name: "V", transcript: "T", wav: makeWav() })
  );
  const handWritten = await readVoiceBundle(
    await makeRawBundle({ manifest: { language: "", seed: -3, numSteps: 99 } })
  );
  const longLanguage = await readVoiceBundle(
    await makeRawBundle({ manifest: { language: "x".repeat(33) } })
  );
  const paddedLanguage = await readVoiceBundle(
    await buildVoiceBundle({
      name: "V",
      transcript: "T",
      wav: makeWav(),
      language: "en" + " ".repeat(2000),
    })
  );
  for (const { manifest } of [built, handWritten, longLanguage, paddedLanguage]) {
    assert.equal(manifest.language, "en");
    assert.equal(manifest.seed, 42);
    assert.equal(manifest.numSteps, 16);
  }
});

test("build rejects a missing name or transcript, a non-WAV and an oversize WAV", async () => {
  const wav = makeWav();
  await rejectsMessage(buildVoiceBundle(validInput({ name: "   " })), "Voice name is required");
  await rejectsMessage(
    buildVoiceBundle(validInput({ transcript: " \n " })),
    "Reference transcript is required"
  );
  await rejectsMessage(
    buildVoiceBundle(validInput({ transcript: "x".repeat(20001) })),
    "Reference transcript is too long"
  );
  await rejectsMessage(
    buildVoiceBundle(validInput({ wav: Buffer.alloc(64) })),
    "Reference audio must be a WAV file"
  );
  await rejectsMessage(
    buildVoiceBundle(validInput({ wav }), { maxWavBytes: wav.length - 1 }),
    "Reference audio is too large"
  );
});

test("read: a non-zip buffer is not a voice bundle", async () => {
  await rejectsMessage(readVoiceBundle(Buffer.from("definitely not a zip")), "Not a voice bundle");
});

test("read: a second end-of-central-directory record or an archive comment is not a voice bundle", async () => {
  const bundle = await buildVoiceBundle(validInput());
  const eocd = bundle.length - 22;
  const cdSize = bundle.readUInt32LE(eocd + 12);
  const cdOffset = bundle.readUInt32LE(eocd + 16);

  // The zip reader takes the FIRST record in the last 80 bytes. Here that one
  // carries the ZIP64 markers and points at a ZIP64 record (declaring a
  // harmless three entries), while a plain three-entry decoy sits in its comment.
  const zip64Record = Buffer.alloc(56);
  zip64Record.writeUInt32LE(0x06064b50, 0);
  zip64Record.writeBigUInt64LE(44n, 4);
  zip64Record.writeBigUInt64LE(3n, 24);
  zip64Record.writeBigUInt64LE(3n, 32);
  zip64Record.writeBigUInt64LE(BigInt(cdSize), 40);
  zip64Record.writeBigUInt64LE(BigInt(cdOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(eocd), 8);
  locator.writeUInt32LE(1, 16);
  const firstRecord = Buffer.alloc(22);
  firstRecord.writeUInt32LE(0x06054b50, 0);
  firstRecord.writeUInt16LE(0xffff, 8);
  firstRecord.writeUInt16LE(0xffff, 10);
  firstRecord.writeUInt32LE(cdSize, 12);
  firstRecord.writeUInt32LE(cdOffset, 16);
  firstRecord.writeUInt16LE(50, 20);
  const decoy = Buffer.from(bundle.subarray(eocd));
  const twoRecords = Buffer.concat([
    bundle.subarray(0, eocd),
    zip64Record,
    locator,
    firstRecord,
    Buffer.alloc(28, 0x20),
    decoy,
  ]);
  await rejectsMessage(readVoiceBundle(twoRecords), "Not a voice bundle");

  const commented = Buffer.concat([bundle, Buffer.from("x")]);
  commented.writeUInt16LE(1, eocd + 20);
  await rejectsMessage(readVoiceBundle(commented), "Not a voice bundle");
});

test("read: a fourth entry is not a voice bundle", async () => {
  const bundle = await makeRawBundle({ extra: [["extra.txt", Buffer.from("x")]] });
  await rejectsMessage(readVoiceBundle(bundle), "Not a voice bundle");
});

test("read: a missing transcript.txt is not a voice bundle", async () => {
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ transcript: null })),
    "Not a voice bundle"
  );
});

test("read: an entry named ../transcript.txt is not a voice bundle", async () => {
  // archiver sanitizes names, so a same-length placeholder is renamed in the raw bytes.
  const placeholder = "XXXtranscript.txt";
  const bundle = await makeRawBundle({
    transcript: null,
    extra: [[placeholder, Buffer.from("Hello there.")]],
  });
  let at = bundle.indexOf(placeholder);
  while (at !== -1) {
    bundle.write("../", at, "latin1");
    at = bundle.indexOf(placeholder, at);
  }
  const { files } = await unzipper.Open.buffer(bundle);
  assert.ok(
    files.some((entry) => entry.path === "../transcript.txt"),
    "fixture must really carry the traversal name"
  );
  await rejectsMessage(readVoiceBundle(bundle), "Not a voice bundle");
});

test("read: another format version or a manifest that is not JSON is unsupported", async () => {
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ manifest: { format: "rtwvoice/2" } })),
    "Unsupported voice bundle format"
  );
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ manifest: "{ not json" })),
    "Unsupported voice bundle format"
  );
});

test("read: wav bytes changed after the manifest was written are corrupt", async () => {
  const original = makeWav();
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  const bundle = await makeRawBundle({ manifest: { wavSha256: sha256(original) }, wav: tampered });
  await rejectsMessage(readVoiceBundle(bundle), "Voice bundle is corrupt");
});

test("read: transcript.txt differing from the manifest is corrupt", async () => {
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ transcript: "Something else." })),
    "Voice bundle is corrupt"
  );
});

test("read: a manifest name that fails the build rules is corrupt", async () => {
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ manifest: { name: "x".repeat(81) } })),
    "Voice bundle is corrupt"
  );
});

test("read: a reference.wav that is not a WAV", async () => {
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ wav: Buffer.from("this is plain text, not audio") })),
    "Reference audio must be a WAV file"
  );
});

test("read: an entry over its size cap is rejected before it is read", async () => {
  const wav = makeWav();
  const bundle = await makeRawBundle({ wav });
  await rejectsMessage(
    readVoiceBundle(bundle, { maxWavBytes: wav.length - 1 }),
    "Reference audio is too large"
  );
  assert.ok(await readVoiceBundle(bundle, { maxWavBytes: wav.length }));

  const padded = JSON.stringify({ format: BUNDLE_FORMAT, pad: "x".repeat(1024 * 1024) });
  await rejectsMessage(
    readVoiceBundle(await makeRawBundle({ manifest: padded })),
    "Unsupported voice bundle format"
  );
});
