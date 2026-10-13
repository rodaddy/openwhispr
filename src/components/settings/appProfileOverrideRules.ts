import type { DictationAppProfile, DictationAppProfileName } from "../../stores/settingsStore";

export const APP_PROFILE_NAMES: readonly DictationAppProfileName[] = [
  "terminal",
  "editor",
  "chat",
  "prose",
];
export const MAX_APP_PROFILE_OVERRIDES = 20;
export const MAX_APP_PROFILE_MATCH_LENGTH = 80;

// The list the settings rows write to the store. Same rules as the main
// process's sanitizeAppProfileOverrides (dictationFormattingProfile.js), so
// what is saved is what the paste formatter will use: a name is trimmed and
// needs a letter or digit, the first of two rows for one app wins, twenty
// rows at most. A longer name is cut to fit rather than dropped.
export function cleanAppProfileOverrides(
  rows: readonly DictationAppProfile[]
): DictationAppProfile[] {
  const seen = new Set<string>();
  const out: DictationAppProfile[] = [];
  for (const row of rows) {
    if (out.length >= MAX_APP_PROFILE_OVERRIDES) break;
    if (!row || typeof row.match !== "string" || !APP_PROFILE_NAMES.includes(row.profile)) continue;
    const match = row.match.trim().slice(0, MAX_APP_PROFILE_MATCH_LENGTH).trimEnd();
    if (!/[a-z0-9]/i.test(match)) continue;
    const key = match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ match, profile: row.profile });
  }
  return out;
}
