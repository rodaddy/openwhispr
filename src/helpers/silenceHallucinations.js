// Whisper-family models emit a small set of stock phrases when handed silence
// ("Thank you.", "Thanks for watching!"). They are indistinguishable from a
// real transcript downstream, so they are filtered by exact whole-text match
// only: any additional words mean the user actually said something.

const SILENCE_PHRASES = [
  "thank you",
  "thank you very much",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "you",
  "bye",
  "please subscribe",
  "subtitles by the amara.org community",
  "[blank_audio]",
  "(silence)",
];

const EDGE_NOISE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

const normalize = (value) =>
  value.toLowerCase().replace(EDGE_NOISE, "").replace(/\s+/g, " ").trim();

const NORMALIZED_PHRASES = new Set(SILENCE_PHRASES.map(normalize));

// "you you you" and "thanks for watching thanks for watching" are the same
// hallucination repeated, so a sentence is reduced to its shortest repeating
// unit before it is matched.
const collapseRepeats = (sentence) => {
  const words = sentence.split(" ");
  for (let period = 1; period < words.length; period++) {
    if (words.length % period !== 0) continue;
    let repeats = true;
    for (let i = period; i < words.length && repeats; i++) {
      if (words[i] !== words[i % period]) repeats = false;
    }
    if (repeats) return words.slice(0, period).join(" ");
  }
  return sentence;
};

export const isSilenceHallucination = (text) => {
  if (typeof text !== "string") return true;

  const sentences = text
    // Sentence-final punctuation only: a mid-token dot ("amara.org") is not a
    // sentence break.
    .split(/[.!?…]+(?=\s|$)|[\n\r]+/u)
    .map(normalize)
    .filter(Boolean);

  // Nothing but whitespace or punctuation: nothing to paste either way.
  if (!sentences.length) return true;

  return sentences.every(
    (sentence) =>
      NORMALIZED_PHRASES.has(sentence) || NORMALIZED_PHRASES.has(collapseRepeats(sentence))
  );
};

export default isSilenceHallucination;
