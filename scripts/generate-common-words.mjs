#!/usr/bin/env node
/**
 * Generates src/data/commonWords.en.json — the list of ordinary English words
 * that auto-learn must never add to the custom dictionary. A dictionary full
 * of "the", "are" and "time" dilutes the Whisper prompt hint; proper nouns and
 * jargon (Sinead, Skippy, rodaddy, Codex) are absent from this list and still
 * get learned.
 *
 * Source:  https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@d0736d492489198e4f9d650c7ab4143bc14c1e9e/google-10000-english-usa.txt
 * Pinned:  first20hours/google-10000-english @ d0736d492489198e4f9d650c7ab4143bc14c1e9e
 *          (master as of 2026-09-29)
 * License: the word list is derived from the Google Web Trillion Word Corpus.
 *
 * Regenerate with:
 *   node scripts/generate-common-words.mjs
 *
 * The output is committed like a lockfile: the app never downloads at runtime.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "d0736d492489198e4f9d650c7ab4143bc14c1e9e";
const SOURCE = `https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@${COMMIT}/google-10000-english-usa.txt`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "src/data/commonWords.en.json");

// Words Rico's dictation surfaced that the frequency list does not carry:
// profanity (scrubbed from the Google corpus), casual speech, and the
// apostrophe-stripped contractions the guard normalizes to.
const EXTRA = [
  "fuck",
  "fucking",
  "fucked",
  "shit",
  "damn",
  "okay",
  "yeah",
  "gonna",
  "wanna",
  "gotta",
  "lets",
  "dont",
  "doesnt",
  "isnt",
  "cant",
  "wont",
  "shouldnt",
  "couldnt",
  "thats",
  "whats",
  "its",
];

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(`${SOURCE} -> HTTP ${response.status}`);
}
const text = await response.text();

const words = new Set();
for (const line of text.split("\n")) {
  const word = line.trim().toLowerCase();
  if (word) words.add(word);
}
for (const word of EXTRA) words.add(word);

const sorted = [...words].sort();

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(sorted)}\n`, "utf8");

console.log(`wrote ${OUT}`);
console.log(`words: ${sorted.length}`);
