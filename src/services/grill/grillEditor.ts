// Pure grouping/ordering for the grill question editor (openwhispr#54). The
// stored rows arrive flat; the editor renders them as three groups, with the
// chapter group split per chapter and retired rows parked at the end.
import type {
  GrillQuestionMarkCounts,
  GrillQuestionMarkValue,
  GrillQuestionRow,
} from "../../types/electron";

export interface GrillChapterGroup {
  number: number;
  rows: GrillQuestionRow[];
}

export interface GroupedGrillQuestions {
  standard: GrillQuestionRow[];
  dayTemplates: GrillQuestionRow[];
  chapters: GrillChapterGroup[];
}

/** Active rows first, each half in ascending position order. */
const orderRows = (rows: GrillQuestionRow[]): GrillQuestionRow[] =>
  [...rows].sort((a, b) => {
    const retired = Number(a.status === "retired") - Number(b.status === "retired");
    return retired !== 0 ? retired : a.position - b.position;
  });

/**
 * Groups stored questions by section (and, for chapters, by chapter number),
 * ordering every group by position with retired rows last.
 */
export function groupGrillQuestions(rows: GrillQuestionRow[]): GroupedGrillQuestions {
  const chapterRows = rows.filter((r) => r.section === "chapter" && r.chapter !== null);
  const numbers = [...new Set(chapterRows.map((r) => r.chapter as number))].sort((a, b) => a - b);

  return {
    standard: orderRows(rows.filter((r) => r.section === "standard")),
    dayTemplates: orderRows(rows.filter((r) => r.section === "day-template")),
    chapters: numbers.map((number) => ({
      number,
      rows: orderRows(chapterRows.filter((r) => r.chapter === number)),
    })),
  };
}

export type GrillMarkTally = Record<GrillQuestionMarkValue, number>;

const MARK_KINDS: GrillQuestionMarkValue[] = ["good", "weak", "retire"];

/**
 * Per-question good / weak / retire tallies for the rows the editor shows.
 * Every row gets a tally (zeros when unmarked), retired rows included; counts
 * for ids that are not among `rows` are ignored.
 */
export function markCountsForRows(
  rows: GrillQuestionRow[],
  counts: GrillQuestionMarkCounts
): Record<string, GrillMarkTally> {
  const tallies: Record<string, GrillMarkTally> = {};
  for (const row of rows) {
    const stored = Object.hasOwn(counts, row.id) ? counts[row.id] : undefined;
    const tally: GrillMarkTally = { good: 0, weak: 0, retire: 0 };
    for (const mark of MARK_KINDS) {
      const value = stored?.[mark];
      if (typeof value === "number" && Number.isFinite(value)) tally[mark] = value;
    }
    tallies[row.id] = tally;
  }
  return tallies;
}
