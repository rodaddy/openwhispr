import { useState, useRef, useCallback, useEffect } from "react";
import type { Message, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";
import type { ConversationKind } from "../../types/electron";
import { editTurn, removeTurn } from "../../services/grill/grillTurnEdits";

interface UseChatPersistenceOptions {
  conversationId?: number | null;
  onConversationCreated?: (id: number, title: string) => void;
}

export interface ChatPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope,
    kind?: ConversationKind
  ) => Promise<number>;
  loadConversation: (id: number) => Promise<void>;
  /**
   * metadata rides on the stored row, e.g. { display: "hidden" } for grill mode's start turn.
   * localId names the in-memory message to write the new row's id onto, so the
   * turn can later be edited or removed on its own. Resolves to that row id.
   */
  saveUserMessage: (
    text: string,
    metadata?: Record<string, unknown>,
    localId?: string
  ) => Promise<number | null>;
  saveAssistantMessage: (
    content: string,
    toolCalls?: ToolCallInfo[],
    localId?: string
  ) => Promise<number | null>;
  /**
   * Rewrites one turn in the list and in the store. A turn with no stored row
   * still changes on screen; nothing is written twice.
   */
  editMessage: (localId: string, text: string) => Promise<void>;
  /** Drops one turn from the list and from the store. */
  deleteMessage: (localId: string) => Promise<void>;
  handleNewChat: () => void;
}

export function useChatPersistence(options: UseChatPersistenceOptions = {}): ChatPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(
    options.conversationId ?? null
  );
  const conversationIdRef = useRef(conversationId);
  // Read by editMessage/deleteMessage: a state updater must stay pure, so the
  // row id behind a turn is looked up here, not inside setMessages.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const createConversation = useCallback(
    async (
      title: string,
      noteId?: number | null,
      scope?: ContainerScope,
      kind: ConversationKind = "chat"
    ): Promise<number> => {
      const conv = await window.electronAPI?.createAgentConversation?.(
        title,
        noteId ?? undefined,
        scope?.spaceId,
        scope?.folderId ?? undefined,
        kind
      );
      if (!conv) {
        throw new Error("Conversation scope is no longer available");
      }
      const id = conv.id;
      conversationIdRef.current = id;
      setConversationId(id);
      options.onConversationCreated?.(id, title);
      return id;
    },
    [options]
  );

  const loadConversation = useCallback(async (id: number) => {
    const conv = await window.electronAPI?.getAgentConversation?.(id);
    if (!conv) {
      // The conversation was deleted elsewhere (e.g. ControlPanel history).
      // Clear the id, or every subsequent save silently no-ops against the
      // tombstoned row and the session is never persisted.
      conversationIdRef.current = null;
      setConversationId(null);
      return;
    }
    conversationIdRef.current = id;
    setConversationId(id);
    setMessages(conv.messages.map(storedMessageToMessage));
  }, []);

  // The stored row's id lands on the in-memory message so a single turn can
  // later be edited or removed by itself.
  const attachStoredId = useCallback((localId: string | undefined, dbId: number | null) => {
    if (!localId || dbId == null) return;
    setMessages((messages) => messages.map((m) => (m.id === localId ? { ...m, dbId } : m)));
  }, []);

  const saveUserMessage = useCallback(
    async (text: string, metadata?: Record<string, unknown>, localId?: string) => {
      if (!conversationIdRef.current) return null;
      const stored = await window.electronAPI?.addAgentMessage?.(
        conversationIdRef.current,
        "user",
        text,
        metadata
      );
      const dbId = stored?.id ?? null;
      attachStoredId(localId, dbId);
      return dbId;
    },
    [attachStoredId]
  );

  const saveAssistantMessage = useCallback(
    async (content: string, toolCalls?: ToolCallInfo[], localId?: string) => {
      if (!conversationIdRef.current) return null;
      const stored = await window.electronAPI?.addAgentMessage?.(
        conversationIdRef.current,
        "assistant",
        content,
        toolCalls?.length ? { toolCalls } : undefined
      );
      const dbId = stored?.id ?? null;
      attachStoredId(localId, dbId);
      return dbId;
    },
    [attachStoredId]
  );

  const editMessage = useCallback(async (localId: string, text: string) => {
    const content = text.trim();
    if (!content) return;
    const target = messagesRef.current.find((m) => m.id === localId);
    if (!target || target.display) return;
    setMessages((messages) => editTurn(messages, localId, content));
    if (target.dbId != null) await window.electronAPI?.updateAgentMessage?.(target.dbId, content);
  }, []);

  const deleteMessage = useCallback(async (localId: string) => {
    const target = messagesRef.current.find((m) => m.id === localId);
    if (!target || target.display) return;
    setMessages((messages) => removeTurn(messages, localId));
    if (target.dbId != null) await window.electronAPI?.deleteAgentMessage?.(target.dbId);
  }, []);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
    setConversationId(null);
  }, []);

  return {
    messages,
    setMessages,
    conversationId,
    createConversation,
    loadConversation,
    saveUserMessage,
    saveAssistantMessage,
    editMessage,
    deleteMessage,
    handleNewChat,
  };
}

/**
 * A stored agent message as the chat shows it. Tool calls and the grill-mode
 * display flag ("hidden" start turn, "notice" line) come back from metadata.
 */
export function storedMessageToMessage(m: {
  id?: number;
  role: string;
  content: string;
  metadata?: string | null;
}): Message {
  const parsed = m.metadata ? tryParseMetadata(m.metadata) : undefined;
  const toolCalls = parsed?.toolCalls as ToolCallInfo[] | undefined;
  const display =
    parsed?.display === "hidden" || parsed?.display === "notice" ? parsed.display : undefined;
  return {
    id: crypto.randomUUID(),
    ...(typeof m.id === "number" ? { dbId: m.id } : {}),
    role: m.role as Message["role"],
    content: m.content,
    isStreaming: false,
    ...(toolCalls ? { toolCalls } : {}),
    ...(display ? { display } : {}),
  };
}

function tryParseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
