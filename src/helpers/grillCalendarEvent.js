// A calendar block whose title starts with a grill prefix ("Grill",
// "Life Story 3") prompts a grill session instead of a meeting recording.
const DEFAULT_GRILL_EVENT_PREFIXES = Object.freeze(["Grill", "Life Story"]);

// The lifetime prefix is fixed; every other configured prefix is a daily grill.
const LIFETIME_PREFIX = "life story";

// "Life Story 3", "Life Story: ch 3", "Life Story #3". A number later in the
// title ("Life Story: 1985") is not a chapter.
const CHAPTER_PATTERN = /^[\s:#\-–—]*(?:ch(?:apter)?\.?\s*)?#?\s*(\d{1,3})(?!\d)/i;

function normalizeGrillEventPrefixes(value) {
  if (!Array.isArray(value)) return [...DEFAULT_GRILL_EVENT_PREFIXES];
  return value
    .filter((prefix) => typeof prefix === "string")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

// The prefix must end at a word boundary so "Grilled cheese" is not a grill.
function matchPrefix(summary, prefixes) {
  const lower = summary.toLowerCase();
  let best = null;
  for (const prefix of prefixes) {
    const candidate = prefix.toLowerCase();
    if (!lower.startsWith(candidate)) continue;
    if (/\p{L}/u.test(summary.charAt(candidate.length))) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best;
}

// Returns { kind: "daily" | "lifetime", chapter: number | null } or null.
function parseGrillEvent(event, prefixes = DEFAULT_GRILL_EVENT_PREFIXES) {
  const summary = typeof event?.summary === "string" ? event.summary.trim() : "";
  if (!summary) return null;
  const prefix = matchPrefix(summary, normalizeGrillEventPrefixes(prefixes));
  if (!prefix) return null;
  if (prefix !== LIFETIME_PREFIX) return { kind: "daily", chapter: null };
  const match = CHAPTER_PATTERN.exec(summary.slice(prefix.length));
  const chapter = match ? Number(match[1]) : null;
  return { kind: "lifetime", chapter: chapter > 0 ? chapter : null };
}

module.exports = {
  DEFAULT_GRILL_EVENT_PREFIXES,
  normalizeGrillEventPrefixes,
  parseGrillEvent,
};
