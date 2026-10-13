const { decidePermission } = require("./permissionPolicy");

// Origin only: a denied URL can carry tokens in its path or query string, and
// this value goes to the log.
function describeOrigin(url) {
  if (typeof url !== "string" || url === "") return "unknown";
  try {
    const { origin, protocol } = new URL(url);
    return origin && origin !== "null" ? origin : protocol;
  } catch {
    return "unparseable";
  }
}

// Without these handlers Electron grants every permission to every origin.
// Install once per session, before any window that uses it exists.
function installPermissionHandlers(targetSession, { devServerUrl, log } = {}) {
  const loggedDenials = new Set();

  const reportDenial = (url, permission) => {
    try {
      const origin = describeOrigin(url);
      const key = `${origin}|${permission}`;
      if (loggedDenials.has(key)) return;
      // A log that returns false did not record the line (no logger yet), so
      // the same denial is reported again later.
      if (log?.(`Denied permission "${permission}" for origin ${origin}`) === false) return;
      loggedDenials.add(key);
    } catch {
      // Logging must never change the decision.
    }
  };

  const decide = (resolveUrl, permission) => {
    let url = "";
    try {
      url = resolveUrl();
      if (decidePermission({ url, permission, devServerUrl })) return true;
    } catch {
      // Fall through to the denial below.
    }
    reportDenial(url, permission);
    return false;
  };

  // The page URL stands in for a missing requester only for the main frame: a
  // sub-frame must never borrow the identity of the app page that hosts it.
  const pageUrl = (webContents, details) =>
    details?.isMainFrame === false ? "" : webContents?.getURL?.() || "";

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(decide(() => details?.requestingUrl || pageUrl(webContents, details), permission));
  });

  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    decide(
      () => requestingOrigin || details?.requestingUrl || pageUrl(webContents, details),
      permission
    )
  );
}

module.exports = { installPermissionHandlers };
