/**
 * Fixing a grill in place: rewrite one of Rico's answers, or drop one bad turn,
 * without throwing the session away. Pure list operations so the chat, the
 * draft and the saved note all read the same edited turns.
 *
 * A hidden turn (the opening, Skip, Back to script) is never edited or removed
 * here: it is the interviewer's plumbing, not a turn on the screen.
 */
export interface GrillEditableTurn {
  id: string;
  content: string;
  display?: "hidden" | "notice";
}

const editable = <T extends GrillEditableTurn>(messages: T[], id: string): T | undefined => {
  const message = messages.find((m) => m.id === id);
  if (!message || message.display) return undefined;
  return message;
};

/**
 * Rewrites one visible turn. The text is trimmed; an unknown id, a hidden turn,
 * or an empty replacement returns the list unchanged (identity, so a caller can
 * tell nothing happened).
 */
export function editTurn<T extends GrillEditableTurn>(
  messages: T[],
  id: string,
  text: string
): T[] {
  const target = editable(messages, id);
  if (!target) return messages;
  const content = text.trim();
  if (!content || content === target.content) return messages;
  return messages.map((m) => (m === target ? { ...m, content } : m));
}

/**
 * Drops one visible turn. An unknown id or a hidden turn returns the list
 * unchanged.
 */
export function removeTurn<T extends GrillEditableTurn>(messages: T[], id: string): T[] {
  const target = editable(messages, id);
  if (!target) return messages;
  return messages.filter((m) => m !== target);
}
