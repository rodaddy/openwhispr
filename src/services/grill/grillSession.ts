// Grill session planning and transcript saving. Planning and note-building are
// pure; the chat view (useGrillSession) owns opening the chat and persisting.
import { GRILL_BANK, getGrillChapter, type GrillBank } from "../../config/grill/questionBank";
import { GRILL_FEEDBACK_QUESTION, type GrillSessionSpec } from "../../config/prompts/grillPrompt";
import {
  grillTopicQuestion,
  rotateStandardQuestions,
  selectDayQuestions,
  type GrillCalendarEvent,
  type GrillMeetingNote,
  type GrillTopic,
} from "./dailyQuestions";
import type { PipelineFeedQuestion, PipelineGrillMeta } from "../../types/pipeline";
import type { GrillLateAudio } from "./grillVoiceLoop";

// Mirrors src/helpers/grillFolders.js, which seeds these folders.
export const GRILL_FOLDER_NAME = "Grill";
export const LIFE_STORY_FOLDER_NAME = "Life Story";

export type GrillSessionRequest = { kind: "daily" | "lifetime"; chapter?: number };

export interface GrillSessionPlan {
  spec: GrillSessionSpec;
  firstQuestion: string;
  conversationTitle: string;
  /** When the session was planned (ISO); the pipeline's started_at. */
  startedAt?: string;
  /** The "To grill" topics this session plans to ask. */
  grillTopicIds?: string[];
  /** Those topics; at the end only the ones actually asked are marked used. */
  grillTopics?: GrillTopic[];
}

/**
 * The planned topics an assistant turn actually asked (its question, or the
 * topic text, appears in the turn). Only these are marked used; the rest stay
 * pending for a later grill.
 */
export function askedGrillTopicIds(
  topics: GrillTopic[] | undefined,
  messages: GrillChatMessage[]
): string[] {
  const asked = messages
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content.replace(/\s+/g, " "));
  return (topics ?? [])
    .filter((topic) => {
      const question = grillTopicQuestion(topic);
      const text = topic.text.replace(/\s+/g, " ").trim();
      return asked.some((turn) => turn.includes(question) || (text && turn.includes(text)));
    })
    .map((topic) => topic.id);
}

/** At most this many open feed questions are woven into one daily grill. */
export const MAX_FEED_QUESTIONS = 2;

export type GrillFeedQuestion = PipelineFeedQuestion;

export interface GrillDayContext {
  now: Date;
  events?: GrillCalendarEvent[];
  meetingNotes?: GrillMeetingNote[];
  /** The calendar or notes read failed; the session says so before its first question. */
  contextFailed?: boolean;
  /** Open feed questions from the pipeline, asked after the day questions. */
  feedQuestions?: GrillFeedQuestion[];
  /** Pending "To grill" topics, asked first. */
  grillTopics?: GrillTopic[];
}

/**
 * A chat message as grill mode sees it. "hidden" turns go to the model but not
 * the screen (the synthetic start turn); "notice" lines go to the screen but
 * not the model. Neither lands in the saved transcript.
 */
export interface GrillChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  display?: "hidden" | "notice";
}

export interface GrillTurn {
  role: "user" | "assistant";
  text: string;
  /** Set on the interviewer turn that asked a pipeline feed or bank question. */
  questionId?: string;
  /** Set on an interviewer turn that followed up on an earlier tagged question. */
  followUpOf?: string;
}

export interface GrillSessionNote {
  title: string;
  content: string;
  folderName: string;
  noteType: "personal";
  turns: GrillTurn[];
  /** JSON segments in the notes.transcript shape, each also carrying its role. */
  transcript: string;
  /** What the pipeline needs beyond the turns: kind, chapter, and times. */
  pipeline: PipelineGrillMeta;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function sessionTitle(spec: GrillSessionSpec, bank: GrillBank): string {
  if (spec.kind === "daily") return `Grill ${spec.date}`;
  const chapter = getGrillChapter(spec.chapter, bank);
  return `Life Story ch ${chapter.number}: ${chapter.title}`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A day template with every {placeholder} turned into .+, anchored. */
const dayTemplateMatcher = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split(/\{[^}]+\}/)
      .map(escapeRegExp)
      .join(".+")}$`
  );

/**
 * Question text as asked -> its store id, for the questions a spec carries: the
 * rotated standard questions, the chapter's questions, and each day question
 * (matched back to the template it was filled from). Empty when the bank has no
 * ids, so the spec leaves `questionIds` off.
 */
function specQuestionIds(
  bank: GrillBank,
  parts: { standardQuestions?: string[]; dayQuestions?: string[]; chapter?: number }
): Record<string, string> | undefined {
  const ids = bank.ids;
  if (!ids) return undefined;
  const map: Record<string, string> = {};
  for (const [i, question] of bank.standardQuestions.entries()) {
    const id = ids.standard[i];
    if (id && (parts.standardQuestions?.includes(question) ?? false)) map[question] = id;
  }
  if (parts.chapter != null) {
    const chapter = bank.chapters.find((c) => c.number === parts.chapter);
    const chapterIds = ids.chapters[parts.chapter] ?? [];
    for (const [i, question] of (chapter?.questions ?? []).entries()) {
      if (chapterIds[i]) map[question] = chapterIds[i];
    }
  }
  const matchers = bank.dayTemplates.map((t) => dayTemplateMatcher(t.template));
  for (const question of parts.dayQuestions ?? []) {
    const index = matchers.findIndex((matcher) => matcher.test(question));
    const id = index < 0 ? null : ids.dayTemplates[index];
    if (id) map[question] = id;
  }
  return map;
}

export function planGrillSession(
  request: GrillSessionRequest,
  context: GrillDayContext,
  bank: GrillBank = GRILL_BANK
): GrillSessionPlan {
  if (request.kind === "lifetime") {
    if (request.chapter == null) throw new Error("a lifetime grill needs a chapter");
    const chapter = getGrillChapter(request.chapter, bank);
    const questionIds = specQuestionIds(bank, { chapter: chapter.number });
    const spec: GrillSessionSpec = {
      kind: "lifetime",
      chapter: chapter.number,
      ...(bank.ids ? { chapterTitle: chapter.title, chapterQuestions: chapter.questions } : {}),
      ...(questionIds ? { questionIds } : {}),
    };
    return {
      spec,
      firstQuestion: chapter.questions[0],
      conversationTitle: sessionTitle(spec, bank),
      startedAt: context.now.toISOString(),
    };
  }

  const dayQuestions = selectDayQuestions({
    events: context.events ?? [],
    meetingNotes: context.meetingNotes ?? [],
    now: context.now,
    topics: context.grillTopics ?? [],
    bank,
  });
  const grillTopics = (context.grillTopics ?? []).filter((topic) =>
    dayQuestions.includes(grillTopicQuestion(topic))
  );
  const grillTopicIds = grillTopics.map((topic) => topic.id);
  const standardQuestions = rotateStandardQuestions(bank.standardQuestions, context.now);
  const feedQuestions = (context.feedQuestions ?? []).slice(
    0,
    bank.params?.maxFeedQuestions ?? MAX_FEED_QUESTIONS
  );
  const questionIds = specQuestionIds(bank, { standardQuestions, dayQuestions });
  const spec: GrillSessionSpec = {
    kind: "daily",
    date: localDate(context.now),
    dayQuestions,
    standardQuestions,
    ...(feedQuestions.length > 0 ? { feedQuestions } : {}),
    ...(questionIds ? { questionIds } : {}),
  };
  return {
    spec,
    firstQuestion: dayQuestions[0] ?? feedQuestions[0]?.question ?? standardQuestions[0],
    conversationTitle: sessionTitle(spec, bank),
    startedAt: context.now.toISOString(),
    grillTopicIds,
    grillTopics,
  };
}

const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/**
 * Tags the first interviewer turn that asked each feed question (the prompt
 * has the interviewer ask them word for word) with that question's id. A
 * reworded question stays untagged, so the pipeline keeps it open.
 */
function tagFeedQuestions(turns: GrillTurn[], feed: GrillFeedQuestion[]): GrillTurn[] {
  const tagged = turns.map((turn) => ({ ...turn }));
  for (const question of feed) {
    const wanted = comparable(question.question);
    if (!wanted) continue;
    const turn = tagged.find(
      (t) => t.role === "assistant" && !t.questionId && comparable(t.text).includes(wanted)
    );
    if (turn) turn.questionId = question.id;
  }
  return tagged;
}

/**
 * Tags the first untagged interviewer turn that asked each bank question with
 * its store id (same comparable rule as the feed tagging, which runs first).
 */
function tagBankQuestions(turns: GrillTurn[], questionIds: Record<string, string>): GrillTurn[] {
  const tagged = turns.map((turn) => ({ ...turn }));
  for (const [question, id] of Object.entries(questionIds)) {
    const wanted = comparable(question);
    if (!wanted) continue;
    const turn = tagged.find(
      (t) => t.role === "assistant" && !t.questionId && comparable(t.text).includes(wanted)
    );
    if (turn) turn.questionId = id;
  }
  return tagged;
}

/**
 * Tags the first untagged interviewer turn that asked the closing feedback
 * question with the local id "feedback". Runs after the bank
 * tagging and before the follow-up pass, so a follow-up after it chases
 * "feedback". The id stays local: the pipeline sends only "fq-" ids.
 */
export const GRILL_FEEDBACK_QUESTION_ID = "feedback";

function tagFeedbackQuestion(turns: GrillTurn[]): GrillTurn[] {
  const tagged = turns.map((turn) => ({ ...turn }));
  const wanted = comparable(GRILL_FEEDBACK_QUESTION);
  const turn = tagged.find(
    (t) => t.role === "assistant" && !t.questionId && comparable(t.text).includes(wanted)
  );
  if (turn) turn.questionId = GRILL_FEEDBACK_QUESTION_ID;
  return tagged;
}

/**
 * An interviewer turn with no question id of its own, asked after a tagged one,
 * is a follow-up on the most recent tagged question. Turns before any tagged
 * question stay untagged: nothing is chasing them.
 */
function tagFollowUps(turns: GrillTurn[]): GrillTurn[] {
  const tagged = turns.map((turn) => ({ ...turn }));
  let current: string | null = null;
  for (const turn of tagged) {
    if (turn.role !== "assistant") continue;
    if (turn.questionId) current = turn.questionId;
    else if (current) turn.followUpOf = current;
  }
  return tagged;
}

/**
 * The messages that become saved turns, in order: Rico's and the interviewer's
 * visible, non-empty lines. Turn i of a built note is message i of this list,
 * which is how a saved turn is traced back to the chat line it came from.
 */
function spokenMessages<M extends GrillChatMessage>(
  messages: M[]
): Array<M & { role: "user" | "assistant" }> {
  return messages.filter(
    (m): m is M & { role: "user" | "assistant" } =>
      (m.role === "user" || m.role === "assistant") && !m.display && m.content.trim().length > 0
  );
}

export function buildGrillSessionNote(
  spec: GrillSessionSpec,
  messages: GrillChatMessage[],
  now: Date,
  bank: GrillBank = GRILL_BANK,
  options: { startedAt?: string | null } = {}
): GrillSessionNote {
  const spoken: GrillTurn[] = spokenMessages(messages).map((m) => ({
    role: m.role,
    text: m.content.trim(),
  }));
  const withFeed =
    spec.kind === "daily" && spec.feedQuestions?.length
      ? tagFeedQuestions(spoken, spec.feedQuestions)
      : spoken;
  const withBank = spec.questionIds ? tagBankQuestions(withFeed, spec.questionIds) : withFeed;
  const turns = tagFollowUps(tagFeedbackQuestion(withBank));

  return {
    title: sessionTitle(spec, bank),
    content: turns
      .map((turn) => `**${turn.role === "assistant" ? "Q" : "A"}:** ${turn.text}`)
      .join("\n\n"),
    folderName: spec.kind === "daily" ? GRILL_FOLDER_NAME : LIFE_STORY_FOLDER_NAME,
    noteType: "personal",
    turns,
    transcript: JSON.stringify(
      turns.map((turn) =>
        turn.role === "assistant"
          ? {
              role: turn.role,
              text: turn.text,
              source: "system",
              speakerName: "Interviewer",
              ...(turn.questionId ? { question_id: turn.questionId } : {}),
              ...(turn.followUpOf ? { follow_up_of: turn.followUpOf } : {}),
            }
          : { role: turn.role, text: turn.text, source: "mic" }
      )
    ),
    pipeline: {
      kind: spec.kind,
      chapter: spec.kind === "lifetime" ? spec.chapter : null,
      startedAt: options.startedAt ?? null,
      endedAt: now.toISOString(),
    },
  };
}

export interface GrillNotesApi {
  getSpaces?: () => Promise<Array<{ id: number; kind: string }>>;
  getFolders: (spaceId?: number | null) => Promise<
    Array<{
      id: number;
      name: string;
      is_default: number | boolean;
      space_id?: number | null;
      deleted_at?: string | null;
    }>
  >;
  createFolder: (
    name: string,
    spaceId?: number | null
  ) => Promise<{ success: boolean; folder?: { id: number }; error?: string }>;
  saveNote: (
    title: string,
    content: string,
    noteType?: string,
    sourceFile?: string | null,
    audioDuration?: number | null,
    folderId?: number | null
  ) => Promise<{ success: boolean; note?: { id: number } }>;
  updateNote: (
    id: number,
    updates: { transcript?: string | null }
  ) => Promise<{ success: boolean; note?: { id: number }; error?: string }>;
  /** Hands a saved grill to the social-media-pipeline connector (main posts it). */
  pipelineSubmitGrillNote?: (id: number, meta: PipelineGrillMeta) => Promise<unknown>;
  grillTopicsMarkUsed?: (ids: string[]) => Promise<unknown>;
}

/** turnsSaved false: the note exists but its turns (the transcript) could not be stored. */
export type GrillSaveResult =
  { success: true; id: number; turnsSaved: boolean } | { success: false; error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The target folder in the personal space (the space saveNote uses for
// personal notes), created there when it is not visible (deleted, renamed,
// never seeded). A team-space folder of the same name is never used, and the
// note never falls back to Personal or to no folder.
async function resolveGrillFolder(folderName: string, api: GrillNotesApi): Promise<number> {
  const spaces = (await api.getSpaces?.()) ?? [];
  const personal = spaces.find((s) => s.kind === "private");
  if (!personal) throw new Error("the personal space was not found");
  const folders = (await api.getFolders(personal.id)) ?? [];
  const existing = folders.find(
    (f) => f.name === folderName && f.space_id === personal.id && !f.deleted_at
  );
  if (existing) return existing.id;
  const created = await api.createFolder(folderName, personal.id);
  if (!created?.success || created.folder?.id == null) {
    throw new Error(
      `could not create the ${folderName} folder (${created?.error ?? "unknown error"})`
    );
  }
  return created.folder.id;
}

// Fire and forget: main records the meta and posts in the background, and a
// failure stays on the note for a retry. The save never waits on or fails for it.
function handToPipeline(id: number, meta: PipelineGrillMeta, api: GrillNotesApi): void {
  try {
    void Promise.resolve(api.pipelineSubmitGrillNote?.(id, meta)).catch(() => {});
  } catch {
    // Same: the pipeline hand-off never touches the save.
  }
}

export async function saveGrillSessionNote(
  note: GrillSessionNote,
  api: GrillNotesApi
): Promise<GrillSaveResult> {
  try {
    const folderId = await resolveGrillFolder(note.folderName, api);
    const saved = await api.saveNote(note.title, note.content, note.noteType, null, null, folderId);
    if (!saved?.success || !saved.note) return { success: false, error: "the note was not saved" };
    const id = saved.note.id;
    // The note is saved from here on; only its turns can still fail. One retry.
    const storeTurns = async () => {
      try {
        return Boolean((await api.updateNote(id, { transcript: note.transcript }))?.success);
      } catch {
        return false;
      }
    };
    const turnsSaved = (await storeTurns()) || (await storeTurns());
    if (turnsSaved) handToPipeline(id, note.pipeline, api);
    return { success: true, id, turnsSaved };
  } catch (error) {
    return { success: false, error: errorText(error) };
  }
}

export interface GrillSaveNotify {
  /** Shows "Grill saved". */
  saved: () => void;
  /** Shows "Grill saved without its turns; the connector can't send it until you re-save". */
  savedWithoutTurns: () => void;
  /** Shows "Grill not saved: <reason>". */
  failed: (reason: string) => void;
}

/** Saves the transcript and tells the user which way it went, exactly once. */
export async function finishGrillSession(
  note: GrillSessionNote,
  api: GrillNotesApi,
  notify: GrillSaveNotify
): Promise<GrillSaveResult> {
  const result = await saveGrillSessionNote(note, api);
  if ("error" in result) notify.failed(result.error);
  else if (!result.turnsSaved) notify.savedWithoutTurns();
  else notify.saved();
  return result;
}

/**
 * Ends a grill: saves the session note (when it holds an answer), reports the
 * outcome, and only then calls leave. A transcript is never dropped silently.
 */
export async function leaveGrillSession({
  spec,
  messages,
  api,
  notify,
  leave,
  startedAt,
}: {
  spec: GrillSessionSpec;
  messages: GrillChatMessage[];
  api: GrillNotesApi;
  notify: GrillSaveNotify;
  leave?: () => void;
  startedAt?: string | null;
}): Promise<GrillSaveResult | null> {
  const note = buildGrillSessionNote(spec, messages, new Date(), GRILL_BANK, { startedAt });
  const hasAnswer = note.turns.some((turn) => turn.role === "user");
  const result = hasAnswer ? await finishGrillSession(note, api, notify) : null;
  leave?.();
  return result;
}

export interface GrillContextApi {
  grillGetCalendarEvents?: (
    start: string,
    end: string
  ) => Promise<{ success: boolean; events: GrillCalendarEvent[]; error?: string }>;
  getNotes: (noteType?: string | null, limit?: number) => Promise<GrillMeetingNote[]>;
  grillTopicsList?: (
    status?: "pending" | "used"
  ) => Promise<{ success: boolean; topics?: GrillTopic[]; error?: string }>;
}

export interface GrillLog {
  warn: (message: string, meta?: Record<string, unknown>, scope?: string) => unknown;
}

/**
 * Reads today's and yesterday's events and recent meeting notes. Local only.
 * A failed read is logged and flagged so the session can say so.
 */
export async function gatherGrillDayContext(
  api: GrillContextApi,
  now: Date,
  log: GrillLog
): Promise<GrillDayContext> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  let contextFailed = false;
  const fail = (what: string, error: unknown) => {
    contextFailed = true;
    log.warn(`Grill ${what} read failed`, { error: errorText(error) }, "grill");
  };

  const readEvents = async (): Promise<GrillCalendarEvent[]> => {
    if (!api.grillGetCalendarEvents) return [];
    try {
      const result = await api.grillGetCalendarEvents(start, end);
      if (result?.success) return result.events ?? [];
      fail("calendar", result?.error ?? "unsuccessful result");
    } catch (error) {
      fail("calendar", error);
    }
    return [];
  };
  const readNotes = async (): Promise<GrillMeetingNote[]> => {
    try {
      return (await api.getNotes("meeting", 50)) ?? [];
    } catch (error) {
      fail("notes", error);
      return [];
    }
  };

  // A failed topics read is logged only: the grill still runs without them.
  const readTopics = async (): Promise<GrillTopic[]> => {
    if (!api.grillTopicsList) return [];
    try {
      const result = await api.grillTopicsList("pending");
      if (result?.success) {
        return (result.topics ?? []).map(({ id, text, source }) =>
          source ? { id, text, source } : { id, text }
        );
      }
      log.warn(
        "Grill topics read failed",
        { error: result?.error ?? "unsuccessful result" },
        "grill"
      );
    } catch (error) {
      log.warn("Grill topics read failed", { error: errorText(error) }, "grill");
    }
    return [];
  };

  const [events, meetingNotes, grillTopics] = await Promise.all([
    readEvents(),
    readNotes(),
    readTopics(),
  ]);
  return { now, events, meetingNotes, contextFailed, grillTopics };
}

export interface GrillFeedApi {
  pipelineGetQuestions?: () => Promise<
    | { success: true; configured: boolean; questions: GrillFeedQuestion[] }
    | { success: false; error: string; code?: string; status?: number }
  >;
}

/**
 * Reads the pipeline's open feed questions for a daily grill. Unconfigured
 * means none, quietly; unreachable means none, flagged so the session says so.
 * Logged by code and status only.
 */
export async function gatherGrillFeedQuestions(
  api: GrillFeedApi,
  log: GrillLog
): Promise<{ questions: GrillFeedQuestion[]; failed: boolean }> {
  if (!api.pipelineGetQuestions) return { questions: [], failed: false };
  try {
    const result = await api.pipelineGetQuestions();
    if (result && "questions" in result) {
      const questions = (result.questions ?? []).filter(
        (q) => typeof q?.id === "string" && q.id && typeof q.question === "string" && q.question
      );
      return { questions, failed: false };
    }
    log.warn(
      "Grill feed questions read failed",
      {
        code: (result && "code" in result && result.code) || "UNKNOWN",
        status: (result && "status" in result && result.status) || null,
      },
      "grill"
    );
  } catch {
    log.warn("Grill feed questions read failed", { code: "IPC_ERROR" }, "grill");
  }
  return { questions: [], failed: true };
}

/** The synthetic user turn that opens every grill for the model. */
export function grillStartText(spec: GrillSessionSpec): string {
  return spec.kind === "daily"
    ? "Start my daily grill."
    : `Start my lifetime chapter ${spec.chapter} grill.`;
}

/**
 * The opening chat messages: the hidden start turn (so the model's history
 * begins with a user turn), a visible note when the day context could not be
 * read, then the interviewer's first question.
 */
export function buildGrillOpeningMessages(
  plan: GrillSessionPlan,
  {
    contextFailed,
    contextFailedNote,
    feedFailed,
    feedFailedNote,
  }: {
    contextFailed?: boolean;
    contextFailedNote?: string;
    feedFailed?: boolean;
    feedFailedNote?: string;
  }
): GrillChatMessage[] {
  const opening: GrillChatMessage[] = [
    { role: "user", content: grillStartText(plan.spec), display: "hidden" },
  ];
  if (contextFailed && contextFailedNote) {
    opening.push({ role: "assistant", content: contextFailedNote, display: "notice" });
  }
  if (feedFailed && feedFailedNote) {
    opening.push({ role: "assistant", content: feedFailedNote, display: "notice" });
  }
  opening.push({ role: "assistant", content: plan.firstQuestion });
  return opening;
}

const GRILL_HISTORY_WINDOW = 20;

/**
 * The model-facing history for a grill turn: notices dropped, the last
 * GRILL_HISTORY_WINDOW turns, and always a user turn first (the start turn is
 * put back when the window slides past it).
 */
export function buildGrillModelHistory(
  spec: GrillSessionSpec,
  messages: GrillChatMessage[]
): Array<{ role: GrillChatMessage["role"]; content: string }> {
  const recent = messages
    .filter((m) => m.display !== "notice")
    .slice(-GRILL_HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }));
  if (recent[0]?.role === "user") return recent;
  return [{ role: "user", content: grillStartText(spec) }, ...recent];
}

/**
 * Stores grill turns (the opening, or a recovered draft in a fresh conversation).
 * The hidden start turn keeps its flag so a reopened chat hides it.
 */
export async function persistGrillOpening(
  // An id on a turn is the in-memory message it came from, so the stored row's
  // id can be written back onto it and that turn edited or removed on its own.
  opening: Array<GrillChatMessage & { id?: string }>,
  persistence: {
    saveUserMessage: (
      text: string,
      metadata?: Record<string, unknown>,
      localId?: string
    ) => Promise<unknown>;
    saveAssistantMessage: (
      content: string,
      toolCalls?: undefined,
      localId?: string
    ) => Promise<unknown>;
  }
): Promise<void> {
  // The notice is a UI line only; the stored conversation keeps the turns the model sees.
  for (const m of opening) {
    if (m.display === "notice") continue;
    if (m.role === "user") {
      await persistence.saveUserMessage(
        m.content,
        m.display === "hidden" ? { display: "hidden" } : undefined,
        m.id
      );
    } else if (m.role === "assistant") {
      await persistence.saveAssistantMessage(m.content, undefined, m.id);
    }
  }
}

// ---------------------------------------------------------------------------
// The in-progress grill, kept in localStorage after every turn so a crash or a
// closed window never loses it; the next start offers to resume or save it.

export const GRILL_DRAFT_KEY = "grillDraft.v1";

export interface GrillDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface GrillDraft {
  plan: GrillSessionPlan;
  conversationId: number | null;
  messages: GrillChatMessage[];
  updatedAt: string;
}

const draftMessages = (
  messages: Array<GrillChatMessage & { isStreaming?: boolean }>
): GrillChatMessage[] =>
  messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.isStreaming)
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.display ? { display: m.display } : {}),
    }));

function readDraft(storage: GrillDraftStorage | null): GrillDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(GRILL_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as GrillDraft;
    if (!draft?.plan?.spec || !Array.isArray(draft.messages)) return null;
    return draft;
  } catch {
    return null;
  }
}

function writeDraft(storage: GrillDraftStorage | null, draft: GrillDraft): void {
  try {
    storage?.setItem(GRILL_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A full or unavailable storage only loses the crash net, not the session.
  }
}

function clearDraft(storage: GrillDraftStorage | null): void {
  try {
    storage?.removeItem(GRILL_DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

export interface ActiveGrill {
  plan: GrillSessionPlan;
  conversationId: number | null;
}

export interface GrillControllerDeps {
  api: GrillNotesApi;
  notify: GrillSaveNotify;
  storage: GrillDraftStorage | null;
  /** The chat's current messages, read when the session is saved. */
  getMessages: () => GrillChatMessage[];
  onSessionChange: (active: ActiveGrill | null) => void;
  onSavingChange?: (saving: boolean) => void;
  /**
   * The unsaved draft after a save settles (null once it is gone), so the
   * "Unsaved grill" bar comes back right away after a failed save.
   */
  onDraftChange?: (draft: GrillDraft | null) => void;
  /** Diagnostics only; never handed an answer's text. */
  log?: (message: string, meta: Record<string, unknown>) => void;
}

/** begin() refuses while an unsaved draft exists; a draft is never overwritten. */
export type GrillBeginResult = { started: true } | { started: false; reason: "draft-pending" };

export interface GrillController {
  session: () => ActiveGrill | null;
  begin: (
    plan: GrillSessionPlan,
    conversationId: number | null,
    messages: GrillChatMessage[]
  ) => GrillBeginResult;
  /** Persists the in-progress grill; call after every turn. */
  recordTurns: (messages: GrillChatMessage[]) => void;
  /**
   * Saves the session note, reports it, ends grill mode, then runs then.
   * leave, End and the unmount save all come through here and share one
   * in-flight save: a second trigger awaits it and never starts another.
   */
  exit: (then?: () => void) => Promise<GrillSaveResult | null>;
  /** The chat view is going away mid-grill: save first, exactly like leave. */
  unmount: () => Promise<GrillSaveResult | null>;
  /**
   * A spoken answer still transcribing. exit() waits for it first, and a text
   * it resolves to (the loop ended before sending it) is appended to the turns
   * that are saved and kept in the draft. The voice loop bounds the wait.
   */
  holdAnswer: (answer: Promise<string | null>) => void;
  /**
   * An answer that finished transcribing after the save stopped waiting for
   * it. Logged against the saved note by id and length, never by its text.
   * audio: a take orphaned before its audio was saved, so the note could not
   * name the file; its path (or why there is none) is logged instead.
   */
  lateAnswer: (text: string, audio?: GrillLateAudio) => Promise<void>;
  /**
   * Throws the grill away: the draft is cleared, the session forgotten, and
   * NOTHING is saved or posted to the pipeline. Also clears a pending draft
   * with no active session, so a stuck draft can be thrown away unresumed.
   */
  discard: () => void;
  /** A grill left behind by a crash or a closed window, if any. */
  pendingDraft: () => GrillDraft | null;
  /**
   * Makes the pending draft the active session again and returns it. A new
   * conversationId (the draft's conversation was deleted) is written into the draft.
   */
  resumeDraft: (conversationId?: number | null) => GrillDraft | null;
  /** Saves the pending draft as its grill note without resuming it. */
  saveDraft: () => Promise<GrillSaveResult | null>;
}

export function createGrillController(deps: GrillControllerDeps): GrillController {
  let active: ActiveGrill | null = null;
  let inFlight: Promise<GrillSaveResult | null> | null = null;
  const held = new Set<Promise<string | null>>();
  let lastSavedNoteId: number | null = null;

  // Waits for every held answer (including any held meanwhile) and returns
  // the texts the voice loop could not send.
  const collectHeldAnswers = async () => {
    const texts: string[] = [];
    while (held.size > 0) {
      const batch = [...held];
      batch.forEach((answer) => held.delete(answer));
      for (const text of await Promise.all(batch)) if (text) texts.push(text);
    }
    return texts;
  };

  const setActive = (next: ActiveGrill | null) => {
    active = next;
    deps.onSessionChange(next);
  };

  const record = (messages: GrillChatMessage[]) => {
    if (!active) return;
    writeDraft(deps.storage, {
      plan: active.plan,
      conversationId: active.conversationId,
      messages: draftMessages(messages),
      updatedAt: new Date().toISOString(),
    });
  };

  // One save at a time, whoever asked for it.
  const saveOnce = (run: () => Promise<GrillSaveResult | null>) => {
    if (!inFlight) {
      deps.onSavingChange?.(true);
      inFlight = run().finally(() => {
        inFlight = null;
        deps.onSavingChange?.(false);
      });
    }
    return inFlight;
  };

  // A saved note (with or without turns) or nothing to save clears the draft;
  // a failed save keeps it so the transcript can still be recovered.
  const settleDraft = (result: GrillSaveResult | null) => {
    if (result === null || result.success) clearDraft(deps.storage);
    deps.onDraftChange?.(active ? null : readDraft(deps.storage));
  };

  // The session is over with this transcript: its asked topics are used now;
  // unasked ones stay pending. A failed write is logged, not fatal.
  const markAskedTopics = async (plan: GrillSessionPlan, messages: GrillChatMessage[]) => {
    const ids = askedGrillTopicIds(plan.grillTopics, messages);
    if (ids.length === 0 || !deps.api.grillTopicsMarkUsed) return;
    try {
      const result = await deps.api.grillTopicsMarkUsed(ids);
      if (result && typeof result === "object" && "error" in result) {
        deps.log?.("Grill topics mark-used failed", { error: String(result.error) });
      }
    } catch (error) {
      deps.log?.("Grill topics mark-used failed", { error: String(error) });
    }
  };

  const exit = async (then?: () => void) => {
    if (!inFlight && !active) {
      then?.();
      return null;
    }
    const result = await saveOnce(async () => {
      // A late answer names this save's note, never an earlier grill's.
      lastSavedNoteId = null;
      // An answer still transcribing goes into the turns, never dropped.
      const lateAnswers = await collectHeldAnswers();
      const current = active;
      if (!current) return null;
      const messages: GrillChatMessage[] = [
        ...deps.getMessages(),
        ...lateAnswers.map((content) => ({ role: "user" as const, content })),
      ];
      record(messages);
      const saved = await leaveGrillSession({
        spec: current.plan.spec,
        startedAt: current.plan.startedAt,
        messages,
        api: deps.api,
        notify: deps.notify,
        leave: () => setActive(null),
      });
      if (saved?.success) lastSavedNoteId = saved.id;
      await markAskedTopics(current.plan, messages);
      settleDraft(saved);
      return saved;
    });
    then?.();
    return result;
  };

  return {
    session: () => active,
    begin: (plan, conversationId, messages) => {
      if (readDraft(deps.storage)) return { started: false, reason: "draft-pending" };
      held.clear(); // a late answer belongs to the grill it was spoken in
      lastSavedNoteId = null;
      setActive({ plan, conversationId });
      record(messages);
      return { started: true };
    },
    recordTurns: record,
    exit,
    unmount: () => exit(),
    holdAnswer: (answer) => {
      const tracked = answer.catch(() => null);
      held.add(tracked);
      // An answer the loop sent itself (null) needs no waiting for.
      void tracked.then((text) => {
        if (!text) held.delete(tracked);
      });
    },
    lateAnswer: async (text, audio) => {
      // The save it missed may still be writing; its note id comes from there.
      if (inFlight) await inFlight.catch(() => null);
      if (!audio) {
        deps.log?.("Grill answer transcribed after the grill was saved", {
          noteId: lastSavedNoteId,
          chars: text.length,
        });
        return;
      }
      deps.log?.("Grill answer audio settled after the grill was saved", {
        noteId: lastSavedNoteId,
        audioPath: audio.audioPath,
        chars: text.length,
        ...(audio.error ? { error: audio.error } : {}),
      });
    },
    discard: () => {
      // No save, no note, no pipeline post: the turns go and nothing is kept.
      held.clear(); // a held answer belongs to the grill being thrown away
      lastSavedNoteId = null;
      clearDraft(deps.storage);
      if (active) setActive(null);
      deps.onDraftChange?.(null);
    },
    pendingDraft: () => readDraft(deps.storage),
    resumeDraft: (conversationId) => {
      const draft = readDraft(deps.storage);
      if (!draft) return null;
      setActive({ plan: draft.plan, conversationId: conversationId ?? draft.conversationId });
      if (conversationId != null && conversationId !== draft.conversationId) {
        writeDraft(deps.storage, { ...draft, conversationId });
      }
      return draft;
    },
    saveDraft: () =>
      saveOnce(async () => {
        const draft = readDraft(deps.storage);
        if (!draft) return null;
        const note = buildGrillSessionNote(
          draft.plan.spec,
          draft.messages,
          new Date(),
          GRILL_BANK,
          {
            startedAt: draft.plan.startedAt,
          }
        );
        const hasAnswer = note.turns.some((turn) => turn.role === "user");
        const saved = hasAnswer ? await finishGrillSession(note, deps.api, deps.notify) : null;
        await markAskedTopics(draft.plan, draft.messages);
        settleDraft(saved);
        return saved;
      }),
  };
}

// ---------------------------------------------------------------------------
// Starting a grill reads the day context first, which takes a moment. A second
// start in that window (a double click, the calendar prompt) joins the one in
// flight instead of racing it into a false "unsaved grill" refusal.

export interface SingleFlight<T> {
  run: (start: () => Promise<T>) => Promise<T>;
  busy: () => boolean;
}

export function createSingleFlight<T>(onBusyChange?: (busy: boolean) => void): SingleFlight<T> {
  let current: Promise<T> | null = null;
  return {
    busy: () => current !== null,
    run(start) {
      if (current) return current;
      onBusyChange?.(true);
      current = start().finally(() => {
        current = null;
        onBusyChange?.(false);
      });
      return current;
    },
  };
}

/** The Start grill menu is off while a start is in flight or an unsaved grill waits. */
export function grillStartDisabled({
  starting,
  pendingDraft,
}: {
  starting: boolean;
  pendingDraft: unknown;
}): boolean {
  return starting || Boolean(pendingDraft);
}

/**
 * The hidden turn Skip sends: the model reads it, the screen and the saved
 * note never show it. Model-facing, so not translated.
 */
export const GRILL_SKIP_TEXT = "Skip this question. Ask me the next one.";

/**
 * The hidden turn Back to script sends when the interviewer has wandered off
 * its questions (stray text read as an answer, a follow-up chain with no end).
 * Hidden exactly like Skip: the model reads it, the screen and the saved note
 * never show it. Model-facing, so not translated.
 */
export const GRILL_BACK_TO_SCRIPT_TEXT =
  "Go back to the script. Ignore anything in this conversation that was not an answer to your scripted questions, and ask the next scripted question you have not asked yet, word for word.";

// ---------------------------------------------------------------------------
// Per-question marks on a saved grill (D2). Rico tags each
// question good, weak or retire; a retire tag is a vote, never a retirement.

export type GrillMarkValue = "good" | "weak" | "retire";

/**
 * The question id a turn's mark lands on: an interviewer turn's own id, or for
 * a follow-up the question it followed up on (when that question is in the
 * session). Rico's turns and untagged interviewer turns mark nothing.
 *
 * The closing feedback turn ("feedback") is markable like any question: its
 * answers feed post pieces and the idea agent (the author's call), so whether the
 * question itself is good or weak is signal the agent should get.
 */
export function turnMarkTarget(turn: GrillTurn, turns: GrillTurn[]): string | null {
  if (turn.role !== "assistant") return null;
  if (turn.questionId) return turn.questionId;
  const parent = turn.followUpOf;
  if (!parent) return null;
  return turns.some((t) => t.role === "assistant" && t.questionId === parent) ? parent : null;
}

/**
 * Chat message id -> the question id it marks, for a grill saved from those
 * messages with that spec. Built the same way the note's turns were, so the
 * tags match what was saved.
 */
export function grillMarkTargets(
  spec: GrillSessionSpec,
  messages: Array<GrillChatMessage & { id: string }>,
  bank: GrillBank = GRILL_BANK
): Record<string, string> {
  const spoken = spokenMessages(messages);
  const { turns } = buildGrillSessionNote(spec, spoken, new Date(0), bank);
  const targets: Record<string, string> = {};
  turns.forEach((turn, i) => {
    const target = turnMarkTarget(turn, turns);
    if (target && spoken[i]) targets[spoken[i].id] = target;
  });
  return targets;
}

/** Choosing the mark a question already has clears it; any other choice sets it. */
export function nextGrillMark(
  current: GrillMarkValue | null,
  choice: GrillMarkValue
): GrillMarkValue | null {
  return current === choice ? null : choice;
}

export interface GrillMarksApi {
  grillSetMark?: (
    questionId: string,
    noteId: number | null,
    mark: GrillMarkValue,
    note?: string | null
  ) => Promise<{ success: boolean; error?: string }>;
  grillClearMark?: (
    questionId: string,
    noteId: number | null
  ) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Writes one question's mark for a saved note: a mark (with its optional text
 * note) is set, null clears it. Resolves false when the store refused or the
 * bridge is missing, so the caller can put the old mark back.
 */
export async function writeGrillMark(
  api: GrillMarksApi,
  questionId: string,
  noteId: number,
  mark: GrillMarkValue | null,
  note: string | null = null
): Promise<boolean> {
  try {
    const result =
      mark === null
        ? await api.grillClearMark?.(questionId, noteId)
        : await api.grillSetMark?.(questionId, noteId, mark, note);
    return Boolean(result?.success);
  } catch {
    return false;
  }
}
