export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: "executing" | "completed" | "error";
  result?: string;
  // Single object for note tools; search_notes attaches its result array.
  metadata?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface Message {
  id: string;
  /**
   * The agent_messages row this turn was stored as, once it has been. Editing
   * or removing a single turn needs it; a turn that never reached the store
   * (a notice, a message saved before the id came back) simply has none.
   */
  dbId?: number;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
  /** Grill mode: "hidden" reaches the model but not the screen; "notice" the reverse. */
  display?: "hidden" | "notice";
}

export type AgentState =
  "idle" | "listening" | "transcribing" | "thinking" | "streaming" | "tool-executing";

/** Screenshot riding along with a voice command (base64 without a data-URL prefix). */
export interface ChatImageAttachment {
  image: string;
  mediaType: string;
}

export { toolIcons } from "./toolIcons";
