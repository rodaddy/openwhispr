import { cn } from "../lib/utils";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { ChatMessage } from "./ChatMessage";
import type { Message } from "./types";
import type { GrillMarkValue } from "../../services/grill/grillSession";
import type { GrillMarkState } from "./useGrillMarks";

interface ChatMessagesProps {
  messages: Message[];
  emptyState?: React.ReactNode;
  onOpenNote?: (noteId: number) => void;
  /**
   * Grill only: fixing a turn in place. Absent in an ordinary chat, so no
   * message shows an Edit or Remove action there.
   */
  onEditTurn?: (id: string, text: string) => void;
  onRemoveTurn?: (id: string) => void;
  /**
   * Saved grill only: message id -> the question id that line marks (a
   * follow-up marks its parent), the marks so far, and the writers. Absent
   * everywhere else, so no line shows a mark control.
   */
  grillMarks?: {
    targets: Record<string, string>;
    marks: Record<string, GrillMarkState>;
    onChoose: (questionId: string, choice: GrillMarkValue) => void;
    onSaveNote: (questionId: string, note: string) => void;
  };
}

export function ChatMessages({
  messages,
  emptyState,
  onOpenNote,
  onEditTurn,
  onRemoveTurn,
  grillMarks,
}: ChatMessagesProps) {
  // Follow the stream only while the user is at the bottom; scrolling up to
  // re-read must not be yanked back down by the next token.
  const {
    scrollRef,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useStickToBottom<HTMLDivElement>(messages);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className={cn("flex-1 overflow-y-auto agent-chat-scroll", "px-3 py-2")}
    >
      {messages.length === 0 ? (
        (emptyState ?? null)
      ) : (
        <div className="flex flex-col gap-1.5">
          {messages
            .filter((msg) => msg.role !== "tool" && msg.display !== "hidden")
            .map((msg) => {
              const questionId = grillMarks?.targets[msg.id];
              const mark = questionId ? grillMarks?.marks[questionId] : undefined;
              return msg.display === "notice" ? (
                <p key={msg.id} className="px-1 py-0.5 text-xs text-muted-foreground">
                  {msg.content}
                </p>
              ) : (
                <ChatMessage
                  key={msg.id}
                  role={msg.role as "user" | "assistant"}
                  content={msg.content}
                  isStreaming={msg.isStreaming}
                  toolCalls={msg.toolCalls}
                  onOpenNote={onOpenNote}
                  // A turn still streaming is not editable or removable yet.
                  onEdit={
                    onEditTurn && msg.role === "user" && !msg.isStreaming
                      ? (text) => onEditTurn(msg.id, text)
                      : undefined
                  }
                  onRemove={
                    onRemoveTurn && !msg.isStreaming ? () => onRemoveTurn(msg.id) : undefined
                  }
                  markControl={
                    grillMarks && questionId
                      ? {
                          mark: mark?.mark ?? null,
                          note: mark?.note ?? null,
                          onChoose: (choice) => grillMarks.onChoose(questionId, choice),
                          onSaveNote: (note) => grillMarks.onSaveNote(questionId, note),
                        }
                      : undefined
                  }
                />
              );
            })}
        </div>
      )}
    </div>
  );
}
