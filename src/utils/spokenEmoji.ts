import emojiData from "../data/spokenEmoji.en.json";

interface EmojiRow {
  /** The emoji character. */
  e: string;
  /** CLDR English label, e.g. "upside-down face". */
  l: string;
  /** CLDR tags, e.g. ["face", "hehe", "smile"]. */
  t?: string[];
}

/** At most this many words before the spoken word "emoji" can form a name. */
const MAX_NAME_WORDS = 5;

// Dictation writes what was said, not the CLDR label: people say "smiley"
// where the label says "face", and "thumb up" where it says "thumbs up".
const SYNONYMS: Record<string, string> = {
  smiley: "face",
  smilie: "face",
  smily: "face",
  emoticon: "face",
  thumb: "thumbs",
};

/** Lowercase, hyphens/underscores to spaces, drop other punctuation, collapse. */
function normalize(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SYNONYMS[word] ?? word)
    .join(" ");
}

interface IndexedRow {
  emoji: string;
  /** Words of the normalized label, e.g. ["upside", "down", "face"]. */
  labelWords: Set<string>;
  /** Label words plus every word of every tag. */
  allWords: Set<string>;
}

interface EmojiIndex {
  /** Normalized label -> emoji. First entry in the data wins a tie. */
  byLabel: Map<string, string>;
  /** Label or tag with spaces removed ("eyeroll", "facepalm") -> emoji. */
  byJoined: Map<string, string>;
  /** Every row in data order, for word-subset matching. */
  rows: IndexedRow[];
  /** "person X" emoji -> "man X" emoji, where both exist. */
  manVariant: Map<string, string>;
}

// Quick names checked before the data, so the everyday short word gets the
// everyday emoji instead of whichever row the keyword search ranks first
// ("heart" -> red heart, not smiling face with hearts). Keys are normalized.
const QUICK_NAMES: Record<string, string> = {
  heart: "❤️",
  "red heart": "❤️",
  love: "😍",
  kiss: "😘",
  laughing: "😂",
  laugh: "😂",
  lol: "😂",
  joy: "😂",
  rofl: "🤣",
  crying: "😢",
  cry: "😢",
  sad: "😢",
  sob: "😭",
  smile: "😊",
  happy: "😊",
  grin: "😁",
  wink: "😉",
  angry: "😠",
  mad: "😡",
  cool: "😎",
  ok: "👌",
  okay: "👌",
  "thumbs up": "👍",
  "thumbs down": "👎",
  clap: "👏",
  pray: "🙏",
  "praying hands": "🙏",
  fire: "🔥",
  eyes: "👀",
  "eye roll": "🙄",
  shrug: "🤷‍♂️",
  facepalm: "🤦‍♂️",
  "face palm": "🤦‍♂️",
  thinking: "🤔",
  think: "🤔",
  skull: "💀",
  dead: "💀",
  check: "✅",
  "check mark": "✅",
  x: "❌",
  rocket: "🚀",
  "100": "💯",
  hundred: "💯",
  party: "🥳",
  tada: "🎉",
  celebrate: "🎉",
  money: "💰",
  poop: "💩",
  "sweat smile": "😅",
  grimace: "😬",
  sleepy: "😴",
  sick: "🤢",
  puke: "🤮",
  "mind blown": "🤯",
  scream: "😱",
  hug: "🤗",
  salute: "🫡",
  nerd: "🤓",
  clown: "🤡",
  devil: "😈",
  ghost: "👻",
  robot: "🤖",
  muscle: "💪",
  flex: "💪",
  wave: "👋",
  "upside down": "🙃",
  "upside down face": "🙃",
};

// A name never ends in one of these, so ordinary sentences that mention the
// word "emoji" ("I love this emoji thing", "we only get one emoji") stay as
// spoken instead of turning a filler word into a keyword match.
const NOT_A_NAME = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "one",
  "ones",
  "two",
  "new",
  "old",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "its",
  "it",
  "i",
  "we",
  "you",
  "they",
  "me",
  "us",
  "them",
  "some",
  "any",
  "every",
  "each",
  "no",
  "same",
  "other",
  "another",
  "only",
  "just",
  "get",
  "got",
  "use",
  "used",
  "using",
  "send",
  "sent",
  "add",
  "added",
  "type",
  "typed",
  "say",
  "said",
  "which",
  "what",
  "whatever",
  "favorite",
  "favourite",
  "common",
  "most",
  "first",
  "last",
  "next",
  "right",
  "wrong",
  "that's",
  "thats",
  "is",
  "was",
  "be",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "and",
  "or",
  "but",
  "so",
  "like",
]);

// Rico, 2026-09-29: "shrug emoji means man shrugging for me". A person emoji
// that has gendered variants resolves to the man variant unless the spoken
// name says "person" or "woman".
const KEEP_PERSON_WORDS = new Set(["person", "woman", "women", "people"]);

let cachedIndex: EmojiIndex | null = null;

function getIndex(): EmojiIndex {
  if (cachedIndex) return cachedIndex;
  const byLabel = new Map<string, string>();
  const byJoined = new Map<string, string>();
  const rows: IndexedRow[] = [];
  for (const row of emojiData as EmojiRow[]) {
    const label = normalize(row.l);
    if (!label) continue;
    if (!byLabel.has(label)) byLabel.set(label, row.e);
    const labelWords = label.split(" ");
    const allWords = new Set(labelWords);
    for (const phrase of [label, ...(row.t ?? []).map(normalize)]) {
      const joined = phrase.replace(/ /g, "");
      if (joined && !byJoined.has(joined)) byJoined.set(joined, row.e);
      for (const word of phrase.split(" ")) if (word) allWords.add(word);
    }
    rows.push({ emoji: row.e, labelWords: new Set(labelWords), allWords });
  }
  const manVariant = new Map<string, string>();
  for (const [label, emoji] of byLabel) {
    if (!label.startsWith("person ")) continue;
    const man = byLabel.get(`man ${label.slice("person ".length)}`);
    if (man) manVariant.set(emoji, man);
  }
  cachedIndex = { byLabel, byJoined, rows, manVariant };
  return cachedIndex;
}

function preferMan(emoji: string, words: string[]): string {
  if (words.some((word) => KEEP_PERSON_WORDS.has(word))) return emoji;
  return getIndex().manVariant.get(emoji) ?? emoji;
}

/**
 * Resolve a spoken name, most specific rule first:
 * 1. the exact label ("red heart");
 * 2. the words run together equal a label or tag ("eye roll" -> "eyeroll");
 * 3. every spoken word is in one emoji's label or tags ("shrug", "upside down").
 *    Rows whose label holds all the words win, then shorter labels, then data
 *    order, which puts the base emoji ahead of its gendered variants.
 */
function lookup(candidate: string): string | null {
  const normalized = normalize(candidate);
  if (!normalized) return null;
  const { byLabel, byJoined, rows } = getIndex();
  const words = normalized.split(" ");
  // A filler word at either end is sentence, not name: "a fire" must leave the
  // "a" alone and let the shorter candidate "fire" match.
  if (NOT_A_NAME.has(words[0]) || NOT_A_NAME.has(words[words.length - 1])) return null;
  const quick = QUICK_NAMES[normalized];
  if (quick) return quick;
  const exact = byLabel.get(normalized) ?? byJoined.get(normalized.replace(/ /g, ""));
  if (exact) return preferMan(exact, words);

  let best: { emoji: string; score: [number, number] } | null = null;
  for (const row of rows) {
    if (!words.every((word) => row.allWords.has(word))) continue;
    const inLabel = words.every((word) => row.labelWords.has(word)) ? 0 : 1;
    const score: [number, number] = [inLabel, row.labelWords.size];
    if (
      !best ||
      score[0] < best.score[0] ||
      (score[0] === best.score[0] && score[1] < best.score[1])
    ) {
      best = { emoji: row.emoji, score };
    }
  }
  if (best) return preferMan(best.emoji, words);
  return fuzzyLookup(normalized, words);
}

/**
 * Edit distance where a swap of two neighbouring letters counts as one edit
 * ("unicron" -> "unicorn"), bailing out once it exceeds `max`.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
      }
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Last resort for a misheard name ("scrug" for "shrug"): the closest quick
 * name first, so Rico's preferred pick wins, then the closest label or tag.
 * One edit allowed from 4 letters, two from 8; names of 1-2 words only.
 */
function fuzzyLookup(normalized: string, words: string[]): string | null {
  const joined = normalized.replace(/ /g, "");
  if (words.length > 2 || joined.length < 4) return null;
  const max = joined.length >= 8 ? 2 : 1;
  const closest = (keys: Iterable<[string, string]>): string | null => {
    let found: { emoji: string; distance: number } | null = null;
    for (const [key, emoji] of keys) {
      const distance = editDistance(joined, key.replace(/ /g, ""), max);
      if (distance <= max && (!found || distance < found.distance)) found = { emoji, distance };
    }
    return found?.emoji ?? null;
  };
  const quick = closest(Object.entries(QUICK_NAMES));
  if (quick) return quick;
  const near = closest(getIndex().byJoined);
  return near ? preferMan(near, words) : null;
}

// Unicode-aware word tokens; apostrophes, hyphens and underscores stay inside
// a word so "o'clock" and "upside-down" survive as one token.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/**
 * Replace a spoken emoji name with the emoji: "thumbs up emoji" -> "👍".
 *
 * The trigger is the spoken word "emoji" preceded by a name of up to five
 * words; the longest candidate that resolves wins, and the name plus the word
 * "emoji" are replaced. Text with no resolvable name is returned unchanged.
 */
export function expandSpokenEmoji(text: string): string {
  if (!text || !/emoji/i.test(text)) return text;

  const tokens: { value: string; start: number; end: number }[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(text); m !== null; m = WORD.exec(text)) {
    tokens.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }

  let out = "";
  let cursor = 0; // index into `text` already copied to `out`
  let firstUsable = 0; // index into `tokens` not yet consumed by a match

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value.toLowerCase() !== "emoji") continue;
    const available = Math.min(MAX_NAME_WORDS, i - firstUsable);
    for (let k = available; k >= 1; k--) {
      const candidate = tokens
        .slice(i - k, i)
        .map((t) => t.value)
        .join(" ");
      const emoji = lookup(candidate);
      if (!emoji) continue;
      out += text.slice(cursor, tokens[i - k].start) + emoji;
      cursor = tokens[i].end;
      firstUsable = i + 1;
      break;
    }
  }

  return cursor === 0 ? text : out + text.slice(cursor);
}
