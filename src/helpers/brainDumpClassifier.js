// Brain-dump classifier (#327): the prompt the renderer sends to the app's
// configured model, and the strict parser main runs on the model's reply.
// Pure: no I/O, and parseDecision never throws.

const KINDS = new Set(["note", "grill", "todo"]);
const FALLBACK_DECISION = Object.freeze({ kind: "note", folder: "Inbox", title: "", text: "" });

function buildBrainDumpPrompt(folderNames) {
  const folders = (Array.isArray(folderNames) ? folderNames : [])
    .map((name) => JSON.stringify(String(name)))
    .join(", ");
  return [
    "You sort one of Rico's brain dumps. Choose exactly one kind:",
    '- "note": something to keep. Pick the best folder from this list, exactly as written:',
    `  [${folders}]. If none fits, use "Inbox".`,
    '- "grill": something to think through or decide.',
    '- "todo": an action to do.',
    "Give a short title (3-8 words). Keep the text as Rico wrote it; do not summarise.",
    "Reply with ONLY one JSON object, no prose:",
    '{"kind":"note"|"grill"|"todo","folder":"<folder, note only>","title":"...","text":"..."}',
  ].join("\n");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function parseDecision(raw) {
  try {
    if (typeof raw !== "string") return FALLBACK_DECISION;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const value = JSON.parse((fenced ? fenced[1] : raw).trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) return FALLBACK_DECISION;
    const { kind, folder, title, text } = value;
    if (!KINDS.has(kind) || !nonEmptyString(title) || !nonEmptyString(text)) {
      return FALLBACK_DECISION;
    }
    if (folder !== undefined && folder !== null && typeof folder !== "string") {
      return FALLBACK_DECISION;
    }
    const decision = { kind, title: title.trim(), text };
    if (kind === "note") decision.folder = nonEmptyString(folder) ? folder.trim() : "Inbox";
    return decision;
  } catch {
    return FALLBACK_DECISION;
  }
}

module.exports = { buildBrainDumpPrompt, parseDecision, FALLBACK_DECISION };
