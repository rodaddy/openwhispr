// Parses the grill question bank (src/config/grill/question-bank.md, a verbatim
// copy of rtech-consulting docs/playbooks/grill-question-bank.md). The compiled
// bank is the frozen seed for the app's grill question store (openwhispr#53);
// the live bank is the store. Grill mode still reads its interviewer rules,
// day-question templates, standard questions and lifetime chapters from a
// GrillBank rather than restating them.
import { GRILL_BANK_FILE } from "./questionBankText";

export interface GrillBankProvenance {
  sourceRepo: string;
  sourcePath: string;
  sourceCommit: string;
  sha256: string;
}

export interface GrillDayTemplate {
  source: string;
  template: string;
}

export interface GrillChapter {
  number: number;
  title: string;
  questions: string[];
}

export interface GrillBank {
  /** The "## Rules the interviewer follows" section, verbatim. */
  rules: string;
  dayTemplates: GrillDayTemplate[];
  standardQuestions: string[];
  /** Guidance paragraph at the top of "## Lifetime chapters", verbatim. */
  lifetimeIntro: string;
  chapters: GrillChapter[];
  /** Store ids parallel to each text array; absent on the compiled bank. */
  ids?: { standard: string[]; dayTemplates: string[]; chapters: Record<number, string[]> };
  /** Flow params from the store; absent on the compiled bank. */
  params?: { maxDayQuestions: number; maxFeedQuestions: number };
}

const HEADER_END = "-->\n\n";

export function splitBankFile(fileText: string): {
  provenance: GrillBankProvenance;
  body: string;
} {
  const end = fileText.indexOf(HEADER_END);
  if (!fileText.startsWith("<!--") || end < 0) {
    throw new Error("question-bank.md is missing its provenance header");
  }
  const header = fileText.slice(0, end);
  const field = (name: string): string => {
    const match = header.match(new RegExp(`^${name}: (.+)$`, "m"));
    if (!match) throw new Error(`question-bank.md header has no ${name}`);
    return match[1].trim();
  };
  return {
    provenance: {
      sourceRepo: field("source-repo"),
      sourcePath: field("source-path"),
      sourceCommit: field("source-commit"),
      sha256: field("sha256"),
    },
    body: fileText.slice(end + HEADER_END.length),
  };
}

function section(body: string, heading: string): string {
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`question bank has no "## ${heading}" section`);
  const from = start + 1;
  const next = body.indexOf("\n## ", from + 3);
  return body.slice(from, next < 0 ? undefined : next + 1).trimEnd();
}

function sectionContent(sectionText: string): string {
  return sectionText.slice(sectionText.indexOf("\n") + 1);
}

function parseDayTemplates(sectionText: string): GrillDayTemplate[] {
  return sectionText
    .split("\n")
    .filter(
      (line) => line.startsWith("| ") && !line.startsWith("| Source") && !/^\|\s*-/.test(line)
    )
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { source: cells[0], template: cells[1].replace(/^"(.*)"$/, "$1") };
    });
}

function parseNumberedList(sectionText: string): string[] {
  const items: string[] = [];
  for (const line of sectionContent(sectionText).split("\n")) {
    const item = line.match(/^\d+\.\s+(.*)$/);
    if (item) items.push(item[1].trim());
    else if (/^\s+\S/.test(line) && items.length > 0) {
      items[items.length - 1] += " " + line.trim();
    }
  }
  return items;
}

function parseChapters(sectionText: string): { intro: string; chapters: GrillChapter[] } {
  const paragraphs = sectionContent(sectionText)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  const intro: string[] = [];
  const chapters: GrillChapter[] = [];
  for (const paragraph of paragraphs) {
    const match = paragraph.match(/^\*\*(\d+)\.\s+(.+?)\*\*\s*(.*)$/);
    if (!match) {
      if (chapters.length === 0) intro.push(paragraph);
      continue;
    }
    chapters.push({
      number: Number(match[1]),
      title: match[2].trim().replace(/\.$/, ""),
      questions: match[3]
        .split(/(?<=[?.])\s+/)
        .map((q) => q.trim())
        .filter(Boolean),
    });
  }
  return { intro: intro.join("\n\n"), chapters };
}

export function parseGrillBank(body: string): GrillBank {
  const { intro, chapters } = parseChapters(section(body, "Lifetime chapters"));
  return {
    rules: section(body, "Rules the interviewer follows"),
    dayTemplates: parseDayTemplates(section(body, "Daily: day questions")),
    standardQuestions: parseNumberedList(section(body, "Daily: standard questions")),
    lifetimeIntro: intro,
    chapters,
  };
}

export const GRILL_BANK: GrillBank = parseGrillBank(splitBankFile(GRILL_BANK_FILE).body);

export function getGrillChapter(chapter: number, bank: GrillBank = GRILL_BANK): GrillChapter {
  const found = bank.chapters.find((c) => c.number === chapter);
  if (!found) throw new Error(`the question bank has no lifetime chapter ${chapter}`);
  return found;
}
