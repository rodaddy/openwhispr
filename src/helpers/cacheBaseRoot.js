const os = require("os");
const path = require("path");

// The one cache-root fallback: the data folder's cache when boot set
// OPENWHISPR_CACHE_ROOT, else the home cache. No electron import, so sidecar
// managers and their tests can load it.
function getCacheBaseRoot() {
  return process.env.OPENWHISPR_CACHE_ROOT || path.join(os.homedir(), ".cache", "openwhispr");
}

module.exports = { getCacheBaseRoot };
