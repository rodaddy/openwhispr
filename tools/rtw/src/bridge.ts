// Client for the rTech Whisper app's loopback CLI bridge
// (src/helpers/cliBridge.js). The app owns the bridge file and the token; this
// module only reads them. The token is never printed, logged, or put in an
// error message: a BridgeError carries the host and port only.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 10_000;

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface Bridge {
  version: number;
  port: number;
  token: string;
}

export function bridgeFilePath(): string {
  return process.env.RTW_BRIDGE_FILE || join(homedir(), ".openwhispr", "cli-bridge.json");
}

export function readBridge(): Bridge {
  const path = bridgeFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new BridgeError(`rTech Whisper is not running (no bridge file at ${path})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeError(`Bridge file at ${path} is not valid JSON`);
  }
  const bridge = parsed as Partial<Bridge>;
  if (typeof bridge?.port !== "number" || typeof bridge?.token !== "string") {
    throw new BridgeError(`Bridge file at ${path} is missing a port or token`);
  }
  return { version: bridge.version ?? 1, port: bridge.port, token: bridge.token };
}

function errorMessage(payload: unknown, status: number): string {
  const err = (payload as { error?: { code?: string; message?: string } })?.error;
  if (err?.code || err?.message) {
    return `${err.code ?? "error"}: ${err.message ?? "request failed"}`;
  }
  return `http_${status}: request failed`;
}

/**
 * Call the bridge and return the `data` field of its envelope. Rejects with a
 * BridgeError for every failure the caller can act on: app not running,
 * connection refused, timeout, or a non-2xx response.
 */
export async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const bridge = readBridge();
  const url = `http://${HOST}:${bridge.port}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bridge.token}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BridgeError(
        `rTech Whisper did not answer within ${REQUEST_TIMEOUT_MS / 1000}s (bridge at ${HOST}:${bridge.port})`
      );
    }
    throw new BridgeError(
      `rTech Whisper is not running (bridge at ${HOST}:${bridge.port} refused)`
    );
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw new BridgeError(errorMessage(payload, response.status));

  return (payload as { data?: unknown })?.data ?? null;
}

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const api = {
  health: () => call("GET", "/v1/health"),
  notesList: (opts: { limit?: number; folder_id?: number; note_type?: string } = {}) =>
    call("GET", `/v1/notes/list${query(opts)}`),
  notesSearch: (q: string, limit?: number) => call("GET", `/v1/notes/search${query({ q, limit })}`),
  noteGet: (id: number | string) => call("GET", `/v1/notes/${id}`),
  noteCreate: (input: {
    title: string;
    content?: string;
    note_type?: string;
    folder_id?: number;
  }) => call("POST", "/v1/notes/create", input),
  noteUpdate: (id: number | string, input: { title?: string; content?: string }) =>
    call("PATCH", `/v1/notes/${id}`, input),
  foldersList: () => call("GET", "/v1/folders/list"),
  transcriptionsList: (limit?: number) => call("GET", `/v1/transcriptions/list${query({ limit })}`),
};
