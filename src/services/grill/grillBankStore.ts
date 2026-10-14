// The grill question store: the live question bank lives in SQLite (main
// process), and the compiled bank in src/config/grill/questionBank.ts is only
// its frozen seed. This module is the renderer half: it turns
// the compiled bank into seed rows, turns stored rows back into a GrillBank,
// and loads the bank through the preload API, seeding once on an empty store.
import { GRILL_BANK, type GrillBank, type GrillChapter } from "../../config/grill/questionBank";

/** One row of the `grill_questions` table. */
export interface StoredGrillQuestion {
  id: string;
  section: "standard" | "chapter" | "day-template";
  chapter: number | null;
  source: string | null;
  text: string;
  position: number;
  status: "active" | "retired";
  created_at: string;
  updated_at: string;
}

/** The preload surface this module needs; both calls may be absent. */
export interface GrillBankApi {
  grillGetQuestionBank?: () => Promise<{
    questions: StoredGrillQuestion[];
    params: Record<string, unknown>;
  }>;
  grillSeedQuestionBank?: (
    questions: StoredGrillQuestion[],
    params: Record<string, unknown>
  ) => Promise<{ questions: StoredGrillQuestion[]; params: Record<string, unknown> }>;
}

const DEFAULT_MAX_DAY_QUESTIONS = 4;
const DEFAULT_MAX_FEED_QUESTIONS = 2;

/**
 * Builds the seed rows and flow params for a fresh store from a compiled bank.
 * Positions run from 0 within each section, and within each chapter.
 */
export function seedRowsFromBank(
  bank: GrillBank,
  now: Date,
  newId: () => string = () => `gq-${crypto.randomUUID()}`
): { questions: StoredGrillQuestion[]; params: Record<string, unknown> } {
  const stamp = now.toISOString();
  const row = (
    section: StoredGrillQuestion["section"],
    text: string,
    position: number,
    chapter: number | null = null,
    source: string | null = null
  ): StoredGrillQuestion => ({
    id: newId(),
    section,
    chapter,
    source,
    text,
    position,
    status: "active",
    created_at: stamp,
    updated_at: stamp,
  });

  const questions: StoredGrillQuestion[] = [
    ...bank.standardQuestions.map((text, i) => row("standard", text, i)),
    ...bank.dayTemplates.map((t, i) => row("day-template", t.template, i, null, t.source)),
    ...bank.chapters.flatMap((chapter) =>
      chapter.questions.map((text, i) => row("chapter", text, i, chapter.number))
    ),
  ];

  return {
    questions,
    params: {
      max_day_questions: DEFAULT_MAX_DAY_QUESTIONS,
      max_feed_questions: DEFAULT_MAX_FEED_QUESTIONS,
      chapter_titles: Object.fromEntries(bank.chapters.map((c) => [String(c.number), c.title])),
    },
  };
}

const activeByPosition = (rows: StoredGrillQuestion[]): StoredGrillQuestion[] =>
  rows.filter((r) => r.status === "active").sort((a, b) => a.position - b.position);

const numberParam = (params: Record<string, unknown>, key: string, fallback: number): number => {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

/**
 * Rebuilds a GrillBank from stored rows. The interviewer rules and the lifetime
 * intro are not questions, so they come from the compiled bank; everything else
 * comes from the active rows, in position order, with ids and params attached.
 */
export function bankFromStore(
  questions: StoredGrillQuestion[],
  params: Record<string, unknown>,
  compiled: GrillBank = GRILL_BANK
): GrillBank {
  const standard = activeByPosition(questions.filter((q) => q.section === "standard"));
  const dayTemplates = activeByPosition(questions.filter((q) => q.section === "day-template"));
  const chapterRows = questions.filter((q) => q.section === "chapter" && q.chapter !== null);

  const titles = (params.chapter_titles ?? {}) as Record<string, string>;
  const numbers = [...new Set(chapterRows.map((q) => q.chapter as number))].sort((a, b) => a - b);
  const chapters: GrillChapter[] = [];
  const chapterIds: Record<number, string[]> = {};
  for (const number of numbers) {
    const rows = activeByPosition(chapterRows.filter((q) => q.chapter === number));
    if (rows.length === 0) continue;
    chapters.push({
      number,
      title: titles[String(number)] ?? "",
      questions: rows.map((r) => r.text),
    });
    chapterIds[number] = rows.map((r) => r.id);
  }

  return {
    rules: compiled.rules,
    dayTemplates: dayTemplates.map((r) => ({ source: r.source ?? "", template: r.text })),
    standardQuestions: standard.map((r) => r.text),
    lifetimeIntro: compiled.lifetimeIntro,
    chapters,
    ids: {
      standard: standard.map((r) => r.id),
      dayTemplates: dayTemplates.map((r) => r.id),
      chapters: chapterIds,
    },
    params: {
      maxDayQuestions: numberParam(params, "max_day_questions", DEFAULT_MAX_DAY_QUESTIONS),
      maxFeedQuestions: numberParam(params, "max_feed_questions", DEFAULT_MAX_FEED_QUESTIONS),
    },
  };
}

/**
 * Loads the live bank, seeding the store from the compiled bank the first time.
 * When the API is missing or fails, the compiled bank is returned (no ids), so a
 * grill still starts.
 */
export async function loadGrillBank(api: GrillBankApi | undefined): Promise<GrillBank> {
  if (!api?.grillGetQuestionBank) {
    console.warn("grill question store unavailable: using the compiled question bank");
    return GRILL_BANK;
  }
  try {
    let stored = await api.grillGetQuestionBank();
    if (stored.questions.length === 0) {
      if (!api.grillSeedQuestionBank) {
        console.warn("grill question store cannot be seeded: using the compiled question bank");
        return GRILL_BANK;
      }
      const seed = seedRowsFromBank(GRILL_BANK, new Date());
      stored = await api.grillSeedQuestionBank(seed.questions, seed.params);
    }
    return bankFromStore(stored.questions, stored.params);
  } catch (error) {
    console.warn("grill question store failed: using the compiled question bank", error);
    return GRILL_BANK;
  }
}
