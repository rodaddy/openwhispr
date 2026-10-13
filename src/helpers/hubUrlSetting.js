// The stored SYNC_HUB_URL setting (rtech-whisper#112). A Mac that never set it
// uses the build's default hub, RTECH_WHISPER_HUB_URL from the environment or
// the bundled .env (empty means no default: sync stays off until a URL is
// saved). Nothing talks to the hub until a device key is saved. The env store drops empty values,
// so "the user turned the hub off" is stored as an explicit marker: an empty
// save must not read back as unset and bring the default back.

const HUB_URL_OFF = "off";

// Read at call time: the bundled .env is loaded after this module.
function defaultHubUrl() {
  return (process.env.RTECH_WHISPER_HUB_URL || "").trim();
}

// Stored value -> effective hub URL ("" means off).
function readHubUrlSetting(stored) {
  if (stored === undefined || stored === null || stored === "") return defaultHubUrl();
  if (stored === HUB_URL_OFF) return "";
  return stored;
}

// Normalized hub URL ("" means off) -> value to store.
function hubUrlToStore(url) {
  return url ? url : HUB_URL_OFF;
}

module.exports = { defaultHubUrl, HUB_URL_OFF, readHubUrlSetting, hubUrlToStore };
