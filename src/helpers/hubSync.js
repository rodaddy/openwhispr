const { createCloudApiRequestHandler } = require("./cloudApiRequest");

// The rTech Whisper hub replaces the build-time VITE_OPENWHISPR_API_URL with a
// runtime URL, and the removed sign-in session with a per-device key held in
// tokenStore as the bearer. This module only wires transport and credentials;
// it never opens the sync consent gate.

// The hub URL is https:// (protocol section 1). Plain http:// is accepted only
// for a hub on this machine (decision D13).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseHubUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

// True for an http:// URL whose host is not loopback: refused on save, and
// read as hub off when already stored.
function isInsecureHubUrl(value) {
  const url = parseHubUrl(value);
  return Boolean(url) && url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname);
}

// Returns the canonical hub base URL, "" for "sync off", or null when invalid.
// The cloud request handler concatenates `${base}${path}`, so the base keeps
// any path prefix but never a trailing slash, query, fragment, or credentials.
function normalizeHubUrl(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (isInsecureHubUrl(trimmed)) return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// Saving a different, non-empty hub URL is a hub switch:
// the app relaunches so the startup swap moves the local cloud ids and cursors
// to the new hub before any pass runs. Turning the hub off is not a switch.
function isHubSwitch(before, after) {
  return Boolean(after) && after !== before;
}

function createHubBridge({ getHubUrl, saveHubUrl, tokenStore, getAppVersion, proxyFetch, logger }) {
  const getUrl = () => normalizeHubUrl(getHubUrl()) || "";
  // A stored non-loopback http URL (saved by an older build) is hub off; this names
  // it so Settings can say why. "" when the stored URL is not one.
  const getInsecureUrl = () => {
    const stored = getHubUrl();
    return isInsecureHubUrl(stored) ? stored.trim() : "";
  };

  // The renderer learns whether a key exists and its generation (needed as the
  // request fence), never the key itself.
  const keyState = () => {
    const state = tokenStore.getState();
    return { hasKey: Boolean(state.token), generation: state.generation };
  };

  const request = createCloudApiRequestHandler({
    getApiUrl: getUrl,
    getAppVersion,
    proxyFetch,
    tokenStore,
    logger,
  });

  return {
    request,
    getUrl,
    getInsecureUrl,
    saveUrl(value) {
      const url = normalizeHubUrl(value);
      if (url === null && isInsecureHubUrl(value))
        return { success: false, code: "INSECURE_HUB_URL", error: "Hub URL must use https://" };
      if (url === null)
        return { success: false, code: "INVALID_HUB_URL", error: "Invalid hub URL" };
      saveHubUrl(url);
      return { success: true, url };
    },
    getKeyState: keyState,
    setKey(key) {
      if (typeof key !== "string" || !key.trim()) {
        return { success: false, code: "INVALID_DEVICE_KEY", ...keyState() };
      }
      const result = tokenStore.set(key.trim());
      return { success: Boolean(result?.success), ...keyState() };
    },
    // tokenStore.clear() keeps the key when it could not be removed from disk,
    // so keyState() stays truthful for this reply and every later read.
    clearKey() {
      const result = tokenStore.clear();
      return { success: Boolean(result?.success), ...keyState() };
    },
  };
}

module.exports = { normalizeHubUrl, isInsecureHubUrl, isHubSwitch, createHubBridge };
