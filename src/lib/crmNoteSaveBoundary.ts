export interface CrmNoteDraftSnapshot {
  noteId: number;
  title: string;
  content: string;
  enhancedContent: string | null;
}

interface StableCrmNoteDraftOptions {
  getDraft: () => CrmNoteDraftSnapshot | null;
  save: (snapshot: CrmNoteDraftSnapshot) => Promise<{ success: boolean } | null | undefined>;
}

function sameDraft(left: CrmNoteDraftSnapshot, right: CrmNoteDraftSnapshot): boolean {
  return (
    left.noteId === right.noteId &&
    left.title === right.title &&
    left.content === right.content &&
    left.enhancedContent === right.enhancedContent
  );
}

export async function persistStableCrmNoteDraft({
  getDraft,
  save,
}: StableCrmNoteDraftOptions): Promise<void> {
  const initial = getDraft();
  if (!initial) throw new Error("No saved note is available to sync");
  const noteId = initial.noteId;

  let snapshot = initial;
  for (;;) {
    const result = await save(snapshot);
    if (!result?.success) throw new Error("Could not save the latest note before CRM sync");

    const current = getDraft();
    if (!current || current.noteId !== noteId) {
      throw new Error("The active note changed before CRM sync");
    }
    if (sameDraft(snapshot, current)) return;
    snapshot = current;
  }
}
