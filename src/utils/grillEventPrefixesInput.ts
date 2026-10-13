// The Settings field edits grillEventPrefixes as one comma-separated line.

export function formatGrillEventPrefixes(prefixes: string[]): string {
  return prefixes.join(", ");
}

// Blank entries are dropped and a repeat (case-insensitive) keeps the first
// spelling. An empty result is valid: it turns the grill trigger off.
export function parseGrillEventPrefixesInput(text: string): string[] {
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of text.split(",")) {
    const prefix = raw.trim();
    const key = prefix.toLowerCase();
    if (!prefix || seen.has(key)) continue;
    seen.add(key);
    prefixes.push(prefix);
  }
  return prefixes;
}
