#!/usr/bin/env node
/**
 * Generates src/data/spokenEmoji.en.json — the lookup table behind spoken
 * emoji names ("thumbs up emoji" → 👍).
 *
 * Source:  https://cdn.jsdelivr.net/npm/emojibase-data@16.0.3/en/compact.json
 * Pinned:  emojibase-data 16.0.3 (CLDR English labels + tags)
 * License: emojibase-data is MIT; the underlying CLDR data is Unicode license.
 *
 * Regenerate with:
 *   node scripts/generate-emoji-data.mjs
 *
 * The output is committed like a lockfile: the app never downloads at runtime.
 * Skin-tone variants and the regional-indicator letters are dropped — they are
 * never what someone means when they say a name out loud.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "16.0.3";
const SOURCE = `https://cdn.jsdelivr.net/npm/emojibase-data@${VERSION}/en/compact.json`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "src/data/spokenEmoji.en.json");

// Emojibase marks skin tones with the group/subgroup-free `tone` field, but the
// compact set also carries the modifiers inline; U+1F3FB..U+1F3FF is the range.
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
// Regional indicators: the flag letters, whose labels are single letters.
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u;

function collect(entries, out, seen) {
  for (const entry of entries) {
    const emoji = entry.unicode ?? entry.emoji;
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (emoji && label && !SKIN_TONE.test(emoji) && !REGIONAL_INDICATOR.test(emoji)) {
      if (!seen.has(label.toLowerCase())) {
        seen.add(label.toLowerCase());
        const tags = Array.isArray(entry.tags)
          ? entry.tags.filter((t) => typeof t === "string" && t.trim())
          : [];
        const row = { e: emoji, l: label };
        if (tags.length > 0) row.t = tags;
        out.push(row);
      }
    }
    if (Array.isArray(entry.skins)) collect(entry.skins, out, seen);
  }
}

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(`${SOURCE} -> HTTP ${response.status}`);
}
const data = await response.json();

const rows = [];
collect(data, rows, new Set());

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(rows)}\n`, "utf8");

console.log(`wrote ${OUT}`);
console.log(`entries: ${rows.length}`);
