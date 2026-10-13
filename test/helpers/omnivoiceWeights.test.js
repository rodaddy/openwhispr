const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  OMNIVOICE_WEIGHTS,
  OMNIVOICE_WEIGHTS_REVISION,
  createOmnivoiceWeightsStore,
  resolveOmnivoiceModelsDir,
} = require("../../src/helpers/omnivoiceWeights");
const {
  OMNIVOICE_MODEL_FILE,
  OMNIVOICE_CODEC_FILE,
} = require("../../src/helpers/localSpeechProvider");
const { QUANTS, HF_REVISION, fileUrl } = require("../../scripts/download-omnivoice-gguf");

const MODELS_DIR = path.join(path.sep, "models");
const ENTRIES = [
  { name: "base.gguf", size: 6, sha256: "sha-base", url: "https://weights.test/base.gguf" },
  { name: "codec.gguf", size: 4, sha256: "sha-codec", url: "https://weights.test/codec.gguf" },
];
const destOf = (entry) => path.join(MODELS_DIR, entry.name);
const stagedOf = (entry) => `${destOf(entry)}.download`;
const shaOf = (filePath) => `sha-${path.basename(filePath).replace(/\.gguf(\.download)?$/, "")}`;

function createFakeFs(files = new Map()) {
  return {
    files,
    statSync(filePath) {
      if (!files.has(filePath)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: files.get(filePath).length };
    },
    mkdirSync() {},
    rmSync(filePath) {
      files.delete(filePath);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function abortError() {
  return Object.assign(new Error("Download cancelled"), { isAbort: true });
}

function createSignal() {
  const signal = { aborted: false, onAbort: null };
  return {
    signal,
    abort() {
      signal.aborted = true;
      if (signal.onAbort) signal.onAbort();
    },
  };
}

// Mirrors the app's downloadFile: bytes land in <dest>.tmp, an existing
// partial is resumed, and the file is renamed to <dest> when whole. The store
// passes a staging name as <dest>.
function createFakeDownload(fakeFs, { gate } = {}) {
  const calls = [];
  const downloadFile = async (url, dest, options) => {
    calls.push({ url, dest, options });
    const entry = ENTRIES.find((candidate) => candidate.url === url);
    const tmp = `${dest}.tmp`;
    const half = Math.floor(entry.size / 2);
    const start = fakeFs.files.has(tmp) ? fakeFs.files.get(tmp).length : 0;
    if (start < half) {
      fakeFs.files.set(tmp, "x".repeat(half));
      options.onProgress(half, entry.size);
    }
    if (gate) {
      await new Promise((resolve, reject) => {
        options.signal.onAbort = () => reject(abortError());
        gate.then(resolve);
      });
    }
    fakeFs.files.delete(tmp);
    fakeFs.files.set(dest, "x".repeat(entry.size));
    options.onProgress(entry.size, entry.size);
    return dest;
  };
  return { calls, downloadFile };
}

function createStore(overrides = {}) {
  const fakeFs = overrides.fs || createFakeFs();
  const download = overrides.download || createFakeDownload(fakeFs);
  const store = createOmnivoiceWeightsStore({
    fs: fakeFs,
    modelsDir: MODELS_DIR,
    downloadFile: download.downloadFile,
    sha256File: async (filePath) => shaOf(filePath),
    createDownloadSignal: createSignal,
    entries: ENTRIES,
    ...overrides.deps,
  });
  return { store, fakeFs, calls: download.calls };
}

test("the pinned weights are the dev script's Q8_0 files and the engine's file names", () => {
  assert.equal(OMNIVOICE_WEIGHTS_REVISION, HF_REVISION);
  assert.deepEqual(
    OMNIVOICE_WEIGHTS,
    QUANTS.Q8_0.map((entry) => ({ ...entry, url: fileUrl(entry.name) }))
  );
  assert.deepEqual(
    OMNIVOICE_WEIGHTS.map((entry) => entry.name),
    [OMNIVOICE_MODEL_FILE, OMNIVOICE_CODEC_FILE]
  );
});

test("the home folder is used only when it holds both weight files at the pinned size", () => {
  const resolve = (sizes) =>
    resolveOmnivoiceModelsDir({
      statSync: createFakeFs(
        new Map(
          Object.entries(sizes).map(([name, size]) => [`/home/models/${name}`, "x".repeat(size)])
        )
      ).statSync,
      homeModelsDir: "/home/models",
      serviceModelsDir: "/service/models",
      entries: ENTRIES,
    });

  assert.equal(resolve({ "base.gguf": 6, "codec.gguf": 4 }), "/home/models");
  assert.equal(resolve({ "base.gguf": 6 }), "/service/models");
  assert.equal(resolve({ "base.gguf": 6, "codec.gguf": 3 }), "/service/models");
});

test("downloading both files reports progress summed over both and ends installed", async () => {
  const { store, calls } = createStore();
  const progress = [];

  assert.equal(store.isInstalled(), false);
  const result = await store.download((update) => progress.push(update));

  assert.deepEqual(result, { success: true });
  assert.equal(store.isInstalled(), true);
  assert.deepEqual(
    calls.map((call) => [call.url, call.options.expectedSize, call.options.keepPartial]),
    ENTRIES.map((entry) => [entry.url, entry.size, true])
  );
  assert.deepEqual(
    progress.map((update) => update.downloadedBytes),
    [3, 6, 6, 8, 10, 10]
  );
  assert.deepEqual(progress.at(-1), { downloadedBytes: 10, totalBytes: 10, percentage: 100 });
});

test("a file already present at the pinned size is not downloaded again", async () => {
  const fakeFs = createFakeFs(new Map([[destOf(ENTRIES[0]), "x".repeat(ENTRIES[0].size)]]));
  const { store, calls } = createStore({ fs: fakeFs });
  const progress = [];

  const result = await store.download((update) => progress.push(update));

  assert.deepEqual(result, { success: true });
  assert.deepEqual(
    calls.map((call) => call.url),
    [ENTRIES[1].url]
  );
  assert.equal(progress[0].downloadedBytes, 8, "the finished file counts as downloaded");
});

test("the percentage starts at the share of the files already complete", async () => {
  const fakeFs = createFakeFs(new Map([[destOf(ENTRIES[0]), "x".repeat(ENTRIES[0].size)]]));
  let release;
  const { store } = createStore({
    fs: fakeFs,
    download: {
      calls: [],
      // Reports nothing until released.
      downloadFile: async (url, dest) => {
        await new Promise((resolve) => (release = resolve));
        fakeFs.files.set(dest, "x".repeat(ENTRIES[1].size));
      },
    },
  });
  const progress = [];

  const running = store.download((update) => progress.push(update));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.lastPercentage(), 60);
  assert.deepEqual(progress, [], "the starting share sends no event");
  release();
  assert.deepEqual(await running, { success: true });
});

test("a file is never at its final name before its hash matched", async () => {
  const fakeFs = createFakeFs();
  const atFinalNameDuringHash = [];
  const { store } = createStore({
    fs: fakeFs,
    deps: {
      sha256File: async (filePath) => {
        atFinalNameDuringHash.push(fakeFs.files.has(destOf(ENTRIES[1])));
        return filePath === stagedOf(ENTRIES[1]) ? "sha-wrong" : shaOf(filePath);
      },
    },
  });

  const result = await store.download();

  assert.deepEqual(result, { success: false, code: "checksum" });
  assert.deepEqual(atFinalNameDuringHash, [false, false]);
  assert.equal(fakeFs.files.has(destOf(ENTRIES[1])), false);
  assert.equal(fakeFs.files.has(stagedOf(ENTRIES[1])), false);
  assert.equal(store.isInstalled(), false);
});

test("a staged file left by an earlier run is promoted after its hash matches, not downloaded again", async () => {
  const fakeFs = createFakeFs(new Map([[stagedOf(ENTRIES[0]), "x".repeat(ENTRIES[0].size)]]));
  const { store, calls } = createStore({ fs: fakeFs });

  assert.equal(store.isInstalled(), false, "a staged file is not an installed one");
  assert.deepEqual(await store.download(), { success: true });

  assert.deepEqual(
    calls.map((call) => call.url),
    [ENTRIES[1].url]
  );
  assert.equal(fakeFs.files.has(stagedOf(ENTRIES[0])), false);
  assert.equal(store.isInstalled(), true);
});

test("the percentage never goes down when a file restarts from zero", async () => {
  const fakeFs = createFakeFs();
  const { store } = createStore({
    fs: fakeFs,
    download: {
      calls: [],
      // A server that ignores the Range request: the count starts over.
      downloadFile: async (url, dest, options) => {
        const entry = ENTRIES.find((candidate) => candidate.url === url);
        options.onProgress(entry.size - 1, entry.size);
        options.onProgress(1, entry.size);
        fakeFs.files.set(dest, "x".repeat(entry.size));
        options.onProgress(entry.size, entry.size);
      },
    },
  });
  const percentages = [];

  assert.deepEqual(await store.download((update) => percentages.push(update.percentage)), {
    success: true,
  });

  assert.deepEqual(percentages, [50, 50, 60, 60, 90, 90, 100, 100]);
  assert.equal(store.lastPercentage(), 100);
});

test("a second download while one runs is refused", async () => {
  const fakeFs = createFakeFs();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { store } = createStore({ fs: fakeFs, download: createFakeDownload(fakeFs, { gate }) });

  const first = store.download();
  assert.equal(store.isDownloading(), true);
  assert.deepEqual(await store.download(), { success: false, code: "in-progress" });

  release();
  assert.deepEqual(await first, { success: true });
  assert.equal(store.isDownloading(), false);
});

test("cancel ends the run as cancelled and keeps the partial file for the next run", async () => {
  const fakeFs = createFakeFs();
  const gate = new Promise(() => {});
  const { store } = createStore({ fs: fakeFs, download: createFakeDownload(fakeFs, { gate }) });

  const running = store.download();
  await new Promise((resolve) => setImmediate(resolve));
  store.cancel();

  assert.deepEqual(await running, { success: false, code: "cancelled" });
  assert.equal(fakeFs.files.get(`${stagedOf(ENTRIES[0])}.tmp`).length, 3);
  assert.equal(store.isDownloading(), false);
});

test("a failed download reports a code and never the error text", async () => {
  const { store } = createStore({
    download: {
      calls: [],
      downloadFile: async (url, dest) => {
        throw new Error(`HTTP 500 for ${url} at ${dest}`);
      },
    },
  });

  assert.deepEqual(await store.download(), { success: false, code: "failed" });
});

test("too little disk space is refused before anything downloads", async () => {
  const required = [];
  const { store, calls } = createStore({
    deps: {
      checkDiskSpace: async (directory, bytes) => {
        required.push([directory, bytes]);
        return { ok: false, availableBytes: 1 };
      },
    },
  });

  assert.deepEqual(await store.download(), { success: false, code: "disk-full" });
  assert.deepEqual(required, [[MODELS_DIR, 11]]);
  assert.deepEqual(calls, []);
});
