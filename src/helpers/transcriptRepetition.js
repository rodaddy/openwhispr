const normalize = (sentence) =>
  sentence
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Collapse runs of the same sentence repeated back to back, which
 * self-hosted Whisper emits when it loops on silence. Non-adjacent
 * repeats are left alone.
 */
function collapseRepeatedSentences(text) {
  if (typeof text !== "string" || !text.trim()) return text;
  const sentences = text.match(/[^.!?]*[.!?]+|[^.!?]+$/gu);
  if (!sentences || sentences.length < 2) return text;

  const kept = [];
  let previous = null;
  for (const sentence of sentences) {
    const key = normalize(sentence);
    if (key && key === previous) continue;
    if (key) previous = key;
    kept.push(sentence);
  }
  return kept.join("").trim();
}

module.exports = { collapseRepeatedSentences };
