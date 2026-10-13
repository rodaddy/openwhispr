const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

// Resolves a bundled helper binary across the dev layout (resources/) and the
// packaged layouts (process.resourcesPath, asar-unpacked). Returns null when
// no executable candidate exists so callers can fall back gracefully.
// A found path is cached per name for the process: idle pollers resolve the
// same helper every few seconds, and each miss cost up to 6 fs calls and a log
// line. A hit costs one X_OK check, so a helper removed, moved or made
// non-executable is dropped and re-resolved. Misses are not cached; a caller
// whose spawn still fails calls forgetBundledBinary so the next resolve looks again.
const resolved = new Map();

function resolveBundledBinary(binaryName, logContext) {
  const cached = resolved.get(binaryName);
  if (cached) {
    try {
      fs.accessSync(cached, fs.constants.X_OK);
      return cached;
    } catch {
      resolved.delete(binaryName);
    }
  }

  const candidates = [
    path.join(__dirname, "..", "..", "resources", "bin", binaryName),
    path.join(__dirname, "..", "..", "resources", binaryName),
  ];

  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, binaryName),
      path.join(process.resourcesPath, "bin", binaryName),
      path.join(process.resourcesPath, "resources", "bin", binaryName),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName)
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        debugLogger.info("Resolved binary", { name: binaryName, path: candidate }, logContext);
        resolved.set(binaryName, candidate);
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function forgetBundledBinary(binaryName) {
  resolved.delete(binaryName);
}

module.exports = { resolveBundledBinary, forgetBundledBinary };
