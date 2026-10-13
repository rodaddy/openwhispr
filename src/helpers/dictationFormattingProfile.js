/**
 * Pure dictation formatting-profile policy.
 *
 * Decides which formatting profile ("terminal" / "editor" / "chat" / "prose")
 * a dictation should get from the app it is about to land in, and what that
 * profile does to the final text. Electron-free, no I/O: ipcHandlers and the
 * cleanup path only apply the verdict returned here.
 */
const PROFILES = ["terminal", "editor", "chat", "prose"];
const DEFAULT_PROFILE = "prose";
const MAX_APP_PROFILE_OVERRIDES = 20;
const MAX_APP_PROFILE_MATCH_LENGTH = 80;

const TERMINAL_APPS = [
  "terminal",
  "iterm",
  "iterm2",
  "ghostty",
  "warp",
  "kitty",
  "alacritty",
  "wezterm",
  "hyper",
  "tabby",
  "konsole",
  "gnome terminal",
  "xterm",
  "foot",
  "tilix",
  "terminator",
  "windows terminal",
  "powershell",
  "cmd",
];

// No bare "code": it is a whole word in too many unrelated app names
// ("QR Code Generator"). VS Code is reached by its full name or bundle id.
const EDITOR_APPS = [
  "vscode",
  "visual studio code",
  "cursor",
  "windsurf",
  "zed",
  "xcode",
  "intellij",
  "pycharm",
  "webstorm",
  "goland",
  "rider",
  "clion",
  "rubymine",
  "android studio",
  "sublime text",
  "nvim",
  "neovim",
];

const CHAT_APPS = [
  "slack",
  "discord",
  "messages",
  "telegram",
  "whatsapp",
  "signal",
  "teams",
  "microsoft teams",
  "imessage",
];

const DEFAULT_APP_PROFILES = Object.freeze([
  ...TERMINAL_APPS.map((match) => Object.freeze({ match, profile: "terminal" })),
  ...EDITOR_APPS.map((match) => Object.freeze({ match, profile: "editor" })),
  ...CHAT_APPS.map((match) => Object.freeze({ match, profile: "chat" })),
]);

// Words whose final "." belongs to the word, not to the sentence. Compared
// lowercase, without the final period.
const ABBREVIATIONS = new Set([
  "etc",
  "e.g",
  "i.e",
  "vs",
  "inc",
  "ltd",
  "jr",
  "sr",
  "dr",
  "mr",
  "mrs",
  "a.m",
  "p.m",
  "u.s",
  "approx",
]);

// Shell commands a terminal dictation may start with. Only these get their
// sentence-case first letter lowered; any other word keeps its capital. A
// command that is also an English word ("make", "go", "open", "find") is left
// out on purpose: "Make sure it works" is a sentence, and a miss leaves the
// text as dictated.
const TERMINAL_COMMANDS = Object.freeze(
  new Set(
    `
    ls cd pwd cat printf mkdir rmdir rm cp mv ln chmod chown grep rg fd sed
    awk uniq wc tr tar unzip gzip gunzip curl wget ssh scp rsync nslookup
    sudo ps htop df du pbcopy pbpaste brew apt yum dnf git gh npm npx node
    yarn pnpm bun python python3 pip pipx uv cmake cargo rustc rustup docker
    kubectl helm terraform ansible vim nvim nano tmux ffmpeg jq
    `
      .split(/\s+/)
      .filter(Boolean)
  )
);

// Lowercase alphanumeric tokens: "com.microsoft.VSCode" -> ["com", "microsoft", "vscode"].
function tokenize(signature) {
  if (typeof signature !== "string") return [];
  return signature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// True when the phrase's tokens appear as a contiguous run inside `tokens`.
// Whole tokens only, so "foot" never matches "football".
function matchesPhrase(tokens, phrase) {
  const needle = tokenize(phrase);
  if (!Array.isArray(tokens) || needle.length === 0) return false;
  for (let start = 0; start + needle.length <= tokens.length; start += 1) {
    let hit = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (tokens[start + i] !== needle[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

function findProfile(tokens, entries) {
  for (const entry of entries) {
    if (!entry || !PROFILES.includes(entry.profile)) continue;
    if (matchesPhrase(tokens, entry.match)) return entry.profile;
  }
  return null;
}

// Precedence: user overrides > isTerminal > built-in app table > default.
function resolveFormattingProfile(target, overrides) {
  const t = target && typeof target === "object" ? target : {};
  const tokens = tokenize(
    [t.appName, t.exeName, t.windowClass, t.bundleId]
      .filter((value) => typeof value === "string")
      .join(" ")
  );

  const fromOverride = findProfile(tokens, Array.isArray(overrides) ? overrides : []);
  if (fromOverride) return fromOverride;
  if (t.isTerminal === true) return "terminal";
  return findProfile(tokens, DEFAULT_APP_PROFILES) || DEFAULT_PROFILE;
}

// The user's override list arrives from the renderer, so nothing about it is
// trusted: anything that is not a usable { match, profile } pair is dropped,
// the first of two entries for the same app wins, and the list is capped.
function sanitizeAppProfileOverrides(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  // Bounded work on hostile input: only the first entries are looked at, and
  // an oversize name is refused before it is trimmed or tokenized.
  for (const entry of value.slice(0, MAX_APP_PROFILE_OVERRIDES * 5)) {
    if (out.length >= MAX_APP_PROFILE_OVERRIDES) break;
    if (!entry || typeof entry !== "object" || typeof entry.match !== "string") continue;
    if (!PROFILES.includes(entry.profile)) continue;
    if (entry.match.length > MAX_APP_PROFILE_MATCH_LENGTH * 4) continue;
    const match = entry.match.trim();
    if (match.length > MAX_APP_PROFILE_MATCH_LENGTH || tokenize(match).length === 0) continue;
    const key = match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ match, profile: entry.profile });
  }
  return out;
}

// True when the text up to (not including) a "." ends in a known abbreviation.
function endsWithAbbreviation(textBeforePeriod) {
  const lastWord = textBeforePeriod.split(/\s+/).pop() || "";
  return ABBREVIATIONS.has(lastWord.replace(/^[^A-Za-z]+/, "").toLowerCase());
}

// A terminator only ends a sentence when whitespace and more text follow it,
// so "v1.2 is out" and a trailing "." both stay single-sentence. The period
// of an abbreviation ("etc. for tomorrow") is not a terminator either.
// Closing quotes and brackets may sit between the mark and the whitespace
// ('"Hello." She left.'); a period they follow is a real end, so only a bare
// "." is checked for an abbreviation.
function isSingleSentence(text) {
  if (typeof text !== "string") return true;
  const trimmed = text.trim();
  for (const match of trimmed.matchAll(/[.!?…][)"'”’\]]*(?=\s+\S)/g)) {
    if (match[0] === "." && endsWithAbbreviation(trimmed.slice(0, match.index))) continue;
    return false;
  }
  return true;
}

// Exactly one trailing "." after real text. "..", "..." and other terminators
// are kept, a lone "." is left alone rather than pasted as nothing, and the
// period of a closing abbreviation ("etc.") stays with its word.
function dropTrailingPeriod(core) {
  if (!/[^.]\.$/.test(core)) return core;
  const withoutPeriod = core.slice(0, -1);
  return endsWithAbbreviation(withoutPeriod) ? core : withoutPeriod;
}

function straightenQuotes(core) {
  return core.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function lowercaseLeadingWord(core) {
  const firstWord = core.split(/\s/, 1)[0];
  // A digit is allowed so "Python3" reaches the list.
  if (firstWord === "I" || !/^[A-Z][a-z0-9]+[,;:]?$/.test(firstWord)) return core;
  if (!TERMINAL_COMMANDS.has(firstWord.replace(/[,;:]$/, "").toLowerCase())) return core;
  return core[0].toLowerCase() + core.slice(1);
}

// A shell is case-sensitive, so a sentence-case "Ls" is a broken command. The
// first word is lowercased only when it is a known command ("Git status" ->
// "git status"); any other word, a name included, keeps its capital, so a
// miss leaves the text as dictated.
function formatTerminal(core) {
  const out = dropTrailingPeriod(straightenQuotes(core));
  return isSingleSentence(out) ? lowercaseLeadingWord(out) : out;
}

// Editors take prompts, comments and commit messages: keep the capital (it
// may be a name), lose the smart quotes and the trailing period.
function formatEditor(core) {
  return dropTrailingPeriod(straightenQuotes(core));
}

function formatChat(core) {
  return isSingleSentence(core) ? dropTrailingPeriod(core) : core;
}

function applyFormattingProfile(text, profile) {
  if (typeof text !== "string") return "";
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!core) return text;
  if (profile === "terminal") return lead + formatTerminal(core) + trail;
  if (profile === "editor") return lead + formatEditor(core) + trail;
  if (profile === "chat") return lead + formatChat(core) + trail;
  return text;
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE,
  DEFAULT_APP_PROFILES,
  MAX_APP_PROFILE_OVERRIDES,
  TERMINAL_COMMANDS,
  tokenize,
  matchesPhrase,
  resolveFormattingProfile,
  sanitizeAppProfileOverrides,
  isSingleSentence,
  applyFormattingProfile,
};
