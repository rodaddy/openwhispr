const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSpeechProvider,
  omnivoiceBinaryName,
  createSidecarPidTracker,
  OMNIVOICE_MODEL_FILE,
  OMNIVOICE_CODEC_FILE,
} = require("../../src/helpers/localSpeechProvider");
const { outputNameFor } = require("../../scripts/build-omnivoice-cpp");
const { QUANTS, DEFAULT_QUANT } = require("../../scripts/download-omnivoice-gguf");

test("resolveSpeechProvider passes local and auto through and defaults to hub", () => {
  const table = [
    [undefined, "hub"],
    [null, "hub"],
    ["", "hub"],
    ["hub", "hub"],
    [" Local ", "local"],
    ["local", "local"],
    ["AUTO", "auto"],
    ["fish", "hub"],
    [42, "hub"],
  ];
  for (const [value, expected] of table) {
    assert.equal(resolveSpeechProvider(value), expected, `value ${JSON.stringify(value)}`);
  }
});

test("omnivoiceBinaryName matches the name the build script installs", () => {
  assert.equal(omnivoiceBinaryName("darwin", "arm64"), "omnivoice-tts-darwin-arm64");
  assert.equal(omnivoiceBinaryName("linux", "x64"), "omnivoice-tts-linux-x64");
  assert.equal(omnivoiceBinaryName("win32", "x64"), "omnivoice-tts-win32-x64.exe");
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ]) {
    assert.equal(omnivoiceBinaryName(platform, arch), outputNameFor(platform, arch));
  }
});

test("the model and codec file names are the ones the download script fetches", () => {
  assert.equal(OMNIVOICE_MODEL_FILE, "omnivoice-base-Q8_0.gguf");
  assert.equal(OMNIVOICE_CODEC_FILE, "omnivoice-tokenizer-Q8_0.gguf");
  assert.deepEqual(
    QUANTS[DEFAULT_QUANT].map((entry) => entry.name),
    [OMNIVOICE_MODEL_FILE, OMNIVOICE_CODEC_FILE]
  );
});

function pidTrackerHarness() {
  const calls = [];
  const tracker = createSidecarPidTracker({
    write: (pid) => calls.push(["write", pid]),
    clear: () => calls.push(["clear"]),
  });
  return { calls, tracker };
}

test("createSidecarPidTracker writes on spawn and clears when that child exits", () => {
  const { calls, tracker } = pidTrackerHarness();
  tracker.onSpawn({ pid: 100 });
  tracker.onExit({ pid: 100 });
  assert.deepEqual(calls, [["write", 100], ["clear"]]);
});

test("createSidecarPidTracker keeps the newer child's entry when an older child exits late", () => {
  const { calls, tracker } = pidTrackerHarness();
  tracker.onSpawn({ pid: 100 });
  tracker.onSpawn({ pid: 200 });
  tracker.onExit({ pid: 100 });
  assert.deepEqual(calls, [
    ["write", 100],
    ["write", 200],
  ]);
  tracker.onExit({ pid: 200 });
  assert.deepEqual(calls.at(-1), ["clear"]);
});

test("createSidecarPidTracker ignores a child without a pid and a repeated exit", () => {
  const { calls, tracker } = pidTrackerHarness();
  tracker.onSpawn({});
  tracker.onSpawn(null);
  tracker.onExit(undefined);
  tracker.onSpawn({ pid: 300 });
  tracker.onExit({ pid: 300 });
  tracker.onExit({ pid: 300 });
  assert.deepEqual(calls, [["write", 300], ["clear"]]);
});
