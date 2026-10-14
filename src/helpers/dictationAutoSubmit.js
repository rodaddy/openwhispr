// Guards for auto-submit: pressing Return after a dictation was pasted
// into a terminal. A wrong Return runs a command, so every condition here is
// required and anything unexpected means "do not submit".

const DEFAULT_MIN_WORDS = 3;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
// Any control character or Unicode line/paragraph separator: a terminal may
// take it as the end of a line, which would submit part of the text early.
const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function countWords(text) {
  if (typeof text !== "string") return 0;
  return text.split(/\s+/).filter((token) => WORD_CHARACTER.test(token)).length;
}

// Exact bundle ids of the terminals auto-submit may press Return in. Only
// terminals checked live are listed. A name match let an app merely
// named like a terminal get a Return.
const AUTO_SUBMIT_TERMINAL_BUNDLE_IDS = Object.freeze([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
]);

function isAutoSubmitTerminal(bundleId) {
  return typeof bundleId === "string" && AUTO_SUBMIT_TERMINAL_BUNDLE_IDS.includes(bundleId);
}

function shouldAutoSubmit({ enabled, bundleId, text, minWords, pasted } = {}) {
  if (enabled !== true) return false;
  if (pasted !== true) return false;
  if (!isAutoSubmitTerminal(bundleId)) return false;
  if (typeof text !== "string") return false;
  if (LINE_BREAKING.test(text)) return false;
  // 2 is the lowest value the setting offers; anything lower is not honored.
  const floor = Number.isInteger(minWords) && minWords >= 2 ? minWords : DEFAULT_MIN_WORDS;
  return countWords(text) >= floor;
}

module.exports = {
  countWords,
  shouldAutoSubmit,
  isAutoSubmitTerminal,
  AUTO_SUBMIT_TERMINAL_BUNDLE_IDS,
  DEFAULT_MIN_WORDS,
};
