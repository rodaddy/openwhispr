// Picks the daily grill's opening "day questions" from local context only:
// today's and yesterday's calendar events and meeting notes created in the
// last 24 hours, filled into the question bank's templates. Deterministic: the
// same context always yields the same questions.
import { GRILL_BANK, type GrillBank } from "../../config/grill/questionBank";

export const MAX_DAY_QUESTIONS = 4;
const QUOTE_MAX_WORDS = 12;
const QUOTE_MIN_WORDS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

const CALENDAR_SOURCE = "Calendar or meeting";
const TRANSCRIPT_SOURCE = "Meeting transcript";

export interface GrillCalendarEvent {
  id: string;
  summary?: string | null;
  start_time: string;
  end_time: string;
  is_all_day?: number | boolean;
  status?: string;
  attendees?: string | null;
}

/** A pending "To grill" topic (a brain dump or a hand-added one). */
export interface GrillTopic {
  id: string;
  text: string;
  /** "brain-dump", or "manual" for a hand-added topic. */
  source?: string;
}

const TOPIC_MAX_CHARS = 300;

/**
 * Pending topics are asked first and count toward the day-question max. The
 * label says where the topic came from; its text is one line, at most 300 chars.
 */
export function grillTopicQuestion(topic: GrillTopic): string {
  const oneLine = topic.text.replace(/\s+/g, " ").trim();
  const text =
    oneLine.length > TOPIC_MAX_CHARS ? oneLine.slice(0, TOPIC_MAX_CHARS - 3) + "..." : oneLine;
  const label = topic.source === "brain-dump" ? "From your brain dump" : "Topic you added";
  return `${label}: ${text}`;
}

export interface GrillMeetingNote {
  id: number;
  title: string;
  created_at: string;
  calendar_event_id?: string | null;
  participants?: string | null;
  transcript?: string | null;
}

interface Person {
  email?: string | null;
  displayName?: string | null;
  name?: string | null;
  self?: boolean;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
function parseTimestamp(value: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(value.replace(" ", "T") + "Z");
  }
  return Date.parse(value);
}

function personName(person: Person): string | null {
  const name = (person.displayName || person.name || "").trim();
  if (name) return name;
  const local = (person.email || "").split("@")[0];
  if (!local) return null;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function joinNames(people: Person[]): string | null {
  const names = people
    .filter((p) => !p.self)
    .map(personName)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} other${others === 1 ? "" : "s"}`;
}

function shortQuote(transcript: string | null | undefined): string | null {
  const mine = parseJsonArray<{ text?: string; source?: string }>(transcript)
    .filter((s) => s.source === "mic" && typeof s.text === "string")
    .map((s) => s.text!.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length >= QUOTE_MIN_WORDS);
  if (mine.length === 0) return null;
  const longest = mine.reduce((best, words) => (words.length > best.length ? words : best));
  const quote =
    longest.length > QUOTE_MAX_WORDS
      ? longest.slice(0, QUOTE_MAX_WORDS).join(" ") + "..."
      : longest.join(" ").replace(/[.!?,;:]+$/, "");
  return quote;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match);
}

function localMidnight(now: Date, dayOffset: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset).getTime();
}

export function selectDayQuestions({
  events,
  meetingNotes,
  now,
  topics = [],
  bank = GRILL_BANK,
  max = bank.params?.maxDayQuestions ?? MAX_DAY_QUESTIONS,
}: {
  events: GrillCalendarEvent[];
  meetingNotes: GrillMeetingNote[];
  now: Date;
  topics?: GrillTopic[];
  bank?: GrillBank;
  max?: number;
}): string[] {
  const templateFor = (source: string) =>
    bank.dayTemplates.find((t) => t.source === source)?.template ?? null;
  const calendarTemplate = templateFor(CALENDAR_SOURCE);
  const transcriptTemplate = templateFor(TRANSCRIPT_SOURCE);
  const nowMs = now.getTime();

  const recentNotes = meetingNotes
    .filter((note) => {
      const created = parseTimestamp(note.created_at);
      return Number.isFinite(created) && created <= nowMs && created > nowMs - DAY_MS;
    })
    .sort((a, b) => parseTimestamp(b.created_at) - parseTimestamp(a.created_at));

  const quoted: string[] = [];
  const unquoted: string[] = [];
  const coveredEvents = new Set<string>();
  for (const note of recentNotes) {
    const quote = shortQuote(note.transcript);
    if (quote && transcriptTemplate) {
      quoted.push(fill(transcriptTemplate, { meeting: note.title, "short quote": quote }));
    } else if (calendarTemplate) {
      const who = joinNames(parseJsonArray<Person>(note.participants)) ?? "them";
      unquoted.push(fill(calendarTemplate, { who, topic: note.title }));
    } else {
      continue;
    }
    if (note.calendar_event_id) coveredEvents.add(note.calendar_event_id);
  }

  const windowStart = localMidnight(now, -1);
  const windowEnd = localMidnight(now, 1);
  const eventQuestions = !calendarTemplate
    ? []
    : events
        .filter((event) => !coveredEvents.has(event.id))
        .filter((event) => !(event.is_all_day === true || event.is_all_day === 1))
        .filter((event) => event.status !== "cancelled" && Boolean(event.summary?.trim()))
        .map((event) => ({
          event,
          start: Date.parse(event.start_time),
          end: Date.parse(event.end_time),
          who: joinNames(parseJsonArray<Person>(event.attendees)),
        }))
        .filter(
          (e) =>
            e.who !== null &&
            Number.isFinite(e.start) &&
            Number.isFinite(e.end) &&
            e.start < windowEnd &&
            e.end > windowStart
        )
        // Meetings already over come first, most recent first; then today's
        // later meetings in start order.
        .sort((a, b) => {
          const aDone = a.end <= nowMs;
          const bDone = b.end <= nowMs;
          if (aDone !== bDone) return aDone ? -1 : 1;
          return aDone ? b.end - a.end : a.start - b.start;
        })
        .map((e) => fill(calendarTemplate, { who: e.who!, topic: e.event.summary!.trim() }));

  const topicQuestions = topics.slice(0, max).map(grillTopicQuestion);
  return [...new Set([...topicQuestions, ...quoted, ...unquoted, ...eventQuestions])].slice(0, max);
}

/** Standard questions rotated by local calendar day, so each comes up every few days. */
export function rotateStandardQuestions(questions: string[], now: Date): string[] {
  if (questions.length === 0) return [];
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
  const offset = day % questions.length;
  return [...questions.slice(offset), ...questions.slice(0, offset)];
}
