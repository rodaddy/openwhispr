// Which pages may hold Chromium permissions (microphone, media, clipboard, ...).
// Pure and Electron-free so it can be unit-tested; permissionHandlers.js wires
// it into a session. The app's own pages keep everything, every other origin
// gets nothing.

function isAppUrl(url, { devServerUrl } = {}) {
  if (typeof url !== "string" || url === "") return false;
  if (url.startsWith("file://")) return true;
  if (url.startsWith("devtools://")) return true;
  if (typeof devServerUrl !== "string" || devServerUrl === "") return false;
  try {
    return new URL(url).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

// `permission` is unused today: it is accepted so callers can log it and so a
// per-permission rule can land here without touching the call sites.
function decidePermission({ url, permission: _permission, devServerUrl } = {}) {
  return isAppUrl(url, { devServerUrl });
}

module.exports = { isAppUrl, decidePermission };
