import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatPersistence } from "./useChatPersistence";
import type { Message } from "./types";
import logger from "../../utils/logger";
import type { GrillLateAudio } from "../../services/grill/grillVoiceLoop";
import {
  buildGrillOpeningMessages,
  createGrillController,
  createSingleFlight,
  gatherGrillDayContext,
  gatherGrillFeedQuestions,
  persistGrillOpening,
  planGrillSession,
  type GrillChatMessage,
  type GrillController,
  type GrillDayContext,
  type GrillDraft,
  type GrillFeedQuestion,
  type GrillSaveNotify,
  type GrillSaveResult,
  type GrillSessionPlan,
  type GrillSessionRequest,
} from "../../services/grill/grillSession";
import { loadGrillBank } from "../../services/grill/grillBankStore";

interface UseGrillSessionOptions {
  persistence: ChatPersistence;
  /** Resets the surrounding chat view before the session's conversation opens. */
  onBeforeOpen?: () => void;
  /** Selects an existing conversation in the surrounding view (resuming a draft). */
  onOpenConversation?: (id: number) => void;
  /** The visible one-line note shown when the calendar or notes could not be read. */
  contextFailedNote: string;
  /** The visible one-line note shown when the pipeline's feed questions could not be read. */
  feedFailedNote: string;
  /** Why a new grill is refused while an unsaved one waits ("Resume or save ..."). */
  draftPendingNote: string;
  /** Shows "Grill saved" / "Grill saved without its turns" / "Grill not saved: <reason>". */
  notify: GrillSaveNotify;
}

export interface GrillSessionControls {
  session: GrillSessionPlan | null;
  isSaving: boolean;
  /** A start is reading the day context; the Start grill menu is off meanwhile. */
  isStarting: boolean;
  /** A grill left unsaved by a crash or a closed window, offered on the next start. */
  pendingDraft: GrillDraft | null;
  startGrillSession: (request: GrillSessionRequest) => Promise<GrillSessionPlan>;
  /**
   * Saves the transcript (reporting the outcome), leaves grill mode, then runs
   * leave. Every way out of a grill goes through here and shares one in-flight
   * save. Resolves null when there was nothing to save.
   */
  leaveGrillSession: (leave?: () => void) => Promise<GrillSaveResult | null>;
  resumeDraft: () => Promise<void>;
  /**
   * Throws the grill (or a pending draft) away: nothing is saved and nothing
   * is posted to the pipeline. Returns the conversation it was in, if any, so
   * the caller can delete it.
   */
  discardSession: () => number | null;
  /** A spoken answer still transcribing; End and the unmount save wait for it. */
  holdAnswer: (answer: Promise<string | null>) => void;
  /**
   * An answer transcribed after the save stopped waiting; logged by note id and
   * length, plus the kept audio path when the note could not name it.
   */
  lateAnswer: (text: string, audio?: GrillLateAudio) => Promise<void>;
  saveDraft: () => Promise<GrillSaveResult | null>;
}

const toChatMessages = (messages: GrillChatMessage[]): Message[] =>
  messages.map((m) => ({ id: crypto.randomUUID(), isStreaming: false, ...m }));

function draftStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function useGrillSession({
  persistence,
  onBeforeOpen,
  onOpenConversation,
  contextFailedNote,
  feedFailedNote,
  draftPendingNote,
  notify,
}: UseGrillSessionOptions): GrillSessionControls {
  const [session, setSession] = useState<GrillSessionPlan | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const startFlightRef = useRef<ReturnType<typeof createSingleFlight<GrillSessionPlan>> | null>(
    null
  );
  if (!startFlightRef.current) startFlightRef.current = createSingleFlight(setIsStarting);
  const startFlight = startFlightRef.current;
  const [pendingDraft, setPendingDraft] = useState<GrillDraft | null>(null);
  const messagesRef = useRef<Message[]>(persistence.messages);
  messagesRef.current = persistence.messages;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const controllerRef = useRef<GrillController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createGrillController({
      api: window.electronAPI,
      notify: {
        saved: () => notifyRef.current.saved(),
        savedWithoutTurns: () => notifyRef.current.savedWithoutTurns(),
        failed: (reason) => notifyRef.current.failed(reason),
      },
      storage: draftStorage(),
      getMessages: () => messagesRef.current,
      onSessionChange: (active) => setSession(active?.plan ?? null),
      onSavingChange: setIsSaving,
      // After every save settles: a failed one brings the "Unsaved grill" bar back.
      onDraftChange: setPendingDraft,
      log: (message, meta) => logger.info(message, meta, "grill"),
    });
  }
  const controller = controllerRef.current;

  // On start: offer any grill a crash or a closed window left behind. On
  // unmount (a view change, the window closing): save the active grill first.
  useEffect(() => {
    if (!controller.session()) setPendingDraft(controller.pendingDraft());
    return () => {
      void controller.unmount();
    };
  }, [controller]);

  // Persist the in-progress grill after every completed turn.
  useEffect(() => {
    if (!session) return;
    if (persistence.messages.some((m) => m.isStreaming)) return;
    controller.recordTurns(persistence.messages);
  }, [controller, persistence.messages, session]);

  // Opens a new conversation in grill mode and has the interviewer ask the
  // first question. Daily sessions read today's and yesterday's calendar and
  // the last 24 hours of meeting notes, locally, to pick the day questions.
  // The model's history opens on a hidden "Start my ... grill." user turn.
  // A second start while one is in flight (a double click, the calendar
  // prompt) joins it rather than racing it into a false "unsaved grill".
  const startGrillSession = useCallback(
    (request: GrillSessionRequest) =>
      startFlight.run(async () => {
        // An unsaved grill is resumed or saved first; a new one never overwrites it.
        const refuse = () => {
          setPendingDraft(controller.pendingDraft());
          return new Error(draftPendingNote);
        };
        if (controller.pendingDraft()) throw refuse();
        const now = new Date();
        // Daily sessions also read the pipeline's open feed questions; an
        // unreachable pipeline starts without them and says so in one line.
        const [context, feed, bank] =
          request.kind === "daily"
            ? await Promise.all([
                gatherGrillDayContext(window.electronAPI, now, logger),
                gatherGrillFeedQuestions(window.electronAPI, logger),
                loadGrillBank(window.electronAPI),
              ])
            : await Promise.all([
                Promise.resolve<GrillDayContext>({ now }),
                Promise.resolve({ questions: [] as GrillFeedQuestion[], failed: false }),
                loadGrillBank(window.electronAPI),
              ]);
        const plan = planGrillSession(request, { ...context, feedQuestions: feed.questions }, bank);
        const opening = buildGrillOpeningMessages(plan, {
          contextFailed: "contextFailed" in context ? context.contextFailed : false,
          contextFailedNote,
          feedFailed: feed.failed,
          feedFailedNote,
        });

        // Checked again: a draft may have appeared while the day context was read.
        if (controller.pendingDraft()) throw refuse();
        onBeforeOpen?.();
        persistence.handleNewChat();
        const conversationId = await persistence.createConversation(
          plan.conversationTitle,
          null,
          undefined,
          "grill"
        );
        const openingMessages = toChatMessages(opening);
        persistence.setMessages(openingMessages);
        await persistGrillOpening(openingMessages, persistence);
        if (!controller.begin(plan, conversationId, opening).started) throw refuse();
        setPendingDraft(null);
        return plan;
      }),
    [
      contextFailedNote,
      controller,
      draftPendingNote,
      feedFailedNote,
      onBeforeOpen,
      persistence,
      startFlight,
    ]
  );

  const leave = useCallback((then?: () => void) => controller.exit(then), [controller]);

  // Reopens the draft's conversation (or a fresh one if it was deleted) with
  // the draft's turns, and carries on in grill mode.
  const resumeDraft = useCallback(async () => {
    const draft = controller.pendingDraft();
    setPendingDraft(null);
    if (!draft) return;
    onBeforeOpen?.();
    const existing =
      draft.conversationId != null
        ? await window.electronAPI?.getAgentConversation?.(draft.conversationId)
        : null;
    if (existing && draft.conversationId != null) {
      onOpenConversation?.(draft.conversationId);
      await persistence.loadConversation(draft.conversationId);
      persistence.setMessages(toChatMessages(draft.messages));
      controller.resumeDraft();
    } else {
      persistence.handleNewChat();
      const id = await persistence.createConversation(
        draft.plan.conversationTitle,
        null,
        undefined,
        "grill"
      );
      const resumed = toChatMessages(draft.messages);
      persistence.setMessages(resumed);
      await persistGrillOpening(resumed, persistence);
      controller.resumeDraft(id);
    }
  }, [controller, onBeforeOpen, onOpenConversation, persistence]);

  // Nothing from the grill is kept: no note, no pipeline post, no draft. The
  // voice loop stops because the session going null unmounts it.
  const discardSession = useCallback(() => {
    const conversationId =
      controller.session()?.conversationId ?? controller.pendingDraft()?.conversationId ?? null;
    controller.discard();
    setPendingDraft(null);
    return conversationId;
  }, [controller]);

  const saveDraft = useCallback(async () => {
    const result = await controller.saveDraft();
    setPendingDraft(controller.session() ? null : controller.pendingDraft());
    return result;
  }, [controller]);

  return {
    session,
    isSaving,
    isStarting,
    pendingDraft,
    startGrillSession,
    leaveGrillSession: leave,
    resumeDraft,
    discardSession,
    holdAnswer: controller.holdAnswer,
    lateAnswer: controller.lateAnswer,
    saveDraft,
  };
}
