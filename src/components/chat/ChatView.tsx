import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useChatPersistence } from "./useChatPersistence";
import { useChatStreaming } from "./useChatStreaming";
import { useChatMessageSender } from "./useChatMessageSender";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { ChatEmptyIllustration } from "./ChatEmptyIllustration";
import ConversationList from "./ConversationList";
import EmptyChatState from "./EmptyChatState";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";
import { useNoteDestinationRequest } from "../../hooks/useNoteDestinationRequest";
import { NoteDestinationDialog } from "./NoteDestinationDialog";
import {
  Flame,
  ListRestart,
  Mic,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { useGrillSession } from "./useGrillSession";
import { GRILL_BANK } from "../../config/grill/questionBank";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAssistantSpeech } from "../../hooks/useAssistantSpeech";
import { AssistantSpeechSetupDialog } from "../dictation/AssistantSpeechSetupDialog";
import { useGrillVoiceLoop } from "./useGrillVoiceLoop";
import logger from "../../utils/logger";
import { resolveGrillVoice } from "../../services/grill/grillVoices";
import {
  GRILL_BACK_TO_SCRIPT_TEXT,
  GRILL_SKIP_TEXT,
  grillMarkTargets,
  grillStartDisabled,
  type GrillSessionRequest,
} from "../../services/grill/grillSession";
import { useGrillMarks, type SavedGrill } from "./useGrillMarks";
import type { GrillLoopNotice, GrillLoopPhase } from "../../services/grill/grillVoiceLoop";
import { routeChatGrillStart } from "../../services/grill/grillStartSubscription";
import type { Message } from "./types";

const CommandSearch = lazy(() => import("../CommandSearch"));

const platform = getCachedPlatform();

function NewChatEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full -mt-6 select-none">
      <ChatEmptyIllustration />
      <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-48 mt-4">
        {t("chat.newChatEmpty")}
      </p>
    </div>
  );
}

const GRILL_CONTROL_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground";

// The listening state shown in grill mode.
const GRILL_PHASE_LABEL: Partial<Record<GrillLoopPhase, string>> = {
  speaking: "chat.grill.voice.speaking",
  listening: "chat.grill.voice.listening",
  transcribing: "chat.grill.voice.transcribing",
  thinking: "chat.grill.voice.thinking",
  paused: "chat.grill.voice.paused",
  waiting: "chat.grill.voice.waiting",
  failed: "chat.grill.voice.failed",
};

interface ChatViewProps {
  /** A grill the calendar asked for (grill:start); started once, then acknowledged. */
  grillStartRequest?: { id: number; request: GrillSessionRequest } | null;
  onGrillStartRequestHandled?: (id: number) => void;
}

export default function ChatView({
  grillStartRequest = null,
  onGrillStartRequestHandled,
}: ChatViewProps = {}) {
  const { t } = useTranslation();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [isNewChat, setIsNewChat] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const noteDestination = useNoteDestinationRequest();
  // Spoken replies share the assistant panel's setting and voice profile, so
  // Skippy sounds the same whichever surface answered.
  const assistantSpeechEnabled = useSettingsStore((state) => state.assistantSpeechEnabled);
  const setAssistantSpeechEnabled = useSettingsStore((state) => state.setAssistantSpeechEnabled);
  const assistantSpeech = useAssistantSpeech(assistantSpeechEnabled, "chat-view");
  const grillVoices = useSettingsStore((state) => state.grillVoices);
  const grillVoiceId = useSettingsStore((state) => state.grillVoiceId);
  const [speechSetupOpen, setSpeechSetupOpen] = useState(false);
  const { toast } = useToast();

  const persistence = useChatPersistence({
    conversationId: activeConversationId,
    onConversationCreated: (id) => {
      setActiveConversationId(id);
      setRefreshKey((k) => k + 1);
    },
  });

  const grillNotify = useMemo(
    () => ({
      saved: () => toast({ title: t("chat.grill.saved") }),
      savedWithoutTurns: () =>
        toast({ title: t("chat.grill.savedWithoutTurns"), variant: "destructive" }),
      failed: (reason: string) =>
        toast({ title: t("chat.grill.notSaved", { reason }), variant: "destructive" }),
    }),
    [t, toast]
  );

  const grill = useGrillSession({
    persistence,
    onBeforeOpen: () => {
      noteDestination.cancel("new-chat");
      assistantSpeech.stop();
      setIsNewChat(false);
    },
    onOpenConversation: setActiveConversationId,
    contextFailedNote: t("chat.grill.contextFailed"),
    feedFailedNote: t("chat.grill.feedFailed"),
    draftPendingNote: t("chat.grill.draftPending"),
    notify: grillNotify,
  });

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    grillSession: grill.session?.spec ?? null,
    onStreamComplete: (id, content, toolCalls) => {
      // The stored row id rides back onto the message so a single turn can be
      // removed later (grill only).
      void persistence.saveAssistantMessage(content, toolCalls, id);
    },
    onDeliverableComplete: async (content, token) => {
      // In a grill the voice loop reads the question in the grill voice; the
      // assistant's spoken replies stay as they were everywhere else.
      if (grillActiveRef.current) {
        grillVoice.question(content);
        return;
      }
      if (assistantSpeechEnabled && typeof token === "number")
        await assistantSpeech.speak(content, token);
    },
    captureDeliverableToken: assistantSpeech.captureGeneration,
    requestNoteDestination: noteDestination.requestNoteDestination,
    cancelNoteDestinationRequest: noteDestination.cancel,
    getNoteDestinationCancellationGeneration: noteDestination.getCancellationGeneration,
  });

  const messagesRef = useRef(persistence.messages);
  messagesRef.current = persistence.messages;
  const grillActiveRef = useRef(false);
  grillActiveRef.current = Boolean(grill.session);

  const addNotice = useCallback(
    (content: string) =>
      persistence.setMessages((messages) => [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          isStreaming: false,
          display: "notice",
        },
      ]),
    [persistence]
  );

  // An instruction for the interviewer only: it reaches the model but not the
  // screen or the saved note. Skip and Back to script both send one.
  const sendHiddenTurn = useCallback(
    async (text: string) => {
      streaming.cancelStream();
      const turn: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        isStreaming: false,
        display: "hidden",
      };
      const history = [...messagesRef.current, turn];
      persistence.setMessages((messages) => [...messages, turn]);
      await persistence.saveUserMessage(text, { display: "hidden" }, turn.id);
      await streaming.sendToAI(text, history);
    },
    [persistence, streaming]
  );

  // Skip: a hidden turn asks the interviewer for the next question.
  const requestNextQuestion = useCallback(() => sendHiddenTurn(GRILL_SKIP_TEXT), [sendHiddenTurn]);

  // Back to script: the interviewer wandered off its questions (stray text read
  // as an answer, a follow-up chain with no end). One hidden turn puts it back
  // on the scripted question it has not asked yet.
  const backToScript = useCallback(
    () => sendHiddenTurn(GRILL_BACK_TO_SCRIPT_TEXT),
    [sendHiddenTurn]
  );

  // Fixing a grill in place: rewrite one of Rico's answers, or drop one bad
  // turn. Both are offered in a grill conversation only.
  const editTurnInPlace = useCallback(
    (id: string, text: string) => {
      void persistence.editMessage(id, text);
    },
    [persistence]
  );

  const removeTurnInPlace = useCallback(
    (id: string) => {
      showConfirmDialog({
        title: t("chat.grill.turn.removeTitle"),
        description: t("chat.grill.turn.removeConfirm"),
        confirmText: t("chat.grill.turn.removeConfirmButton"),
        onConfirm: () => void persistence.deleteMessage(id),
        variant: "destructive",
      });
    },
    [persistence, showConfirmDialog, t]
  );

  const handleSelectConversation = useCallback(
    async (id: number) => {
      if (id === activeConversationId) return;
      // Leaving a grill saves its transcript first (and says so).
      if (grill.session) {
        streaming.cancelStream();
        await grill.leaveGrillSession();
      }
      noteDestination.cancel("conversation-changed");
      assistantSpeech.stop();
      setActiveConversationId(id);
      setIsNewChat(false);
      await persistence.loadConversation(id);
    },
    [activeConversationId, assistantSpeech, grill, noteDestination, persistence, streaming]
  );

  const handleNewChat = useCallback(async () => {
    if (grill.session) {
      streaming.cancelStream();
      await grill.leaveGrillSession();
    }
    noteDestination.cancel("new-chat");
    assistantSpeech.stop();
    setActiveConversationId(null);
    setIsNewChat(true);
    persistence.handleNewChat();
  }, [assistantSpeech, grill, noteDestination, persistence, streaming]);

  // A grill just saved from this view stays on screen, and each of its
  // questions can be marked good, weak or retire against the saved note.
  const [savedGrill, setSavedGrill] = useState<(SavedGrill & { conversationId: number }) | null>(
    null
  );
  const endGrill = useCallback(async () => {
    streaming.cancelStream();
    const plan = grill.session;
    const conversationId = persistence.conversationId;
    const saved = await grill.leaveGrillSession();
    if (plan && conversationId != null && saved?.success) {
      setSavedGrill({
        noteId: saved.id,
        conversationId,
        targets: grillMarkTargets(plan.spec, messagesRef.current),
      });
    }
  }, [grill, persistence.conversationId, streaming]);
  const showingSavedGrill =
    savedGrill && !grill.session && savedGrill.conversationId === persistence.conversationId
      ? savedGrill
      : null;
  const grillMarks = useGrillMarks(showingSavedGrill);

  const grillNoticeText = useCallback(
    (kind: GrillLoopNotice, detail?: string) => {
      const error = detail || t("chat.grill.voice.unknownError");
      if (kind === "speech-failed") return t("chat.grill.voice.speechFailed", { error });
      if (kind === "listen-failed") return t("chat.grill.voice.listenFailed", { error });
      if (kind === "transcription-failed")
        return t("chat.grill.voice.transcriptionFailed", { error });
      if (kind === "answer-skipped") return t("chat.grill.voice.answerSkipped");
      return t("chat.grill.voice.stillThereNotice");
    },
    [t]
  );

  const grillVoice = useGrillVoiceLoop({
    active: Boolean(grill.session),
    voice: resolveGrillVoice(grillVoices, grillVoiceId),
    sendAnswer: async (text) => {
      // A refused or failed send shows the answer; it is never dropped.
      let sent = false;
      try {
        sent = await sendMessage(text);
      } catch (error) {
        logger.warn("Grill answer send failed", { error: (error as Error)?.message }, "grill");
      }
      if (!sent) addNotice(t("chat.grill.voice.answerNotSent", { text }));
    },
    requestNextQuestion,
    endSession: endGrill,
    holdAnswer: grill.holdAnswer,
    lateAnswer: grill.lateAnswer,
    notice: (kind, detail) => {
      // After End or an unmount the chat may be gone: a lost answer is a toast.
      if (kind === "answer-lost") {
        toast({
          title: t("chat.grill.voice.answerLost"),
          description: detail ? t("chat.grill.voice.answerLostPath", { path: detail }) : undefined,
          variant: "destructive",
        });
        return;
      }
      addNotice(grillNoticeText(kind, detail));
    },
    stillThereText: t("chat.grill.voice.stillThere"),
  });

  const startGrill = useCallback(
    async (request: { kind: "daily" | "lifetime"; chapter?: number }) => {
      if (grill.isStarting) return;
      streaming.cancelStream();
      try {
        const plan = await grill.startGrillSession(request);
        grillVoice.question(plan.firstQuestion);
      } catch (error) {
        toast({
          title: t("chat.grill.startFailed"),
          description: error instanceof Error ? error.message : undefined,
          variant: "destructive",
        });
      }
    },
    [grill, grillVoice, streaming, t, toast]
  );

  // A grill the calendar asked for starts like one from the menu; the
  // unsaved-grill refusal still applies.
  const handledGrillStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (!grillStartRequest || handledGrillStartRef.current === grillStartRequest.id) return;
    handledGrillStartRef.current = grillStartRequest.id;
    onGrillStartRequestHandled?.(grillStartRequest.id);
    const running = { session: grill.session, isStarting: grill.isStarting };
    routeChatGrillStart(grillStartRequest.request, running, {
      start: startGrill,
      alreadyRunning: () => toast({ title: t("chat.grill.alreadyRunning") }),
    });
  }, [
    grill.isStarting,
    grill.session,
    grillStartRequest,
    onGrillStartRequestHandled,
    startGrill,
    t,
    toast,
  ]);

  const resumeGrillDraft = useCallback(async () => {
    streaming.cancelStream();
    // A resumed grill carries on from its last question.
    const lastQuestion = grill.pendingDraft?.messages
      .filter((m) => m.role === "assistant" && !m.display && m.content.trim())
      .at(-1)?.content;
    try {
      await grill.resumeDraft();
      if (lastQuestion) grillVoice.question(lastQuestion);
    } catch (error) {
      toast({
        title: t("chat.grill.startFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  }, [grill, grillVoice, streaming, t, toast]);

  const toggleSpeech = useCallback(async () => {
    if (assistantSpeechEnabled) {
      assistantSpeech.stop();
      setAssistantSpeechEnabled(false);
      return;
    }
    try {
      const profile = await window.electronAPI.getAssistantSpeechProfile();
      if (profile.configured) setAssistantSpeechEnabled(true);
      else setSpeechSetupOpen(true);
    } catch (error) {
      assistantSpeech.reportError(
        error instanceof Error ? error.message : "Could not check spoken reply setup"
      );
    }
  }, [assistantSpeech, assistantSpeechEnabled, setAssistantSpeechEnabled]);

  const createConversation = useCallback(
    async (text: string) => {
      const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      return persistence.createConversation(title);
    },
    [persistence]
  );
  const markChatStarted = useCallback(() => setIsNewChat(false), []);
  const resolveNoteDestinationReply = noteDestination.resolveVoiceCommand;
  const sendMessage = useChatMessageSender({
    conversationId: activeConversationId,
    persistence,
    streaming,
    createConversation,
    onBeforeSend: markChatStarted,
  });
  const handleTextSubmit = useCallback(
    async (text: string) => {
      if (resolveNoteDestinationReply(text)) return true;
      // A typed or dictated answer in a grill ends the listen for this question.
      if (grillActiveRef.current) grillVoice.answeredByText();
      return await sendMessage(text);
    },
    [grillVoice, resolveNoteDestinationReply, sendMessage]
  );

  const handleArchive = useCallback(
    async (id: number) => {
      await window.electronAPI?.archiveAgentConversation?.(id);
      if (activeConversationId === id) {
        handleNewChat();
      }
      setRefreshKey((k) => k + 1);
    },
    [activeConversationId, handleNewChat]
  );

  // The chat list's Delete and Discard grill remove a conversation the same way.
  const deleteConversation = useCallback(
    async (id: number) => {
      await window.electronAPI?.deleteAgentConversation?.(id);
      if (activeConversationId === id) {
        handleNewChat();
      }
      setRefreshKey((k) => k + 1);
    },
    [activeConversationId, handleNewChat]
  );

  const handleDelete = useCallback(
    (id: number) => {
      showConfirmDialog({
        title: t("chat.delete"),
        description: t("chat.deleteConfirm"),
        onConfirm: () => void deleteConversation(id),
        variant: "destructive",
      });
    },
    [deleteConversation, showConfirmDialog, t]
  );

  // Throw the grill away: nothing saved, nothing posted, its conversation
  // deleted, back to the empty Chat screen. The voice loop stops because the
  // session going null unmounts it.
  const discardGrill = useCallback(() => {
    showConfirmDialog({
      title: t("chat.grill.voice.discard"),
      description: t("chat.grill.voice.discardConfirm"),
      confirmText: t("chat.grill.voice.discardConfirmButton"),
      onConfirm: () => {
        streaming.cancelStream();
        const conversationId = grill.discardSession();
        assistantSpeech.stop();
        if (conversationId != null) void deleteConversation(conversationId);
        else handleNewChat();
      },
      variant: "destructive",
    });
  }, [assistantSpeech, deleteConversation, grill, handleNewChat, showConfirmDialog, streaming, t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "n") {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewChat]);

  const startDisabled = grillStartDisabled({
    starting: grill.isStarting,
    pendingDraft: grill.pendingDraft,
  });

  // One Start grill menu, shown in the conversation header and on the empty
  // Chat screen, so a grill can start with no conversation open (#60).
  const grillStartMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={grill.isStarting}>
        <button
          type="button"
          disabled={grill.isStarting}
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50"
        >
          <Flame size={14} />
          {t("chat.grill.start")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        {grill.pendingDraft && (
          <DropdownMenuLabel className="px-2.5 py-1.5 text-xs font-normal text-muted-foreground">
            {t("chat.grill.draftPending")}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem
          disabled={startDisabled}
          onClick={() => void startGrill({ kind: "daily" })}
          className="text-xs gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer focus:bg-foreground/5"
        >
          {t("chat.grill.daily")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={startDisabled}
            className="text-xs gap-2 rounded-lg px-2.5 py-1.5"
          >
            {t("chat.grill.lifetime")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-56">
            {GRILL_BANK.chapters.map((chapter) => (
              <DropdownMenuItem
                key={chapter.number}
                disabled={startDisabled}
                onClick={() => void startGrill({ kind: "lifetime", chapter: chapter.number })}
                className="text-xs gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer focus:bg-foreground/5"
              >
                {t("chat.grill.chapter", {
                  number: chapter.number,
                  title: chapter.title,
                })}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const hasActiveChat =
    activeConversationId !== null || persistence.messages.length > 0 || isNewChat;

  return (
    <>
      <NoteDestinationDialog
        key={noteDestination.pending?.id ?? "no-note-destination"}
        pending={noteDestination.pending}
        onResolve={noteDestination.settle}
        onCreateFolder={noteDestination.confirmFolderCreation}
      />
      <AssistantSpeechSetupDialog
        open={speechSetupOpen}
        onOpenChange={setSpeechSetupOpen}
        onConfigured={() => setAssistantSpeechEnabled(true)}
      />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
      {showSearch && (
        <Suspense fallback={null}>
          <CommandSearch
            open={showSearch}
            onOpenChange={setShowSearch}
            mode="conversations"
            onConversationSelect={handleSelectConversation}
          />
        </Suspense>
      )}
      <div className="flex h-full">
        <div className="w-56 min-w-50 shrink-0 border-r border-border/15 dark:border-white/6">
          <ConversationList
            activeConversationId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onNewChat={handleNewChat}
            onOpenSearch={() => setShowSearch(true)}
            onArchive={handleArchive}
            onDelete={handleDelete}
            refreshKey={refreshKey}
          />
        </div>
        <div className="flex-1 min-w-80 flex flex-col">
          {hasActiveChat ? (
            <>
              <div className="flex h-10 shrink-0 items-center justify-end gap-2 px-4">
                {assistantSpeech.error && (
                  <span role="alert" className="truncate text-xs text-destructive">
                    {assistantSpeech.error}
                  </span>
                )}
                {!grill.session && grill.pendingDraft && (
                  <>
                    <span className="truncate text-xs text-muted-foreground">
                      {t("chat.grill.draftFound", {
                        title: grill.pendingDraft.plan.conversationTitle,
                      })}
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-full px-2.5 text-xs text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50"
                      disabled={grill.isSaving}
                      onClick={() => void resumeGrillDraft()}
                    >
                      {t("chat.grill.resumeDraft")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                      disabled={grill.isSaving}
                      onClick={() => void grill.saveDraft()}
                    >
                      {t("chat.grill.saveDraft")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={grill.isSaving}
                      onClick={discardGrill}
                    >
                      <Trash2 size={14} />
                      {t("chat.grill.voice.discard")}
                    </button>
                  </>
                )}
                {grill.session ? (
                  <>
                    <span className="inline-flex h-7 items-center gap-1.5 truncate rounded-full bg-foreground/10 px-2.5 text-xs text-foreground">
                      <Flame size={14} />
                      {grill.session.conversationTitle}
                    </span>
                    {grillVoice.state && GRILL_PHASE_LABEL[grillVoice.state.phase] && (
                      <span
                        role="status"
                        aria-live="polite"
                        className="inline-flex h-7 items-center rounded-full px-2 text-xs font-medium text-foreground"
                      >
                        {t(GRILL_PHASE_LABEL[grillVoice.state.phase] as string)}
                      </span>
                    )}
                    {grillVoice.state?.phase === "failed" && (
                      <button
                        type="button"
                        className={GRILL_CONTROL_CLASS}
                        onClick={grillVoice.retry}
                        title={t("chat.grill.voice.retry")}
                      >
                        <RotateCcw size={14} />
                        {t("chat.grill.voice.retry")}
                      </button>
                    )}
                    {grillVoice.state && (
                      <>
                        <button
                          type="button"
                          className={GRILL_CONTROL_CLASS}
                          onClick={grillVoice.state.paused ? grillVoice.resume : grillVoice.pause}
                        >
                          {grillVoice.state.paused ? <Play size={14} /> : <Pause size={14} />}
                          {t(
                            grillVoice.state.paused
                              ? "chat.grill.voice.resume"
                              : "chat.grill.voice.pause"
                          )}
                        </button>
                        <button
                          type="button"
                          className={GRILL_CONTROL_CLASS}
                          onClick={grillVoice.skip}
                        >
                          <SkipForward size={14} />
                          {t("chat.grill.voice.skip")}
                        </button>
                        <button
                          type="button"
                          className={GRILL_CONTROL_CLASS}
                          title={t("chat.grill.voice.backToScriptHint")}
                          onClick={() => void backToScript()}
                        >
                          <ListRestart size={14} />
                          {t("chat.grill.voice.backToScript")}
                        </button>
                        <button
                          type="button"
                          className={GRILL_CONTROL_CLASS}
                          aria-pressed={grillVoice.state.muted}
                          onClick={() => grillVoice.setMuted(!grillVoice.state?.muted)}
                        >
                          {grillVoice.state.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                          {t("chat.grill.voice.mute")}
                        </button>
                        <button
                          type="button"
                          className={GRILL_CONTROL_CLASS}
                          aria-pressed={grillVoice.state.pushToTalk}
                          title={t("chat.grill.voice.pushToTalkHint")}
                          onClick={() => grillVoice.setPushToTalk(!grillVoice.state?.pushToTalk)}
                        >
                          <Mic size={14} />
                          {t("chat.grill.voice.pushToTalk")}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="inline-flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                      disabled={grill.isSaving}
                      onClick={grillVoice.end}
                    >
                      {t("chat.grill.end")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={grill.isSaving}
                      onClick={discardGrill}
                    >
                      <Trash2 size={14} />
                      {t("chat.grill.voice.discard")}
                    </button>
                  </>
                ) : (
                  grillStartMenu
                )}
                <button
                  type="button"
                  className={
                    "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors " +
                    (assistantSpeechEnabled
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground")
                  }
                  aria-pressed={assistantSpeechEnabled}
                  aria-label={t("chat.spokenReplies")}
                  title={t("chat.spokenReplies")}
                  onClick={() => void toggleSpeech()}
                >
                  <Volume2 size={14} />
                  {t(assistantSpeechEnabled ? "chat.spokenRepliesOn" : "chat.spokenRepliesOff")}
                </button>
              </div>
              <ChatMessages
                messages={persistence.messages}
                emptyState={<NewChatEmptyState />}
                onEditTurn={grill.session ? editTurnInPlace : undefined}
                onRemoveTurn={grill.session ? removeTurnInPlace : undefined}
                grillMarks={
                  showingSavedGrill
                    ? {
                        targets: showingSavedGrill.targets,
                        marks: grillMarks.marks,
                        onChoose: (questionId, choice) =>
                          void grillMarks.choose(questionId, choice),
                        onSaveNote: (questionId, note) =>
                          void grillMarks.saveNote(questionId, note),
                      }
                    : undefined
                }
              />
              <ChatInput
                agentState={streaming.agentState}
                partialTranscript=""
                onTextSubmit={handleTextSubmit}
                onCancel={streaming.cancelStream}
                autoFocus={isNewChat}
                voiceDraft
              />
            </>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex h-10 shrink-0 items-center justify-end gap-2 px-4">
                {grillStartMenu}
              </div>
              <div className="min-h-0 flex-1">
                <EmptyChatState />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
