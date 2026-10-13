// Pure rules for the on-device assistant voice (rtech-whisper#630): which provider
// speaks, and the names of the sidecar binary and of its model files.

// Same files scripts/download-omnivoice-gguf.js fetches for its default quant.
const OMNIVOICE_MODEL_FILE = "omnivoice-base-Q8_0.gguf";
const OMNIVOICE_CODEC_FILE = "omnivoice-tokenizer-Q8_0.gguf";

// "local" and "auto" are opt-in; anything else (unset, empty, unknown) is the hub.
function resolveSpeechProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return provider === "local" || provider === "auto" ? provider : "hub";
}

// Same name scripts/build-omnivoice-cpp.js installs under resources/bin.
function omnivoiceBinaryName(platform, arch) {
  const name = `omnivoice-tts-${platform}-${arch}`;
  return platform === "win32" ? `${name}.exe` : name;
}

// Keeps one pid file entry in step with the sidecar that currently runs. An
// older child that exits after a newer one was spawned must not clear the
// newer one's entry.
function createSidecarPidTracker({ write, clear }) {
  let currentPid = null;
  return {
    onSpawn(child) {
      if (!Number.isInteger(child?.pid)) return;
      currentPid = child.pid;
      write(child.pid);
    },
    onExit(child) {
      if (child?.pid !== currentPid) return;
      currentPid = null;
      clear();
    },
  };
}

module.exports = {
  resolveSpeechProvider,
  omnivoiceBinaryName,
  createSidecarPidTracker,
  OMNIVOICE_MODEL_FILE,
  OMNIVOICE_CODEC_FILE,
};
