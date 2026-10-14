// Pure scoring and sampling helpers for the STT A/B replay.
// No I/O here, so test/scripts/sttAb.test.js can cover every function.

export const BUCKETS = ["under-3s", "3-15s", "over-15s"];

// A duration that is not a finite number (NaN, null, a numeric string) throws
// rather than landing in a bucket; the SQLite INTEGER column yields numbers.
export function bucketFor(durationMs) {
  if (!Number.isFinite(durationMs)) throw new RangeError(`no duration bucket for ${durationMs}`);
  if (durationMs < 3000) return "under-3s";
  if (durationMs <= 15000) return "3-15s";
  return "over-15s";
}

// Lowercase, NFKC-compose, drop punctuation (keeping in-word apostrophes and
// hyphens as word joins), collapse whitespace. Combining marks (accents, vowel
// signs) are kept, so "café" vs "cafe" is an error. Numbers are NOT spelled
// out, so "5" vs "five" counts as a substitution in both directions. Turkish
// "İ" lowercases to "i" plus U+0307, so "İyi" vs "iyi" is a substitution too.
// "´" and "`" (and their compatibility forms U+1FFD and U+FF40) fold to an
// apostrophe before NFKC, which would split "´" into a space and a bare
// combining mark; a token with no letter or digit is dropped.
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/[\u00b4\u0060\u1ffd\uff40]/g, "'")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/([\p{L}\p{M}\p{N}])'(?=[\p{L}\p{N}])/gu, "$1\u0000")
    .replace(/([\p{L}\p{M}\p{N}])-(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/[^\p{L}\p{M}\p{N}\u0000\s]/gu, " ")
    .replace(/\u0000/g, "'")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

// Word-level edit distance (substitutions + deletions + insertions).
export function editDistance(ref, hyp) {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return prev[hyp.length];
}

// Returns { errors, refWords } so callers can pool a corpus WER
// (sum errors / sum refWords) instead of averaging per-clip ratios.
export function werCounts(reference, hypothesis) {
  const ref = normalizeText(reference);
  const hyp = normalizeText(hypothesis);
  return { errors: editDistance(ref, hyp), refWords: ref.length };
}

export function wer(reference, hypothesis) {
  const { errors, refWords } = werCounts(reference, hypothesis);
  if (refWords === 0) return errors === 0 ? 0 : 1;
  return errors / refWords;
}

// mulberry32: small deterministic PRNG so a seed reproduces the sample.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Equal share per duration bucket; a short bucket gives its unused share to
// the others. Input order does not matter (rows are sorted by id first).
export function stratifiedSample(rows, n, seed) {
  const rand = rng(seed);
  const pools = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  for (const row of [...rows].sort((x, y) => x.id - y.id)) {
    pools[bucketFor(row.audio_duration_ms)].push(row);
  }
  for (const b of BUCKETS) pools[b] = shuffle(pools[b], rand);
  const take = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  let left = Math.min(n, rows.length);
  while (left > 0) {
    const open = BUCKETS.filter((b) => take[b] < pools[b].length);
    const share = Math.max(1, Math.floor(left / open.length));
    for (const b of open) {
      if (left === 0) break;
      const add = Math.min(share, pools[b].length - take[b], left);
      take[b] += add;
      left -= add;
    }
  }
  return BUCKETS.flatMap((b) => pools[b].slice(0, take[b]).map((r) => ({ ...r, bucket: b })));
}

// Gold candidates come from the replay sample itself (re-stratified), so every
// hand-transcribed clip is one the replay actually scores.
export function goldCandidates(sample, n, seed) {
  return stratifiedSample(sample, n, seed + 1);
}

// Nearest-rank percentile.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function aggregate(rows) {
  const ok = rows.filter((r) => !r.error);
  const pooled = (key) => {
    const scored = ok.filter((r) => r[key]);
    const refWords = scored.reduce((s, r) => s + r[key].refWords, 0);
    const errors = scored.reduce((s, r) => s + r[key].errors, 0);
    return scored.length === 0 || refWords === 0 ? null : errors / refWords;
  };
  const lat = ok.map((r) => r.latencyMs);
  return {
    clips: rows.length,
    errors: rows.length - ok.length,
    agreementWer: pooled("agreement"),
    goldWer: pooled("gold"),
    goldClips: ok.filter((r) => r.gold).length,
    latencyMs: { median: percentile(lat, 50), p90: percentile(lat, 90), p95: percentile(lat, 95) },
  };
}

// results: [{ model, bucket, latencyMs, error?, agreement?: {errors, refWords}, gold?: {...} }]
export function summarize(results) {
  const models = [...new Set(results.map((r) => r.model))];
  return Object.fromEntries(
    models.map((m) => {
      const mine = results.filter((r) => r.model === m);
      const buckets = Object.fromEntries(
        BUCKETS.map((b) => [b, aggregate(mine.filter((r) => r.bucket === b))])
      );
      return [m, { all: aggregate(mine), buckets }];
    })
  );
}

const fmt = (v, digits = 3) => (v == null ? "n/a" : v.toFixed(digits));

export function summaryMarkdown(summary, meta) {
  const lines = [
    `# STT A/B summary`,
    ``,
    `Sample: ${meta.sample} clips, seed ${meta.seed}, endpoint ${meta.endpoint}.`,
    `Agreement WER is a SCREENING number: word error rate against the stored raw_text`,
    `(what whisper-large-v3-turbo produced at dictation time), not against the truth.`,
    `Gold WER is the accuracy number and needs --gold.`,
    ``,
    `| model | bucket | clips | errors | agreement WER | gold WER (clips) | latency ms median / p90 / p95 |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const [model, s] of Object.entries(summary)) {
    for (const [bucket, a] of [["all", s.all], ...Object.entries(s.buckets)]) {
      lines.push(
        `| ${model} | ${bucket} | ${a.clips} | ${a.errors} | ${fmt(a.agreementWer)} | ${fmt(a.goldWer)} (${a.goldClips}) | ${a.latencyMs.median ?? "n/a"} / ${a.latencyMs.p90 ?? "n/a"} / ${a.latencyMs.p95 ?? "n/a"} |`
      );
    }
  }
  return lines.join("\n") + "\n";
}
