// Grill mode: an interviewer that asks Rico one question at a time and follows
// each answer until it is concrete. Not a persona: it has no name and no voice
// of its own. Everything it asks comes from the question bank
// (src/config/grill/question-bank.md). When GRILL_INTERVIEWER_PROMPT changes
// (including a bank re-sync that changes the rules section), move its old hash
// to the retired set in src/config/retiredPrompts.js and record the new one.
import { GRILL_BANK, getGrillChapter, type GrillBank } from "../grill/questionBank";

export type GrillSessionSpec =
  | {
      kind: "daily";
      /** Local date of the session, YYYY-MM-DD. */
      date: string;
      /** Day questions already filled from local context, asked first. */
      dayQuestions: string[];
      /** Standard questions in today's rotation order, asked after the day questions. */
      standardQuestions: string[];
      /**
       * Open feed questions from the social-media-pipeline, asked word for word
       * after the day questions. The id rides on the saved turn that asked it.
       */
      feedQuestions?: Array<{ id: string; question: string }>;
      /** Question text as asked -> its store id; absent when the bank has none. */
      questionIds?: Record<string, string>;
    }
  | {
      kind: "lifetime";
      chapter: number;
      /** The chapter's title as planned, from the store bank. */
      chapterTitle?: string;
      /** The chapter's questions as planned, from the store bank. */
      chapterQuestions?: string[];
      /** Question text as asked -> its store id; absent when the bank has none. */
      questionIds?: Record<string, string>;
    };

export const GRILL_INTERVIEWER_PROMPT: string =
  "You are running a grill session: a spoken interview of Rico. Your only job is to ask " +
  "questions and draw out his own stories, opinions, lessons and methods in his own words. " +
  "You never answer for him, never offer your own opinion, and never invent a take.\n\n" +
  "Replies are read aloud: one short question per reply, plain text, no markdown, no lists, " +
  "no emoji. Do not summarize or praise his answer before the next question.\n\n" +
  GRILL_BANK.rules +
  "\n";

/**
 * The one question every grill closes with, asked word for word so the answer
 * can be tagged and fed back into the bank (openwhispr#55).
 */
export const GRILL_FEEDBACK_QUESTION: string =
  "Before we stop: which question today got your best answer, and which one fell flat?";

const feedbackInstruction = (): string =>
  `When time is up, ask this question word for word, exactly as written: "${GRILL_FEEDBACK_QUESTION}" ` +
  "Wait for his answer, then give the closing line from the rules above.";

function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

export function buildGrillSessionSection(
  spec: GrillSessionSpec,
  bank: GrillBank = GRILL_BANK
): string {
  if (spec.kind === "lifetime") {
    // The planned chapter (from the store bank) wins over the compiled bank's.
    const planned = spec.chapterQuestions && spec.chapterQuestions.length > 0;
    const chapter =
      planned && spec.chapterTitle != null ? null : getGrillChapter(spec.chapter, bank);
    const title = spec.chapterTitle ?? chapter!.title;
    const questions = planned ? spec.chapterQuestions! : chapter!.questions;
    return [
      `Session: Lifetime chapter ${spec.chapter}: ${title}. About 30 minutes.`,
      bank.lifetimeIntro,
      `Starting questions for this chapter, in order:\n${numbered(questions)}`,
      feedbackInstruction(),
    ].join("\n\n");
  }

  const templates = bank.dayTemplates.map((t) => `- ${t.source}: "${t.template}"`).join("\n");
  const parts = [
    `Session: Daily grill, ${spec.date}. 10 to 15 minutes.`,
    `Day-question templates (the day questions below were filled from them):\n${templates}`,
  ];
  if (spec.dayQuestions.length > 0) {
    parts.push(`Day questions, ask these first, in order:\n${numbered(spec.dayQuestions)}`);
  }
  if (spec.feedQuestions && spec.feedQuestions.length > 0) {
    parts.push(
      `Feed questions, ask these after the day questions, word for word, in order:\n${numbered(spec.feedQuestions.map((q) => q.question))}`
    );
  }
  parts.push(
    `Standard questions, ask after the day questions until time runs out:\n${numbered(spec.standardQuestions)}`
  );
  parts.push(feedbackInstruction());
  return parts.join("\n\n");
}
