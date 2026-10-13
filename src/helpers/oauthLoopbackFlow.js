const http = require("http");
const crypto = require("crypto");
const { openExternalUrl } = require("./externalUrlOpener");

const OAUTH_TIMEOUT_MS = 120000;

const PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};

// Thrown by handleCallback to control the error code shown on the
// callback page (defaults to "server_error").
class OAuthFlowError extends Error {
  constructor(redirectCode, message) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

// Set only when a hosted callback page should handle the redirect instead of
// the local page this server serves.
function getDesktopCallbackUrl() {
  return process.env.VITE_OPENWHISPR_OAUTH_CALLBACK_URL || null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCallbackPage(message) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>rTech Whisper</title>",
    "<style>",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    "background:#faf7f2;color:#2b2724;",
    'font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}',
    "main{max-width:26rem;padding:2rem;text-align:center}",
    "h1{font-size:1.125rem;font-weight:600;margin:0 0 .75rem}",
    "p{font-size:.9375rem;line-height:1.5;margin:0;color:#5b544e}",
    "</style>",
    "</head>",
    "<body><main><h1>rTech Whisper</h1><p>" + message + "</p></main></body>",
    "</html>",
  ].join("");
}

function getProtocol() {
  const channel = process.env.OPENWHISPR_CHANNEL || "production";
  return PROTOCOL_BY_CHANNEL[channel] || PROTOCOL_BY_CHANNEL.production;
}

function buildCallbackRedirect(params) {
  const url = new URL(getDesktopCallbackUrl());
  url.searchParams.set("protocol", getProtocol());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// Answers the browser that finished the flow. With
// VITE_OPENWHISPR_OAUTH_CALLBACK_URL set, redirect to that hosted page; with it
// unset, serve a self-contained local page so nothing leaves this machine.
function respond(res, params, errorParam) {
  if (getDesktopCallbackUrl()) {
    res.writeHead(302, { Location: buildCallbackRedirect(params) });
    res.end();
    return;
  }

  const errorCode = params[errorParam];
  const message =
    errorCode === undefined
      ? "Connected. You can close this tab and return to rTech Whisper."
      : `Sign-in did not finish (${escapeHtml(errorCode)}). Close this tab and try again from ` +
        "rTech Whisper.";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderCallbackPage(message));
}

// Runs a PKCE auth-code flow through an ephemeral 127.0.0.1 server:
// - buildAuthUrl(redirectUri, state, codeChallenge) → provider authorize URL
// - handleCallback(code, redirectUri, codeVerifier) → resolves the flow result;
//   called once with a state-validated code, throws (OAuthFlowError for a
//   specific callback-page code) to reject.
// - errorParam — query-param name for the callback page
//   (e.g. "gcal_error"); the success param is derived from the same prefix.
function runOAuthLoopbackFlow({ buildAuthUrl, handleCallback, errorParam }) {
  const connectedParam = errorParam.replace(/_error$/, "_connected");

  return new Promise((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("hex");
    let callbackClaimed = false;

    const server = http.createServer(async (req, res) => {
      // Accepted requests can outlive server.close(), so only the first
      // terminal callback may settle the flow or exchange a code.
      if (callbackClaimed) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h3>Invalid request.</h3></body></html>");
        return;
      }

      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          callbackClaimed = true;
          respond(res, { [errorParam]: error }, errorParam);
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h3>Invalid request.</h3></body></html>");
          // A real callback with a code but the wrong state is a failed
          // attempt (stale tab, CSRF). Fail the flow now. A request with no
          // code (favicon / bare GET) must keep waiting for the redirect.
          if (code) {
            callbackClaimed = true;
            cleanup();
            reject(new Error("OAuth state mismatch"));
          }
          return;
        }

        callbackClaimed = true;
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const result = await handleCallback(code, redirectUri, codeVerifier);

        respond(res, { [connectedParam]: "true" }, errorParam);
        cleanup();
        resolve(result);
      } catch (err) {
        callbackClaimed = true;
        respond(res, { [errorParam]: err.redirectCode || "server_error" }, errorParam);
        cleanup();
        reject(err);
      }
    });

    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      server.close();
    };

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      // Fire-and-forget like the shell.openExternal call it replaced: a failed
      // browser launch surfaces as the flow timeout.
      openExternalUrl(buildAuthUrl(redirectUri, state, codeChallenge)).catch(() => {});
    });

    timeoutId = setTimeout(() => {
      callbackClaimed = true;
      server.close();
      reject(new Error("OAuth flow timed out"));
    }, OAUTH_TIMEOUT_MS);

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

module.exports = { runOAuthLoopbackFlow, OAuthFlowError };
