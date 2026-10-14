const crypto = require("crypto");
const nodeFs = require("fs");
const path = require("path");

// The pinned Q8_0 weights of scripts/download-omnivoice-gguf.js. Nothing here
// is bundled: the files download only when the user asks.
const OMNIVOICE_WEIGHTS_REVISION = "017094167b5c9ed565a5076ac9b3b93c5ecf5c73";
const OMNIVOICE_WEIGHTS_BASE_URL = `https://huggingface.co/Serveurperso/OmniVoice-GGUF/resolve/${OMNIVOICE_WEIGHTS_REVISION}`;

const OMNIVOICE_WEIGHTS = [
  {
    name: "omnivoice-base-Q8_0.gguf",
    size: 656395008,
    sha256: "2882d887921798aea13d45236556bdf8012842ab6f8cd2690943eead6289f298",
  },
  {
    name: "omnivoice-tokenizer-Q8_0.gguf",
    size: 288889600,
    sha256: "75204fa566a8e30984e7a1066da6557184c9fd099c8f1bc0cb5b9415edfec255",
  },
].map((entry) => ({ ...entry, url: `${OMNIVOICE_WEIGHTS_BASE_URL}/${entry.name}` }));

const DISK_SPACE_HEADROOM = 1.1;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    nodeFs
      .createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function sizeOfFile(statSync, filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return -1;
  }
}

// The dev script's default folder wins only when it already holds both files
// at their pinned size, the same test isInstalled() applies; otherwise the
// app's own cache root, which follows a relocated data folder.
function resolveOmnivoiceModelsDir({
  statSync,
  homeModelsDir,
  serviceModelsDir,
  entries = OMNIVOICE_WEIGHTS,
}) {
  const inHome = entries.every(
    (entry) => sizeOfFile(statSync, path.join(homeModelsDir, entry.name)) === entry.size
  );
  return inHome ? homeModelsDir : serviceModelsDir;
}

function createOmnivoiceWeightsStore({
  fs,
  modelsDir,
  downloadFile,
  sha256File: hashFile = sha256File,
  createDownloadSignal,
  checkDiskSpace,
  entries = OMNIVOICE_WEIGHTS,
}) {
  let active = null;
  let lastReported = 0;

  const destPath = (entry) => path.join(modelsDir, entry.name);
  // A file is downloaded and hashed under this name. Only a file whose hash
  // matched is renamed to its final name, so the final name can be trusted by
  // size alone, even after a quit in the middle of the hash.
  const stagingPath = (entry) => `${destPath(entry)}.download`;
  const partialPath = (entry) => `${stagingPath(entry)}.tmp`;

  const sizeOf = (filePath) => sizeOfFile((target) => fs.statSync(target), filePath);

  const isPresent = (entry) => sizeOf(destPath(entry)) === entry.size;

  function isInstalled() {
    return entries.every(isPresent);
  }

  function isDownloading() {
    return active !== null;
  }

  function lastPercentage() {
    return lastReported;
  }

  // Gives a staged file its final name when its hash matches, removes it otherwise.
  async function promote(entry) {
    const staged = stagingPath(entry);
    if (sizeOf(staged) === entry.size && (await hashFile(staged)) === entry.sha256) {
      fs.renameSync(staged, destPath(entry));
      return true;
    }
    fs.rmSync(staged, { force: true });
    return false;
  }

  function cancel() {
    if (active) active.abort();
  }

  async function run(signal, onProgress) {
    fs.mkdirSync(modelsDir, { recursive: true });

    // A staged file left by a quit during the hash is settled first.
    for (const entry of entries) {
      if (isPresent(entry) || sizeOf(stagingPath(entry)) < 0) continue;
      if (signal.aborted) return { success: false, code: "cancelled" };
      await promote(entry);
    }

    const missing = entries.filter((entry) => !isPresent(entry));
    if (checkDiskSpace && missing.length > 0) {
      // A partial file left by an earlier run already occupies its bytes.
      const missingBytes = missing.reduce(
        (sum, entry) => sum + entry.size - Math.max(0, sizeOf(partialPath(entry))),
        0
      );
      const space = await checkDiskSpace(
        modelsDir,
        Math.max(0, missingBytes) * DISK_SPACE_HEADROOM
      );
      if (!space.ok) return { success: false, code: "disk-full" };
    }

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let completedBytes = totalBytes - missing.reduce((sum, entry) => sum + entry.size, 0);
    // Never lower than the last report: a server that ignores the Range
    // request restarts the file from zero.
    // It starts at the files already complete, so a status read before the
    // first tick does not say 0. No event is sent for it.
    let reportedBytes = completedBytes;
    const percentageOf = (bytes) => (totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0);
    lastReported = percentageOf(reportedBytes);
    const report = (currentBytes) => {
      reportedBytes = Math.max(reportedBytes, Math.min(totalBytes, completedBytes + currentBytes));
      lastReported = percentageOf(reportedBytes);
      if (!onProgress) return;
      onProgress({ downloadedBytes: reportedBytes, totalBytes, percentage: lastReported });
    };

    for (const entry of missing) {
      if (signal.aborted) return { success: false, code: "cancelled" };
      // A partial at or past the pinned size cannot be resumed (the server
      // answers the Range request with 416), so it would fail on every click.
      if (sizeOf(partialPath(entry)) >= entry.size) fs.rmSync(partialPath(entry), { force: true });
      await downloadFile(entry.url, stagingPath(entry), {
        signal,
        expectedSize: entry.size,
        keepPartial: true,
        onProgress: (downloadedBytes) => report(downloadedBytes),
      });
      if (!(await promote(entry))) return { success: false, code: "checksum" };
      completedBytes += entry.size;
      report(0);
    }

    return { success: true };
  }

  async function download(onProgress) {
    if (active) return { success: false, code: "in-progress" };
    const controller = createDownloadSignal();
    active = controller;
    lastReported = 0;
    try {
      return await run(controller.signal, onProgress);
    } catch (error) {
      // Never a message: it can carry a path or the download URL.
      const cancelled = (error && error.isAbort) || controller.signal.aborted;
      return { success: false, code: cancelled ? "cancelled" : "failed" };
    } finally {
      active = null;
    }
  }

  return { isInstalled, download, cancel, isDownloading, lastPercentage };
}

module.exports = {
  OMNIVOICE_WEIGHTS,
  OMNIVOICE_WEIGHTS_REVISION,
  createOmnivoiceWeightsStore,
  resolveOmnivoiceModelsDir,
  sha256File,
};
