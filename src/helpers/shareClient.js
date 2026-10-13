/**
 * HTTP client for the rTech share service (server/share).
 *
 * Lives in the Electron MAIN process only: the bearer token must never reach
 * the renderer, so nothing here is ever imported from src/components or
 * src/services. The renderer talks to these methods over the `share-*` IPC
 * channels registered in ipcHandlers.js.
 */

const DEFAULT_TIMEOUT_MS = 15000;

function shareError(message, { code, status } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function notConfigured() {
  return shareError("Share service is not configured", { code: "share_not_configured" });
}

async function errorFromResponse(response) {
  let code = `http_${response.status}`;
  try {
    const body = await response.json();
    const bodyCode = body && body.error && body.error.code;
    if (typeof bodyCode === "string" && bodyCode.length > 0) code = bodyCode;
  } catch {
    // Non-JSON or empty body: keep the http_<status> code.
  }
  return shareError(`Share service request failed (${response.status})`, {
    code,
    status: response.status,
  });
}

function createShareClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const trimmedBase = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/$/, "") : "";
  const trimmedToken = typeof token === "string" ? token.trim() : "";
  const configured = trimmedBase.length > 0 && trimmedToken.length > 0;

  async function request(method, path, body) {
    if (!configured) throw notConfigured();
    const headers = { Authorization: `Bearer ${trimmedToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(`${trimmedBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.code === "TimeoutError");
      throw shareError(
        timedOut ? "Share service request timed out" : "Share service is unreachable",
        { code: timedOut ? "timeout" : "network" }
      );
    }
    return response;
  }

  async function shareRequest(method, path, body) {
    const response = await request(method, path, body);
    if (!response.ok) throw await errorFromResponse(response);
    const result = await response.json();
    return { token: result.token, url: result.url };
  }

  return {
    configured,
    baseUrl: trimmedBase,

    async create({ noteId, title, markdown }) {
      return shareRequest("POST", "/api/shares", {
        note_id: String(noteId),
        title,
        markdown,
      });
    },

    async update(shareToken, { title, markdown }) {
      return shareRequest("PUT", `/api/shares/${encodeURIComponent(shareToken)}`, {
        title,
        markdown,
      });
    },

    async rotate(shareToken) {
      return shareRequest("POST", `/api/shares/${encodeURIComponent(shareToken)}/rotate`);
    },

    async revoke(shareToken) {
      const response = await request("DELETE", `/api/shares/${encodeURIComponent(shareToken)}`);
      // 404 means the share is already gone, which is the requested end state.
      if (!response.ok && response.status !== 404) throw await errorFromResponse(response);
      return { ok: true };
    },
  };
}

function shareClientFromEnv(env = process.env) {
  return createShareClient({
    baseUrl: env.SHARE_SERVICE_URL,
    token: env.SHARE_SERVICE_TOKEN,
  });
}

module.exports = { createShareClient, shareClientFromEnv };
