// Portable voice bundle (.rtwvoice): a zip holding manifest.json, reference.wav
// and transcript.txt, so a cloned voice can move between machines.
// Pure: Buffers in, Buffers out. No fs, no Electron, nothing written to disk.

const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const unzipper = require("unzipper");

const BUNDLE_FORMAT = "rtwvoice/1";
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_LANGUAGE_LENGTH = 32;
const MAX_TRANSCRIPT_LENGTH = 20000;
const DEFAULT_LANGUAGE = "en";
const DEFAULT_SEED = 42;
const DEFAULT_NUM_STEPS = 16;
const MAX_NUM_STEPS = 64;

const MANIFEST_ENTRY = "manifest.json";
const WAV_ENTRY = "reference.wav";
const TRANSCRIPT_ENTRY = "transcript.txt";
const ENTRY_NAMES = [MANIFEST_ENTRY, WAV_ENTRY, TRANSCRIPT_ENTRY].sort();

const ERR_NAME = "Voice name is required";
const ERR_TRANSCRIPT = "Reference transcript is required";
const ERR_TRANSCRIPT_TOO_LONG = "Reference transcript is too long";
const ERR_NOT_WAV = "Reference audio must be a WAV file";
const ERR_TOO_LARGE = "Reference audio is too large";
const ERR_NOT_BUNDLE = "Not a voice bundle";
const ERR_FORMAT = "Unsupported voice bundle format";
const ERR_CORRUPT = "Voice bundle is corrupt";

const END_RECORD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR_SIGNATURE = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
const END_RECORD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
// How far back from the end the zip reader looks for the end record.
const READER_TAIL_BYTES = 80;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidName(value) {
  return isNonEmptyString(value) && value.trim().length <= MAX_NAME_LENGTH;
}

function isWav(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WAVE"
  );
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeLanguage(language) {
  return isNonEmptyString(language) && language.trim().length <= MAX_LANGUAGE_LENGTH
    ? language.trim()
    : DEFAULT_LANGUAGE;
}

function normalizeSeed(seed) {
  return Number.isSafeInteger(seed) && seed >= 0 ? seed : DEFAULT_SEED;
}

function normalizeNumSteps(numSteps) {
  return Number.isInteger(numSteps) && numSteps >= 1 && numSteps <= MAX_NUM_STEPS
    ? numSteps
    : DEFAULT_NUM_STEPS;
}

// archiver 8 is ESM-only; load it lazily from this CommonJS module.
async function zipToBuffer(files) {
  const { ZipArchive } = await import("archiver");
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks)));
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.pipe(output);
    for (const [entryName, data] of files) archive.append(data, { name: entryName });
    archive.finalize().catch(reject);
  });
}

async function buildVoiceBundle(
  { name, language, seed, numSteps, transcript, wav } = {},
  { maxWavBytes = MAX_WAV_BYTES } = {}
) {
  if (!isValidName(name)) throw new Error(ERR_NAME);
  if (!isNonEmptyString(transcript)) throw new Error(ERR_TRANSCRIPT);
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) throw new Error(ERR_TRANSCRIPT_TOO_LONG);
  if (!isWav(wav)) throw new Error(ERR_NOT_WAV);
  if (wav.length > maxWavBytes) throw new Error(ERR_TOO_LARGE);

  const manifest = {
    format: BUNDLE_FORMAT,
    name: name.trim(),
    language: normalizeLanguage(language),
    seed: normalizeSeed(seed),
    numSteps: normalizeNumSteps(numSteps),
    transcript: transcript.trim(),
    wavSha256: sha256Hex(wav),
  };

  return zipToBuffer([
    [MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), "utf8")],
    [WAV_ENTRY, wav],
    [TRANSCRIPT_ENTRY, Buffer.from(manifest.transcript, "utf8")],
  ]);
}

// Decided from the raw bytes before the zip reader runs: the reader sizes an
// array from the entry count the archive declares, and for a ZIP64 archive
// that count is an 8-byte value. True only for a plain zip that ends in an
// end-of-central-directory record with no comment, declaring exactly three
// entries on one disk. The record must also be the first one in the tail the
// reader searches, so the reader and this check read the same record.
function isPlainThreeEntryZip(buffer) {
  if (buffer.length < END_RECORD_BYTES) return false;
  const at = buffer.length - END_RECORD_BYTES;
  const firstInTail = buffer.indexOf(
    END_RECORD_SIGNATURE,
    Math.max(0, buffer.length - READER_TAIL_BYTES)
  );
  if (firstInTail !== at) return false;
  if (buffer.readUInt16LE(at + 20) !== 0) return false;
  if (buffer.readUInt16LE(at + 4) !== 0 || buffer.readUInt16LE(at + 6) !== 0) return false;
  if (
    buffer.readUInt16LE(at + 8) !== ENTRY_NAMES.length ||
    buffer.readUInt16LE(at + 10) !== ENTRY_NAMES.length
  ) {
    return false;
  }
  const directorySize = buffer.readUInt32LE(at + 12);
  const directoryOffset = buffer.readUInt32LE(at + 16);
  if (directorySize >= 0xffffffff || directoryOffset >= 0xffffffff) return false;
  if (directoryOffset + directorySize > at) return false;
  if (
    at >= ZIP64_LOCATOR_BYTES &&
    buffer
      .subarray(at - ZIP64_LOCATOR_BYTES, at - ZIP64_LOCATOR_BYTES + 4)
      .equals(ZIP64_LOCATOR_SIGNATURE)
  ) {
    return false;
  }
  return true;
}

async function openEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || !isPlainThreeEntryZip(buffer)) throw new Error(ERR_NOT_BUNDLE);

  let entries;
  try {
    entries = (await unzipper.Open.buffer(buffer)).files;
  } catch {
    throw new Error(ERR_NOT_BUNDLE);
  }

  // Entries are matched by exact name against a fixed list and only ever read
  // into memory, so a hostile name ("../x", "a/b", "dir/") can never reach a path.
  const byName = new Map();
  for (const entry of entries) {
    const entryName = entry.path;
    if (entry.type === "Directory" || /[/\\]/.test(entryName)) throw new Error(ERR_NOT_BUNDLE);
    byName.set(entryName, entry);
  }
  const names = [...byName.keys()].sort();
  const exact =
    entries.length === ENTRY_NAMES.length &&
    names.length === ENTRY_NAMES.length &&
    names.every((entryName, index) => entryName === ENTRY_NAMES[index]);
  if (!exact) throw new Error(ERR_NOT_BUNDLE);
  return byName;
}

// The declared size is checked before any decompression, then the bytes are
// counted while they inflate: the header is attacker-controlled and may
// understate the payload, so the read stops at the cap either way.
async function readEntry(entry, maxBytes, tooLargeMessage, message) {
  if (entry.uncompressedSize > maxBytes) throw new Error(tooLargeMessage);
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of entry.stream()) {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
  } catch {
    throw new Error(message);
  }
  if (tooLarge) throw new Error(tooLargeMessage);
  return Buffer.concat(chunks);
}

async function readVoiceBundle(buffer, { maxWavBytes = MAX_WAV_BYTES } = {}) {
  const entries = await openEntries(buffer);

  let manifest;
  try {
    const manifestFile = await readEntry(
      entries.get(MANIFEST_ENTRY),
      MAX_TEXT_BYTES,
      ERR_FORMAT,
      ERR_FORMAT
    );
    manifest = JSON.parse(manifestFile.toString("utf8"));
  } catch {
    throw new Error(ERR_FORMAT);
  }
  if (!manifest || typeof manifest !== "object" || manifest.format !== BUNDLE_FORMAT) {
    throw new Error(ERR_FORMAT);
  }

  const wav = await readEntry(entries.get(WAV_ENTRY), maxWavBytes, ERR_TOO_LARGE, ERR_CORRUPT);
  if (!isWav(wav)) throw new Error(ERR_NOT_WAV);
  if (sha256Hex(wav) !== manifest.wavSha256) throw new Error(ERR_CORRUPT);

  if (
    !isValidName(manifest.name) ||
    !isNonEmptyString(manifest.transcript) ||
    manifest.transcript.length > MAX_TRANSCRIPT_LENGTH
  ) {
    throw new Error(ERR_CORRUPT);
  }
  const transcript = manifest.transcript.trim();
  const transcriptFile = await readEntry(
    entries.get(TRANSCRIPT_ENTRY),
    MAX_TEXT_BYTES,
    ERR_CORRUPT,
    ERR_CORRUPT
  );
  if (transcriptFile.toString("utf8").trim() !== transcript) throw new Error(ERR_CORRUPT);

  return {
    manifest: {
      format: BUNDLE_FORMAT,
      name: manifest.name.trim(),
      language: normalizeLanguage(manifest.language),
      seed: normalizeSeed(manifest.seed),
      numSteps: normalizeNumSteps(manifest.numSteps),
      transcript,
      wavSha256: manifest.wavSha256,
    },
    wav,
    transcript,
  };
}

module.exports = { buildVoiceBundle, readVoiceBundle, BUNDLE_FORMAT, MAX_WAV_BYTES };
