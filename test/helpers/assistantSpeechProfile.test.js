const assert = require("node:assert/strict");
const test = require("node:test");
const { createAssistantSpeechProfileStore } = require("../../src/helpers/assistantSpeechProfile");
const { MAX_WAV_BYTES } = require("../../src/helpers/voiceBundle");
const { buildPcm16Wav, readPcm16Wav, sliceWav } = require("../../src/helpers/referenceClip");

// A clip whose every sample is the number of its 15 s window (1, 2, 3...).
function makeClip(seconds, sampleRate = 100, channels = 1) {
  const pcm = Buffer.alloc(seconds * sampleRate * channels * 2);
  for (let i = 0; i < pcm.length; i += 2)
    pcm.writeInt16LE(Math.floor(i / (sampleRate * channels * 2 * 15)) + 1, i);
  return buildPcm16Wav({ sampleRate, channels, pcm });
}

// The injected audio functions for a chosen clip of the given length.
const clipSource = (seconds, overrides = {}) => ({
  chooseWav: async () => "/chosen/reference.wav",
  toTranscriptionWav: async () => makeClip(seconds),
  toPcm16Wav: async () => makeClip(seconds, 200, 2),
  transcribe: async () => "Exact spoken words",
  ...overrides,
});

function memoryFs(files) {
  return {
    existsSync: (file) => files.has(file),
    readFileSync: (file, encoding) =>
      encoding ? String(files.get(file)) : Buffer.from(files.get(file)),
    mkdirSync: () => {},
    copyFileSync: (source, destination) => files.set(destination, files.get(source)),
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (source, destination) => {
      files.set(destination, files.get(source));
      files.delete(source);
    },
    unlinkSync: (file) => files.delete(file),
  };
}

function clipStore(files, seconds, overrides) {
  return createAssistantSpeechProfileStore({
    fs: memoryFs(files),
    profileDir: "/profile",
    endpoint: "http://voice",
    ...clipSource(seconds, overrides),
  });
}

const referenceIn = (files) =>
  files.get(`/profile/${JSON.parse(files.get("/profile/profile.json")).referenceFile}`);

test("choosing a 10 s clip returns its transcript and writes nothing until it is saved", async () => {
  const files = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  const store = clipStore(files, 10);

  assert.deepEqual(await store.analyze(), {
    success: true,
    fileName: "reference.wav",
    durationSec: 10,
    text: "Exact spoken words",
    transcribed: true,
  });
  assert.deepEqual([...files.keys()], ["/chosen/reference.wav"]);

  assert.equal((await store.import(" ")).success, false);
  assert.deepEqual(await store.import(" Exact spoken words "), { success: true });
  assert.deepEqual(store.read(), {
    endpoint: "http://voice",
    promptText: "Exact spoken words",
    referenceAudioBase64: Buffer.from("wav-bytes").toString("base64"),
    seed: 42,
    numSteps: 16,
    language: "en",
  });
});

test("a 45 s clip keeps the window with the most words and saves only that 15 s", async () => {
  const files = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  // The window number is the value of every sample in it.
  const words = { 1: "one", 2: "one two three four five", 3: "one two" };
  const store = clipStore(files, 45, {
    transcribe: async (wav) => words[readPcm16Wav(wav).pcm.readInt16LE(wav.length - 46)],
  });

  assert.deepEqual(await store.analyze(), {
    success: true,
    fileName: "reference.wav",
    durationSec: 45,
    text: "one two three four five",
    transcribed: true,
    window: { index: 2, count: 3, startSec: 15, endSec: 30 },
  });
  assert.deepEqual(await store.import("one two three four five"), { success: true });

  const saved = referenceIn(files);
  assert.equal(readPcm16Wav(saved).durationSec, 15);
  assert.ok(saved.equals(sliceWav(makeClip(45, 200, 2), 15, 30)));
});

test("saving with no clip chosen is refused and writes nothing", async () => {
  const files = new Map();
  const store = clipStore(files, 10);
  assert.deepEqual(await store.import("Exact spoken words"), {
    success: false,
    error: "Choose a reference WAV first",
  });
  assert.equal(files.size, 0);
});

test("a clip that cannot be transcribed is typed by hand when short and refused when windowed", async () => {
  const transcribe = async () => {
    throw new Error("hub down");
  };
  const short = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  const shortStore = clipStore(short, 10, { transcribe });
  assert.deepEqual(await shortStore.analyze(), {
    success: true,
    fileName: "reference.wav",
    durationSec: 10,
    text: "",
    transcribed: false,
  });
  assert.deepEqual(await shortStore.import("Typed by hand"), { success: true });
  assert.equal(shortStore.read().promptText, "Typed by hand");

  const long = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  const longStore = clipStore(long, 45, { transcribe });
  assert.deepEqual(await longStore.analyze(), { success: false, code: "transcription-failed" });
  assert.equal((await longStore.import("Typed by hand")).success, false);
  assert.deepEqual([...long.keys()], ["/chosen/reference.wav"]);
});

test("an 80 s clip is refused as too long", async () => {
  assert.deepEqual(await clipStore(new Map(), 80).analyze(), {
    success: false,
    code: "too-long",
    durationSec: 80,
  });
});

test("a second choice whose analysis throws drops the first clip", async () => {
  const files = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  let choices = 0;
  const store = clipStore(files, 10, {
    // The second conversion comes back unreadable, which throws past the
    // not-audio catch.
    toTranscriptionWav: async () => (++choices > 1 ? Buffer.from("not a wav") : makeClip(10)),
  });

  assert.equal((await store.analyze()).success, true);
  await assert.rejects(store.analyze(), /16-bit PCM WAV/);
  assert.deepEqual(await store.import("Exact spoken words"), {
    success: false,
    error: "Choose a reference WAV first",
  });
});

// Two choices of a 10 s clip: the first one's transcription waits until the
// test releases it, so the second choice finishes before the first.
function lateFirstChoice(files, overrides = {}) {
  let releaseFirst;
  let firstStarted;
  const firstInFlight = new Promise((resolve) => (firstStarted = resolve));
  let choices = 0;
  let transcriptions = 0;
  const store = clipStore(files, 10, {
    chooseWav: async () => (++choices === 1 ? "/chosen/reference.wav" : "/chosen/b.wav"),
    transcribe: async () => {
      if (++transcriptions > 1) return "Exact spoken words";
      firstStarted();
      return new Promise((resolve) => (releaseFirst = () => resolve("Exact spoken words")));
    },
    ...overrides,
  });
  return { store, firstInFlight, releaseFirst: () => releaseFirst() };
}

test("a choose that finishes late does not bring its clip back", async () => {
  const files = new Map([
    ["/chosen/reference.wav", "a-bytes"],
    ["/chosen/b.wav", "b-bytes"],
  ]);
  const { store, firstInFlight, releaseFirst } = lateFirstChoice(files);

  const first = store.analyze();
  await firstInFlight;
  assert.equal((await store.analyze()).success, true);
  releaseFirst();
  assert.equal((await first).success, true);

  assert.deepEqual(await store.import("Exact spoken words"), { success: true });
  assert.equal(referenceIn(files), "b-bytes");
});

test("a choose that finishes late does not come back after a newer choose failed", async () => {
  const files = new Map([
    ["/chosen/reference.wav", "a-bytes"],
    ["/chosen/b.wav", "b-bytes"],
  ]);
  let conversions = 0;
  const { store, firstInFlight, releaseFirst } = lateFirstChoice(files, {
    toTranscriptionWav: async () => {
      if (++conversions > 1) throw new Error("not audio");
      return makeClip(10);
    },
  });

  const first = store.analyze();
  await firstInFlight;
  assert.deepEqual(await store.analyze(), { success: false, code: "not-audio" });
  releaseFirst();
  await first;

  assert.deepEqual(await store.import("Exact spoken words"), {
    success: false,
    error: "Choose a reference WAV first",
  });
});

test("a Save that fails keeps the saved voice and can be tried again", async () => {
  const files = new Map([
    ["/chosen/reference.wav", "wav-bytes"],
    ["/profile/profile.json", JSON.stringify({ promptText: "Voice A", referenceFile: "a.wav" })],
    ["/profile/a.wav", "audio-a"],
  ]);
  let reads = 0;
  const store = clipStore(files, 45, {
    toPcm16Wav: async () => {
      if (++reads === 1) throw new Error("ENOENT: /chosen/reference.wav");
      return makeClip(45);
    },
  });
  const before = new Map(files);

  assert.equal((await store.analyze()).success, true);
  assert.deepEqual(await store.import("Exact spoken words"), {
    success: false,
    error: "The chosen clip could not be saved.",
  });
  assert.deepEqual([...files], [...before]);
  assert.deepEqual(await store.import("Exact spoken words"), { success: true });
});

test("a clip chosen while a Save is in flight survives that Save", async () => {
  const files = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  let releaseRead;
  let reads = 0;
  const store = clipStore(files, 45, {
    // The first Save's read of the clip waits until the test releases it.
    toPcm16Wav: async () =>
      ++reads === 1
        ? new Promise((resolve) => {
            releaseRead = () => resolve(makeClip(45, 200, 2));
          })
        : makeClip(45, 200, 2),
  });

  assert.equal((await store.analyze()).success, true);
  const firstSave = store.import("Exact spoken words");
  await new Promise((resolve) => setImmediate(resolve));
  // A new choice while the first Save still reads its clip.
  assert.equal((await store.analyze()).success, true);
  releaseRead();
  assert.deepEqual(await firstSave, { success: true });
  // The newer choice is still there to save.
  assert.deepEqual(await store.import("Exact spoken words"), { success: true });
});

test("a failed metadata switch preserves the previous matched transcript and WAV", async () => {
  const files = new Map([
    ["/profile/profile.json", JSON.stringify({ promptText: "Voice A", referenceFile: "a.wav" })],
    ["/profile/a.wav", "audio-a"],
  ]);
  const fakeFs = {
    existsSync: (file) => files.has(file),
    readFileSync: (file, encoding) => (encoding ? files.get(file) : Buffer.from(files.get(file))),
    mkdirSync: () => {},
    copyFileSync: (_source, destination) => files.set(destination, "audio-b"),
    writeFileSync: () => {
      throw Object.assign(new Error("ENOSPC: /profile/profile-1.json.tmp"), { code: "ENOSPC" });
    },
    renameSync: () => {
      throw new Error("must not rename");
    },
    unlinkSync: (file) => files.delete(file),
  };
  const store = createAssistantSpeechProfileStore({
    fs: fakeFs,
    profileDir: "/profile",
    endpoint: "http://voice",
    ...clipSource(10, { chooseWav: async () => "/b.wav" }),
  });
  await store.analyze();
  // The reason reaches the log as a code; the message never carries the path.
  assert.deepEqual(await store.import("Voice B"), {
    success: false,
    error: "The chosen clip could not be saved.",
    code: "ENOSPC",
  });
  // The reference file the failed install copied in is gone again, so a
  // retried Save does not leave one more behind each time.
  assert.deepEqual([...files.keys()], ["/profile/profile.json", "/profile/a.wav"]);
  assert.deepEqual(store.read(), {
    endpoint: "http://voice",
    promptText: "Voice A",
    referenceAudioBase64: Buffer.from("audio-a").toString("base64"),
    seed: 42,
    numSteps: 16,
    language: "en",
  });
});

test("readLocalPaths exposes the WAV and a transcript file kept in step with the profile", async () => {
  const files = new Map();
  const writes = [];
  const fakeFs = {
    existsSync: (file) => files.has(file),
    readFileSync: (file, encoding) => (encoding ? files.get(file) : Buffer.from(files.get(file))),
    mkdirSync: () => {},
    copyFileSync: (_source, destination) => files.set(destination, "wav-bytes"),
    writeFileSync: (file, value) => {
      writes.push(file);
      files.set(file, value);
    },
    renameSync: (source, destination) => {
      files.set(destination, files.get(source));
      files.delete(source);
    },
  };
  const store = createAssistantSpeechProfileStore({
    fs: fakeFs,
    profileDir: "/profile",
    endpoint: "http://voice",
    ...clipSource(10),
  });

  assert.equal(store.readLocalPaths(), null);
  assert.equal(writes.length, 0);

  await store.analyze();
  assert.equal((await store.import(" Exact spoken words ")).success, true);
  const textWrites = () => writes.filter((file) => file.endsWith(".txt.tmp")).length;
  const first = store.readLocalPaths();
  assert.match(first.referenceWavPath, /^\/profile\/reference-.*\.wav$/);
  assert.equal(first.referenceTextPath, first.referenceWavPath.replace(/\.wav$/, ".txt"));
  assert.equal(files.get(first.referenceWavPath), "wav-bytes");
  assert.equal(files.get(first.referenceTextPath), "Exact spoken words");
  assert.equal(textWrites(), 1);

  assert.deepEqual(store.readLocalPaths(), first);
  assert.equal(textWrites(), 1);

  const profile = JSON.parse(files.get("/profile/profile.json"));
  files.set("/profile/profile.json", JSON.stringify({ ...profile, promptText: " New words " }));
  assert.deepEqual(store.readLocalPaths(), first);
  assert.equal(files.get(first.referenceTextPath), "New words");
  assert.equal(textWrites(), 2);

  files.delete(first.referenceWavPath);
  assert.equal(store.readLocalPaths(), null);

  await store.analyze();
  assert.equal((await store.import("Second voice")).success, true);
  const second = store.readLocalPaths();
  assert.notEqual(second.referenceTextPath, first.referenceTextPath);
  assert.equal(second.referenceTextPath, second.referenceWavPath.replace(/\.wav$/, ".txt"));
  assert.equal(files.get(second.referenceTextPath), "Second voice");
});

test("readLocalPaths removes the staged transcript when the rename fails", async () => {
  const files = new Map();
  const unlinked = [];
  const fakeFs = {
    existsSync: (file) => files.has(file),
    readFileSync: (file, encoding) => (encoding ? files.get(file) : Buffer.from(files.get(file))),
    mkdirSync: () => {},
    copyFileSync: (_source, destination) => files.set(destination, "wav-bytes"),
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (source, destination) => {
      if (destination.endsWith(".txt")) throw new Error("EPERM: rename");
      files.set(destination, files.get(source));
      files.delete(source);
    },
    unlinkSync: (file) => {
      unlinked.push(file);
      files.delete(file);
    },
  };
  const store = createAssistantSpeechProfileStore({
    fs: fakeFs,
    profileDir: "/profile",
    endpoint: "http://voice",
    ...clipSource(10),
  });
  await store.analyze();
  assert.equal((await store.import("Exact spoken words")).success, true);

  assert.throws(() => store.readLocalPaths(), { message: "EPERM: rename" });
  assert.equal(unlinked.length, 1);
  assert.match(unlinked[0], /\.txt\.tmp$/);
  assert.deepEqual(
    [...files.keys()].filter((file) => file.endsWith(".tmp")),
    []
  );

  // A failing cleanup never masks the rename error.
  fakeFs.unlinkSync = () => {
    throw new Error("ENOENT: unlink");
  };
  assert.throws(() => store.readLocalPaths(), { message: "EPERM: rename" });
});

test("a failed write of the staged transcript leaves nothing behind", async () => {
  const files = new Map();
  const fakeFs = {
    ...memoryFs(files),
    copyFileSync: (_source, destination) => files.set(destination, "wav-bytes"),
    // A full disk: the file exists by the time the write fails.
    writeFileSync: (file, value) => {
      files.set(file, value);
      if (file.endsWith(".txt.tmp")) throw new Error("ENOSPC: write");
    },
  };
  const store = createAssistantSpeechProfileStore({
    fs: fakeFs,
    profileDir: "/profile",
    endpoint: "http://voice",
    ...clipSource(10),
  });
  await store.analyze();
  assert.equal((await store.import("Exact spoken words")).success, true);

  assert.throws(() => store.readLocalPaths(), { message: "ENOSPC: write" });
  assert.deepEqual(
    [...files.keys()].filter((file) => file.endsWith(".tmp")),
    []
  );
});

// 44-byte PCM header (mono, 16 kHz, 16-bit) followed by the samples.
function makeWav(pcm) {
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

function bundleFs(files) {
  return {
    existsSync: (file) => files.has(file),
    readFileSync: (file, encoding) =>
      encoding ? String(files.get(file)) : Buffer.from(files.get(file)),
    statSync: (file) => ({ size: Buffer.byteLength(files.get(file)) }),
    mkdirSync: () => {},
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (source, destination) => {
      files.set(destination, files.get(source));
      files.delete(source);
    },
  };
}

function bundleStore(files, overrides = {}) {
  return createAssistantSpeechProfileStore({
    fs: bundleFs(files),
    profileDir: "/profile",
    endpoint: "http://voice",
    chooseWav: async () => null,
    chooseBundle: async () => "/in/voice.rtwvoice",
    chooseBundleSavePath: async () => "/out/voice.rtwvoice",
    ...overrides,
  });
}

// Incompressible samples, so the middle of the bundle is the stored audio.
const voiceWav = makeWav(Array.from({ length: 4096 }, (_, i) => (i * 7919 + (i >> 3) * 31) % 251));
const configuredVoice = () =>
  new Map([
    [
      "/profile/profile.json",
      JSON.stringify({
        promptText: "Voice A",
        referenceFile: "a.wav",
        language: "de",
        seed: 7,
        numSteps: 24,
      }),
    ],
    ["/profile/a.wav", voiceWav],
  ]);

test("a voice exported as a bundle installs on a second machine with its settings and audio", async () => {
  const source = configuredVoice();
  const exported = await bundleStore(source).exportBundle(" Skippy ");
  assert.deepEqual(exported, { success: true, path: "/out/voice.rtwvoice" });

  const target = new Map([["/in/voice.rtwvoice", source.get("/out/voice.rtwvoice")]]);
  assert.deepEqual(await bundleStore(target).importBundle(), { success: true });

  const { referenceFile, ...profile } = JSON.parse(target.get("/profile/profile.json"));
  assert.deepEqual(profile, {
    promptText: "Voice A",
    name: "Skippy",
    language: "de",
    seed: 7,
    numSteps: 24,
  });
  assert.match(referenceFile, /^reference-.*\.wav$/);
  assert.deepEqual(Buffer.from(target.get(`/profile/${referenceFile}`)), voiceWav);
});

test("a damaged bundle is refused and the current voice is left as it was", async () => {
  const files = configuredVoice();
  await bundleStore(files).exportBundle("Skippy");
  const damaged = Buffer.from(files.get("/out/voice.rtwvoice"));
  const middle = Math.floor(damaged.length / 2);
  for (let i = middle; i < middle + 16; i += 1) damaged[i] ^= 0xff;
  files.set("/in/voice.rtwvoice", damaged);
  files.delete("/out/voice.rtwvoice");
  const before = new Map(files);
  const profileBefore = files.get("/profile/profile.json");
  const wavBefore = Buffer.from(files.get("/profile/a.wav"));

  assert.deepEqual(await bundleStore(files).importBundle(), { success: false, error: "corrupt" });
  assert.deepEqual([...files.keys()], [...before.keys()]);
  assert.equal(files.get("/profile/profile.json"), profileBefore);
  assert.ok(Buffer.from(files.get("/profile/a.wav")).equals(wavBefore));
});

test("exporting with no voice set up reports it without asking where to save", async () => {
  let asked = 0;
  const store = bundleStore(new Map(), {
    chooseBundleSavePath: async () => {
      asked += 1;
      return "/out/voice.rtwvoice";
    },
  });
  assert.deepEqual(await store.exportBundle("Skippy"), { success: false, error: "no-profile" });
  assert.equal(asked, 0);
});

test("exporting an oversize clip reports too-large without reading it or asking where to save", async () => {
  const files = configuredVoice();
  const fs = bundleFs(files);
  const read = [];
  let asked = 0;
  const store = bundleStore(files, {
    fs: {
      ...fs,
      statSync: (file) =>
        file === "/profile/a.wav" ? { size: MAX_WAV_BYTES + 1 } : fs.statSync(file),
      readFileSync: (file, encoding) => {
        read.push(file);
        return fs.readFileSync(file, encoding);
      },
    },
    chooseBundleSavePath: async () => {
      asked += 1;
      return "/out/voice.rtwvoice";
    },
  });
  assert.deepEqual(await store.exportBundle("Skippy"), { success: false, error: "too-large" });
  assert.ok(!read.includes("/profile/a.wav"));
  assert.equal(asked, 0);
});

// --- render settings ---

test("the seed is stored on import, defaulted on read, and refused out of range", async () => {
  const files = new Map([["/chosen/reference.wav", "wav-bytes"]]);
  const store = clipStore(files, 10);

  await store.analyze();
  assert.deepEqual(await store.import("Exact spoken words", 7), { success: true });
  assert.equal(store.read().seed, 7);

  const profile = JSON.parse(files.get("/profile/profile.json"));
  files.set("/profile/profile.json", JSON.stringify({ ...profile, seed: 0 }));
  assert.equal(store.read().seed, 42);

  await store.analyze();
  const before = files.get("/profile/profile.json");
  assert.deepEqual(await store.import("Exact spoken words", 1001), {
    success: false,
    error: "Seed must be a whole number from 1 to 1000",
  });
  assert.equal(files.get("/profile/profile.json"), before);
});
