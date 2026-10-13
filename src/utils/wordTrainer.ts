import { isSilenceHallucination } from "../helpers/silenceHallucinations";
import { snippetKey, type Snippet } from "./snippets";

/** Trim, collapse internal whitespace, and drop trailing sentence punctuation. */
export function normalize(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?]+$/, "")
    .trim();
}

const key = (value: string) => normalize(value).toLowerCase();

/**
 * Turn one training take into a correction snippet, or null when the take is
 * blank, already right (ignoring case and trailing punctuation), or a silence
 * hallucination such as "Thank you.".
 */
export function takeToCorrection(heard: string, target: string): Snippet | null {
  const trigger = normalize(heard ?? "");
  if (!trigger || key(trigger) === key(target)) return null;
  if (isSilenceHallucination(heard)) return null;
  return { trigger, replacement: target };
}

/**
 * Fold new corrections into the snippet list. Triggers are compared by the
 * matcher's own key (snippetKey), so a correction only replaces a snippet
 * that would expand the same spoken text; the first of several new ones with
 * one key wins. A trigger that already exists keeps its place and takes the
 * new replacement. The input array is not mutated.
 */
export function mergeCorrections(
  snippets: Snippet[],
  newOnes: Snippet[]
): { snippets: Snippet[]; added: string[]; replaced: string[] } {
  const result = snippets.map((s) => ({ ...s }));
  const added: string[] = [];
  const replaced: string[] = [];
  const seen = new Set<string>();
  for (const correction of newOnes) {
    const k = snippetKey(correction.trigger);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const existing = result.find((s) => snippetKey(s.trigger) === k);
    if (existing) {
      existing.replacement = correction.replacement;
      replaced.push(existing.trigger);
    } else {
      result.push({ trigger: correction.trigger, replacement: correction.replacement });
      added.push(correction.trigger);
    }
  }
  return { snippets: result, added, replaced };
}
