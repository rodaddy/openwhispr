const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const secretCrypto = require("./secretCrypto");

// The hub device key (rtech-whisper#101) has its own file. auth-token.bin is
// the upstream sign-in bearer: no longer written, and never a hub credential,
// so a copy left by an older build is removed rather than sent to the hub.
const tokenFile = () => path.join(app.getPath("userData"), "hub-device-key.bin");
const legacyTokenFile = () => path.join(app.getPath("userData"), "auth-token.bin");

function removeLegacyToken() {
  try {
    fs.rmSync(legacyTokenFile(), { force: true });
  } catch (err) {
    debugLogger.error("tokenStore legacy token cleanup failed", { error: err?.message });
  }
}

let cached = null;
let generation = 0;
const listeners = new Set();

function state() {
  return { token: get(), generation };
}

function publish() {
  const next = state();
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (err) {
      debugLogger.error("tokenStore listener failed", { error: err?.message });
    }
  }
  return next;
}

function persist(token) {
  const file = tokenFile();
  const data = secretCrypto.isAvailable()
    ? secretCrypto.encrypt(token)
    : Buffer.from(token, "utf8");
  fs.writeFileSync(file, data, { mode: 0o600 });
}

function get() {
  if (cached !== null) return cached || null;
  removeLegacyToken();
  try {
    const file = tokenFile();
    if (!fs.existsSync(file)) return (cached = "");
    const buf = fs.readFileSync(file);
    if (!secretCrypto.isAvailable()) {
      cached = buf.toString("utf8");
      return cached || null;
    }
    const { value, needsReencrypt } = secretCrypto.decrypt(buf);
    cached = value;
    if (needsReencrypt) {
      try {
        persist(value);
      } catch (err) {
        // Re-encryption is maintenance, not an authentication boundary. Keep
        // the successfully decrypted credential for this process.
        debugLogger.error("tokenStore re-encryption failed", { error: err?.message });
      }
    }
    return cached || null;
  } catch (err) {
    debugLogger.error("tokenStore.get failed", { error: err?.message });
    cached = "";
    return null;
  }
}

function set(token) {
  if (typeof token !== "string" || !token) return { success: false, ...state() };
  const current = get();
  if (current === token) return { success: true, ...state() };
  try {
    persist(token);
    cached = token;
    generation += 1;
    return { success: true, ...publish() };
  } catch (err) {
    debugLogger.error("tokenStore.set failed", { error: err?.message });
    return { success: false, ...state() };
  }
}

function setIfGeneration(token, expectedGeneration) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== generation) {
    return {
      success: false,
      code: "AUTH_CONTEXT_CHANGED",
      ...state(),
    };
  }
  return set(token);
}

function clear() {
  // Load the key before touching disk so a failed clear can restore it.
  const previous = get() || "";
  removeLegacyToken();
  let success = true;
  try {
    fs.rmSync(tokenFile(), { force: true });
  } catch (err) {
    debugLogger.error("tokenStore.clear failed", { error: err?.message });
    try {
      // A valid encrypted empty value prevents the old bearer resurfacing on
      // restart when unlinking is temporarily unavailable.
      persist("");
    } catch (persistError) {
      success = false;
      debugLogger.error("tokenStore clear fallback failed", {
        error: persistError?.message,
      });
    }
  }
  // A failed clear leaves the key on disk, so every reader keeps seeing it
  // and the user can retry (#143 #225); a restart would read it back anyway.
  cached = success ? "" : previous;
  // Clearing is an explicit credential boundary even when no bearer was
  // cached (a window may still have an in-flight cookie-era request).
  generation += 1;
  return { success, ...publish() };
}

function getState() {
  return state();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { get, getState, set, setIfGeneration, clear, subscribe };
