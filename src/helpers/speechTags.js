// Non-verbal tags OmniVoice performs instead of reading (rtech-whisper#635).
// ESM named exports with no imports, like the other helpers the renderer
// loads through Vite; main-process CJS callers use Node's require(esm).

// The 13 names in upstream omnivoice/models/omnivoice.py (_NONVERBAL_PATTERN).
export const SPEECH_TAGS = Object.freeze([
  "laughter",
  "sigh",
  "confirmation-en",
  "question-en",
  "question-ah",
  "question-oh",
  "question-ei",
  "question-yi",
  "surprise-ah",
  "surprise-oh",
  "surprise-wa",
  "surprise-yo",
  "dissatisfaction-hnn",
]);

// A bracket immediately followed by "(" is a markdown link's text, not a tag.
const KNOWN = `\\[(?:${SPEECH_TAGS.join("|")})\\](?!\\()`;
const PAUSE = "\\[pause[^\\]\\n]*\\](?!\\()";
// A lowercase bracketed word that is not a known tag, not a markdown link's
// text and not attached to a word (arr[i]). Uppercase content ([B EY1 S],
// OmniVoice's inline pronunciation syntax) never matches.
const UNKNOWN = `(?<![A-Za-z0-9_])(?!${KNOWN})\\[[a-z][a-z0-9 _:.\\-]{0,30}\\](?!\\()`;

// A run of removable tags together with the spaces around it, so the gap is
// tidied where the tag was and nowhere else.
const runOf = (tag) => new RegExp(`[ \\t]*(?:(?:${tag})[ \\t]*)+`, "g");
const SHOWN_RUN = runOf(`${KNOWN}|${PAUSE}`);
const SPOKEN_RUN = runOf(`${PAUSE}|${UNKNOWN}`);

function removeRuns(text, pattern) {
  return text.replace(pattern, (run, offset) => {
    const before = text[offset - 1];
    const after = text[offset + run.length];
    if (before === undefined || before === "\n") return "";
    if (after === undefined || after === "\n" || ".,!?;:".includes(after)) return "";
    return /^[ \t]|[ \t]$/.test(run) ? " " : "";
  });
}

// A trailing "[" with no "]" yet, when it could still become a tag.
function dropUnfinishedTag(text) {
  const start = text.lastIndexOf("[");
  if (start === -1) return text;
  const tail = text.slice(start);
  if (tail.includes("]") || tail.includes("\n")) return text;
  const unfinished =
    "[pause".startsWith(tail) ||
    tail.startsWith("[pause") ||
    SPEECH_TAGS.some((name) => `[${name}]`.startsWith(tail));
  return unfinished ? text.slice(0, start) : text;
}

// Text that is shown, saved, copied or pasted: no known tag, no pause tag.
export function stripSpeechTags(text, { streaming = false } = {}) {
  if (typeof text !== "string") return "";
  return removeRuns(streaming ? dropUnfinishedTag(text) : text, SHOWN_RUN);
}

// Text sent to OmniVoice: known tags stay, pauses and unknown tags go.
export function sanitizeForSpeech(text) {
  if (typeof text !== "string") return "";
  return removeRuns(text, SPOKEN_RUN);
}
