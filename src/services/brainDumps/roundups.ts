import type { BrainDumpRoundupContext } from "../../types/electron";

// Daily brain-dump roundups (desktop#327): SUMMARY ONLY. A roundup never
// sorts, moves, or creates reminders or topics; it saves one note.

export type RoundupSlot = "morning" | "night";
export type RoundupTimes = Record<RoundupSlot, string>;
/** ISO time each slot last ran. */
export type RoundupLastRuns = Partial<Record<RoundupSlot, string>>;
/** Scheduled tries that failed for a slot: how many, and when the last one was. */
export type RoundupFailures = Partial<Record<RoundupSlot, { tries: number; lastAt: string }>>;

/** Scheduled tries per slot per day; "Run now" stays the manual retry. */
export const MAX_ROUNDUP_TRIES = 3;
/** Wait before the next scheduled try, after 1, 2, ... failures. */
export const ROUNDUP_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000];

export const ROUNDUP_SLOTS: RoundupSlot[] = ["morning", "night"];
export const DEFAULT_ROUNDUP_TIMES: RoundupTimes = { morning: "09:30", night: "23:00" };

/** Roundup input caps (#425): the newest dumps only, and this many characters in all. */
export const MAX_ROUNDUP_DUMPS = 100;
export const MAX_ROUNDUP_CHARS = 20_000;

/** A stored roundup time is exactly "HH:MM", 00:00 to 23:59. */
export const isRoundupTime = (value: unknown): value is string =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** The times to use: a stored value that is not HH:MM falls back to its default (#424). */
export function resolveRoundupTimes(stored: Partial<Record<RoundupSlot, unknown>>): RoundupTimes {
  const pick = (slot: RoundupSlot) => {
    const value = stored[slot];
    return isRoundupTime(value) ? value : DEFAULT_ROUNDUP_TIMES[slot];
  };
  return { morning: pick("morning"), night: pick("night") };
}

export const ROUNDUP_PROMPT = `You write a short daily roundup of the user's brain dumps.
Summarize only; do not invent anything. Reply in Markdown:
- group the dumps by theme under short headings;
- list any action items as a checklist ("- [ ] ...");
- end with "Already filed", saying where each processed dump went, if any were.
Keep it brief.`;

/** Today's time for "HH:MM", or null when it is not a valid time. */
function slotTimeOn(day: Date, hhmm: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}

/**
 * The slots to run now: today's time has passed and the slot has not run since.
 * Only today counts, so missed past days are never backfilled. A slot whose
 * scheduled tries failed today backs off, and after MAX_ROUNDUP_TRIES it waits
 * for tomorrow, so a failing model is never called every minute.
 */
export function dueRoundupSlots(
  now: Date,
  times: RoundupTimes,
  lastRuns: RoundupLastRuns,
  failures: RoundupFailures = {}
): RoundupSlot[] {
  return ROUNDUP_SLOTS.filter((slot) => {
    const at = slotTimeOn(now, times[slot]);
    if (!at || now < at) return false;
    const last = lastRuns[slot] ? Date.parse(lastRuns[slot] as string) : NaN;
    if (!Number.isNaN(last) && last >= at.getTime()) return false;
    const failure = failures[slot];
    const failedAt = failure ? Date.parse(failure.lastAt) : NaN;
    if (!failure || Number.isNaN(failedAt) || failedAt < at.getTime()) return true;
    if (failure.tries >= MAX_ROUNDUP_TRIES) return false;
    const delays = ROUNDUP_RETRY_DELAYS_MS;
    const delay = delays[Math.min(Math.max(failure.tries, 1), delays.length) - 1];
    return now.getTime() >= failedAt + delay;
  });
}

/** Records one failed scheduled try; a failure from an earlier day restarts the count. */
export function recordRoundupFailure(
  failures: RoundupFailures,
  slot: RoundupSlot,
  now: Date,
  times: RoundupTimes
): RoundupFailures {
  const at = slotTimeOn(now, times[slot]);
  const prior = failures[slot];
  const priorAt = prior ? Date.parse(prior.lastAt) : NaN;
  const sameDay = Boolean(prior && at && !Number.isNaN(priorAt) && priorAt >= at.getTime());
  const tries = (sameDay && prior ? prior.tries : 0) + 1;
  return { ...failures, [slot]: { tries, lastAt: now.toISOString() } };
}

/** The slot "Run now" runs: morning between the two times, night otherwise. */
export function currentRoundupSlot(now: Date, times: RoundupTimes): RoundupSlot {
  const morning = slotTimeOn(now, times.morning);
  const night = slotTimeOn(now, times.night);
  return morning && night && now >= morning && now < night ? "morning" : "night";
}

/** Start of a roundup: the previous run of either slot, else 24 hours ago. */
export function roundupSince(lastRuns: RoundupLastRuns, now: Date): string {
  const runs = Object.values(lastRuns)
    .map((iso) => Date.parse(iso as string))
    .filter((ms) => !Number.isNaN(ms));
  return new Date(runs.length ? Math.max(...runs) : now.getTime() - 86_400_000).toISOString();
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const dumpText = (dump: BrainDumpRoundupContext["dumps"][number]) => dump.content || dump.title;

/**
 * The dumps a roundup reads (#425): the newest MAX_ROUNDUP_DUMPS, then newest
 * first while they fit in MAX_ROUNDUP_CHARS. Dumps arrive oldest first. The
 * newest dump is always kept, cut to the limit if it alone is too long.
 */
export function capRoundupDumps(dumps: BrainDumpRoundupContext["dumps"]) {
  const kept: BrainDumpRoundupContext["dumps"] = [];
  let chars = 0;
  for (const dump of dumps.slice(-MAX_ROUNDUP_DUMPS).reverse()) {
    const text = dumpText(dump);
    if (kept.length === 0 && text.length > MAX_ROUNDUP_CHARS) {
      kept.push({ ...dump, content: text.slice(0, MAX_ROUNDUP_CHARS) });
      chars = MAX_ROUNDUP_CHARS;
      continue;
    }
    if (chars + text.length > MAX_ROUNDUP_CHARS) break;
    kept.push(dump);
    chars += text.length;
  }
  return { dumps: kept.reverse(), omitted: dumps.length - kept.length };
}

const omittedLine = (omitted: number) =>
  `${omitted} older dump${omitted === 1 ? "" : "s"} not included`;

export function buildRoundupInput(
  { dumps, actions }: BrainDumpRoundupContext,
  omitted = 0
): string {
  const lines = ["Brain dumps:"];
  for (const dump of dumps) lines.push(`- (${dump.createdAt}) ${dumpText(dump)}`);
  if (omitted > 0) lines.push(`(${omittedLine(omitted)})`);
  if (actions.length) {
    lines.push("", "Already filed:");
    for (const action of actions) lines.push(`- "${action.title}" -> ${action.target}`);
  }
  return lines.join("\n");
}

export interface RoundupDeps {
  now: () => Date;
  /** ISO start: dumps created since then are summarized while there is no cursor yet. */
  since: string;
  /** Arrival cursor: dumps with a higher local note id are summarized. */
  afterNoteId?: number;
  context: (sinceIso: string, afterNoteId?: number) => Promise<BrainDumpRoundupContext>;
  /** One model call. */
  summarize: (systemPrompt: string, content: string) => Promise<string>;
  save: (title: string, content: string) => Promise<void>;
}

/** One roundup run. No new dumps: nothing is created. */
export async function runRoundup(slot: RoundupSlot, deps: RoundupDeps) {
  const context = await deps.context(deps.since, deps.afterNoteId);
  const lastNoteId = context.lastNoteId;
  if (context.dumps.length === 0) return { saved: false as const, lastNoteId };
  const { dumps, omitted } = capRoundupDumps(context.dumps);
  const input = buildRoundupInput({ ...context, dumps }, omitted);
  const summary = (await deps.summarize(ROUNDUP_PROMPT, input)).trim();
  if (!summary) throw new Error("The model returned an empty roundup");
  const title = `Roundup ${localDate(deps.now())} ${slot}`;
  await deps.save(title, omitted > 0 ? `${summary}\n\n_${omittedLine(omitted)}._` : summary);
  return { saved: true as const, title, lastNoteId };
}
