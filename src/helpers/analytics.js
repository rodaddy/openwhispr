// ESM like calendarAvailability.js: this module is shared with the renderer,
// where Vite only handles ESM source files; main-process CJS callers load it
// via Node's require(esm) with module-syntax detection.
const DAY_MS = 86_400_000;
export const ANALYTICS_ACTIVITY_MONTH_COUNT = 6;
export const ANALYTICS_COUNTER_VERSION = 2;

const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function countWhitespaceDelimitedWords(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function countSpokenWords(text) {
  const fallbackCount = countWhitespaceDelimitedWords(text);
  if (fallbackCount === 0 || !CJK_SCRIPT_PATTERN.test(text)) return fallbackCount;

  try {
    if (typeof Intl === "undefined" || !Intl.Segmenter) return fallbackCount;
    const segmenter = new Intl.Segmenter("und", { granularity: "word" });
    const segmentedCount = Array.from(segmenter.segment(text)).filter(
      (segment) => segment.isWordLike
    ).length;
    return segmentedCount || fallbackCount;
  } catch {
    return fallbackCount;
  }
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildAnalyticsActivityDays(daily, today = new Date()) {
  const byDate = new Map(daily.map((bucket) => [bucket.date, bucket]));
  const startDate = new Date(
    today.getFullYear(),
    today.getMonth() - ANALYTICS_ACTIVITY_MONTH_COUNT + 1,
    1,
    12
  );
  const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const days = [];

  for (
    let date = startDate;
    date <= endDate;
    date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12)
  ) {
    const key = localDateKey(date);
    days.push({ date: key, words: byDate.get(key)?.words || 0 });
  }

  return days;
}

function modeFromSettings({ useLocalWhisper, transcriptionMode, cloudTranscriptionMode }) {
  if (useLocalWhisper || transcriptionMode === "local") return "local";
  if (transcriptionMode === "self-hosted") return "self_hosted";
  if (cloudTranscriptionMode === "openwhispr" || transcriptionMode === "openwhispr") {
    return "openwhispr_cloud";
  }
  if (transcriptionMode === "providers") return "byok";
  return "unknown";
}

function modeFromStoredProvider(provider) {
  if (!provider) return "unknown";
  if (provider.startsWith("local")) return "local";
  if (provider === "openwhispr") return "openwhispr_cloud";
  if (provider.includes("self-hosted") || provider === "lan") return "self_hosted";
  return "byok";
}

// The provider that actually ran wins when it names a concrete engine or ends
// in "-fallback", which proves the selected route never ran. Streaming provider
// names ("deepgram-streaming") are too coarse to tell BYOK from OpenWhispr
// Cloud, so everything else defers to the selected settings.
export function resolveAnalyticsMode(settings, provider) {
  const providerMode = modeFromStoredProvider(provider);
  if (providerMode === "local" || providerMode === "self_hosted") return providerMode;
  if (provider?.endsWith("-fallback")) return providerMode;
  const selected = modeFromSettings(settings);
  return selected === "unknown" ? providerMode : selected;
}

function dayNumber(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
}

export function calculateStreaks(ascendingDays, today) {
  const days = [...new Set(ascendingDays)].sort();
  if (days.length === 0) return { currentStreakDays: 0, longestStreakDays: 0 };

  let run = 1;
  let longestStreakDays = 1;
  for (let index = 1; index < days.length; index += 1) {
    run = dayNumber(days[index]) - dayNumber(days[index - 1]) === 1 ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
  }

  if (dayNumber(today) - dayNumber(days[days.length - 1]) > 1) {
    return { currentStreakDays: 0, longestStreakDays };
  }

  let currentStreakDays = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    if (dayNumber(days[index]) - dayNumber(days[index - 1]) !== 1) break;
    currentStreakDays += 1;
  }
  return { currentStreakDays, longestStreakDays };
}

// Takes one row per local date (grouped in SQL so the row count stays bounded
// by calendar days) and stays the single owner of every derived figure.
export function summarizeAnalyticsDays(days, today = localDateKey()) {
  const daily = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let totalWords = 0;
  let totalDictations = 0;
  let totalSpokenDurationMs = 0;
  let coveredWords = 0;

  for (const day of daily) {
    totalWords += day.words;
    totalDictations += day.dictations;
    totalSpokenDurationMs += day.spokenDurationMs;
    coveredWords += day.coveredWords;
  }

  return {
    totalWords,
    totalDictations,
    totalSpokenDurationMs,
    averageWpm:
      totalSpokenDurationMs > 0
        ? Math.round((coveredWords * 60_000) / totalSpokenDurationMs)
        : null,
    ...calculateStreaks(
      daily.map((day) => day.date),
      today
    ),
    wpmCoveragePercent: totalWords > 0 ? Math.round((coveredWords / totalWords) * 100) : 0,
    daily: daily.slice(-366).map(({ date, words, dictations, spokenDurationMs }) => ({
      date,
      words,
      dictations,
      spokenDurationMs,
    })),
  };
}

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// Takes one row per dictation ({ model, ms }) and returns the median latency
// overall and per model. A missing model is grouped under null.
export function summarizeLatency(rows) {
  const all = [];
  const perModel = new Map();
  for (const row of rows || []) {
    const ms = row?.ms;
    if (typeof ms !== "number" || !(ms > 0)) continue;
    const model = typeof row.model === "string" && row.model.length > 0 ? row.model : null;
    all.push(ms);
    if (!perModel.has(model)) perModel.set(model, []);
    perModel.get(model).push(ms);
  }

  const byModel = [...perModel.entries()]
    .map(([model, values]) => ({
      model,
      sampleCount: values.length,
      medianMs: medianOf(values),
    }))
    .sort((a, b) => {
      if (b.sampleCount !== a.sampleCount) return b.sampleCount - a.sampleCount;
      if (a.model === null) return 1;
      if (b.model === null) return -1;
      return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    });

  return { sampleCount: all.length, medianMs: medianOf(all), byModel };
}
