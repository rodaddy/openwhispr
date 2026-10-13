// Pushes saved grill sessions to the social-media-pipeline (SMP) and reads
// its open feed questions. The wire shape is SMP's grill contract
// (social-media-pipeline docs/local-pipeline/grill-contract.md):
// POST /internal/grill/sessions and GET /internal/grill/questions, both behind
// "Authorization: Bearer <token>". Modeled on crmConnector.js: 10s timeout,
// redirects refused, one request at a time per note.
//
// Logs carry note ids, counts, and HTTP status only: never turn text, never
// the token.
const { parseNoteDate } = require("./transcriptFormatter");

const REQUEST_TIMEOUT_MS = 10000;
const SESSIONS_PATH = "/internal/grill/sessions";
const QUESTIONS_PATH = "/internal/grill/questions";
const LOG_SCOPE = "pipeline";
const MAX_REASON_LENGTH = 300;
// SMP's GrillSessionRequest.title is max_length=500, counted in code points
// (Python str length), so the cap never splits a surrogate pair.
const MAX_TITLE_LENGTH = 500;
// The note itself cannot become a valid session: stop retrying it until it is
// saved again (saveGrillMeta clears the state).
const NOT_SENDABLE_CODES = new Set(["NO_TURNS", "INVALID_NOTE"]);

class PipelineError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "PipelineError";
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new PipelineError("Pipeline URL must be a valid HTTP(S) URL", {
      code: "INVALID_SETTINGS",
    });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new PipelineError(
      "Pipeline URL must be a valid HTTP(S) URL without credentials, query, or fragment",
      { code: "INVALID_SETTINGS" }
    );
  }
  return url.toString().replace(/\/$/, "");
}

function normalizePipelineSettings(input = {}) {
  return { baseUrl: normalizeBaseUrl(input.baseUrl) };
}

function parseSegments(transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return [];
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Role-tagged grill turns in contract form; segments without a role are not grill turns. */
function grillTurns(transcript) {
  return parseSegments(transcript).flatMap((segment) => {
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!text) return [];
    if (segment.role === "assistant") {
      // D-L1-5: only feed ids go on the wire; bank "gq-" ids and follow_up_of
      // stay local until pipeline lane L2 widens the SMP contract.
      const questionId =
        typeof segment.question_id === "string" && segment.question_id.startsWith("fq-")
          ? segment.question_id
          : null;
      return [{ role: "interviewer", text, question_id: questionId }];
    }
    if (segment.role === "user") return [{ role: "rico", text, question_id: null }];
    return [];
  });
}

function parseMeta(raw) {
  if (!raw) return null;
  try {
    const meta = typeof raw === "string" ? JSON.parse(raw) : raw;
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

const LIFE_STORY_TITLE = /^Life Story ch (\d+):/;

function isoFrom(value) {
  if (!value) return null;
  const date = parseNoteDate(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The POST /internal/grill/sessions body for a saved grill note. A note saved
 * before its meta was recorded falls back to its title and timestamps.
 */
function buildGrillSessionPayload(note) {
  const turns = grillTurns(note?.transcript);
  if (turns.length === 0) {
    throw new PipelineError("This note has no grill turns to send", { code: "NO_TURNS" });
  }
  const meta = parseMeta(note.grill_meta);
  const titleChapter = LIFE_STORY_TITLE.exec(String(note.title || ""));
  const lifetime = meta ? meta.kind === "lifetime" : Boolean(titleChapter);
  const chapter = lifetime ? Number(meta?.chapter ?? titleChapter?.[1]) : null;
  const interviewer = turns.filter((turn) => turn.role === "interviewer");
  const allFeed = interviewer.length > 0 && interviewer.every((turn) => turn.question_id);
  const startedAt = isoFrom(meta?.startedAt) || isoFrom(note.created_at);
  const endedAt = isoFrom(meta?.endedAt) || isoFrom(note.updated_at) || startedAt;
  if (!startedAt || (lifetime && !Number.isInteger(chapter))) {
    throw new PipelineError("This note is missing its grill session details", {
      code: "INVALID_NOTE",
    });
  }
  return {
    note_id: `whisper-${note.id}`,
    session_kind: lifetime ? "lifetime" : allFeed ? "feed" : "daily",
    chapter: lifetime ? chapter : null,
    title: Array.from(String(note.title || "Grill"))
      .slice(0, MAX_TITLE_LENGTH)
      .join(""),
    started_at: startedAt,
    ended_at: endedAt,
    turns,
  };
}

function isGrillNote(note) {
  return grillTurns(note?.transcript).length > 0;
}

// SMP's 400 body is {"ok":false,"error":"invalid_body","reason":"<rule>"}: the
// rule is in reason; error and detail are fallbacks for other shapes.
function reasonOf(payload) {
  for (const raw of [payload?.reason, payload?.error, payload?.detail]) {
    if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, MAX_REASON_LENGTH);
  }
  return "";
}

function errorForStatus(status, payload) {
  if (status === 401 || status === 403) {
    return new PipelineError("Pipeline refused the token", { code: "UNAUTHORIZED", status });
  }
  if (status === 400) {
    const reason = reasonOf(payload);
    return new PipelineError(
      reason ? `Pipeline rejected the session: ${reason}` : "Pipeline rejected the session",
      { code: "BAD_REQUEST", status }
    );
  }
  if (status === 502) {
    return new PipelineError("Pipeline could not extract the session", {
      code: "UPSTREAM_FAILED",
      status,
    });
  }
  return new PipelineError("Pipeline request failed", { code: "HTTP_ERROR", status });
}

/** The stored last_error: the code, the HTTP status, and SMP's safe reason. */
function describeFailure(error) {
  if (!(error instanceof PipelineError)) return "Pipeline send failed";
  const status = error.status ? ` (HTTP ${error.status})` : "";
  return `${error.code || "ERROR"}${status}: ${error.message}`;
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function createPipelineConnector({
  store,
  fetchImpl = fetch,
  now = () => new Date(),
  log = silentLog,
}) {
  const noteQueues = new Map();
  const background = new Set();
  // Pending notes that no longer resolve (deleted, or outside the active
  // account): dropped from the retry set until saved again, logged once each.
  const goneNotes = new Set();

  async function currentConfig() {
    let settings;
    try {
      settings = normalizePipelineSettings(await store.getSettings());
    } catch {
      return null;
    }
    const token = String((await store.getToken()) || "");
    return token ? { ...settings, token } : null;
  }

  async function requireConfig() {
    const config = await currentConfig();
    if (!config) {
      throw new PipelineError("Pipeline URL and token are required", { code: "NOT_CONFIGURED" });
    }
    return config;
  }

  async function request(config, path, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetchImpl(`${config.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${config.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new PipelineError("Pipeline is unreachable (timed out)", { code: "UNREACHABLE" });
        }
        throw new PipelineError("Pipeline is unreachable", { code: "UNREACHABLE" });
      }
      if (response.status >= 300 && response.status < 400) {
        throw new PipelineError("Pipeline redirects are not allowed", {
          code: "REDIRECT_BLOCKED",
          status: response.status,
        });
      }
      let payload = null;
      const contentType = response.headers?.get?.("content-type") || "";
      if (contentType.includes("json")) {
        try {
          payload = await response.json();
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError") {
            throw new PipelineError("Pipeline is unreachable (timed out)", { code: "UNREACHABLE" });
          }
          payload = null;
        }
      }
      if (!response.ok) throw errorForStatus(response.status, payload);
      if (!payload || typeof payload !== "object") {
        throw new PipelineError("Pipeline returned an invalid response", {
          code: "INVALID_RESPONSE",
          status: response.status,
        });
      }
      return { payload, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendOnce(noteId, config) {
    try {
      const note = await store.getNote(noteId);
      if (!note || note.deleted_at) {
        const key = String(noteId);
        if (!goneNotes.has(key)) {
          goneNotes.add(key);
          log.warn("Pipeline note no longer resolves; dropped from retry", { noteId }, LOG_SCOPE);
        }
        // No row is left to record last_error on, so nothing is written.
        throw new PipelineError("Note not found", { code: "NOTE_NOT_FOUND" });
      }
      goneNotes.delete(String(noteId));
      const body = buildGrillSessionPayload(note);
      const { payload, status } = await request(config, SESSIONS_PATH, { method: "POST", body });
      const piecesAdded = Number.isInteger(payload.pieces_added) ? payload.pieces_added : null;
      const state = {
        syncedAt: now().toISOString(),
        lastError: null,
        piecesAdded,
        notSendable: false,
      };
      await store.saveSyncState(noteId, state);
      log.info(
        "Pipeline grill session sent",
        { noteId, status, turns: body.turns.length, piecesAdded },
        LOG_SCOPE
      );
      return state;
    } catch (error) {
      if (error?.code === "NOTE_NOT_FOUND") throw error;
      const failure = { lastError: describeFailure(error) };
      if (NOT_SENDABLE_CODES.has(error?.code)) failure.notSendable = true;
      try {
        await store.saveSyncState(noteId, failure);
      } catch {
        // The row vanished mid-send; there is nothing left to record on.
      }
      log.warn(
        "Pipeline grill session failed",
        { noteId, code: error?.code || "ERROR", status: error?.status ?? null },
        LOG_SCOPE
      );
      throw error;
    }
  }

  // One send at a time per note, whoever asked.
  function sendNote(noteId, capturedConfig = null) {
    const key = String(noteId);
    const prior = noteQueues.get(key) || Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => sendOnce(noteId, capturedConfig || (await requireConfig())));
    noteQueues.set(key, next);
    return next.finally(() => {
      if (noteQueues.get(key) === next) noteQueues.delete(key);
    });
  }

  async function retryPending({ except = null } = {}) {
    const config = await currentConfig();
    if (!config) return { attempted: 0, sent: 0, failed: 0 };
    const ids = ((await store.listPendingNoteIds()) || []).filter(
      (id) => (except == null || String(id) !== String(except)) && !goneNotes.has(String(id))
    );
    let sent = 0;
    for (const id of ids) {
      try {
        await sendNote(id, config);
        sent += 1;
      } catch {
        // A send failure is kept on the note as last_error and retried on the
        // next start or save. A note that no longer resolves (NOTE_NOT_FOUND)
        // was added to goneNotes inside sendNote and is not retried at all.
      }
    }
    const result = { attempted: ids.length, sent, failed: ids.length - sent };
    if (ids.length > 0) log.info("Pipeline retry finished", result, LOG_SCOPE);
    return result;
  }

  function inBackground(work) {
    const task = Promise.resolve()
      .then(work)
      .catch(() => {});
    background.add(task);
    task.finally(() => background.delete(task));
    return task;
  }

  return {
    async getSettings() {
      let settings;
      try {
        settings = normalizePipelineSettings(await store.getSettings());
      } catch {
        settings = { baseUrl: "" };
      }
      const hasToken = Boolean(await store.getToken());
      return { ...settings, hasToken, configured: Boolean(settings.baseUrl && hasToken) };
    },
    async saveSettings(input = {}) {
      const settings = normalizePipelineSettings(input);
      if (Object.hasOwn(input, "token")) await store.saveToken(String(input.token || "").trim());
      await store.saveSettings(settings);
      inBackground(() => retryPending());
      return this.getSettings();
    },
    /** ok, unauthorized, or unreachable, from GET /internal/grill/questions. */
    async testConnection() {
      const config = await requireConfig();
      try {
        const { status } = await request(config, QUESTIONS_PATH);
        log.info("Pipeline test connection", { status }, LOG_SCOPE);
        return { result: "ok", status };
      } catch (error) {
        log.warn(
          "Pipeline test connection failed",
          { code: error?.code || "ERROR", status: error?.status ?? null },
          LOG_SCOPE
        );
        if (error?.code === "UNAUTHORIZED") return { result: "unauthorized", status: error.status };
        if (error?.code === "UNREACHABLE") return { result: "unreachable" };
        throw error;
      }
    },
    async fetchQuestions() {
      const config = await currentConfig();
      if (!config) return { configured: false, questions: [] };
      const { payload, status } = await request(config, QUESTIONS_PATH);
      const questions = (Array.isArray(payload.questions) ? payload.questions : []).flatMap(
        (entry) =>
          typeof entry?.id === "string" &&
          entry.id &&
          typeof entry.question === "string" &&
          entry.question.trim()
            ? [{ id: entry.id, question: entry.question.trim() }]
            : []
      );
      log.info("Pipeline feed questions read", { status, count: questions.length }, LOG_SCOPE);
      return { configured: true, questions };
    },
    sendNote: (noteId) => sendNote(noteId),
    /**
     * A grill note was saved with its turns: record its session meta, then post
     * it (and anything still pending) in the background. Never waits on the post.
     */
    async submitGrillNote(noteId, meta) {
      await store.saveGrillMeta(noteId, meta);
      goneNotes.delete(String(noteId));
      inBackground(async () => {
        const config = await currentConfig();
        if (!config) return;
        await sendNote(noteId, config).catch(() => {});
        await retryPending({ except: noteId });
      });
      return { queued: true };
    },
    retryPending,
    async getSyncState(noteId) {
      return (await store.getSyncState(noteId)) || null;
    },
    /** Resolves once every background send has settled (tests, shutdown). */
    async idle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },
  };
}

module.exports = {
  buildGrillSessionPayload,
  createPipelineConnector,
  isGrillNote,
  normalizePipelineSettings,
  PipelineError,
};
