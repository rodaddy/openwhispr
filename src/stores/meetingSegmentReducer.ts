import type { TranscriptSegment } from "./meetingRecordingStore";
import { normalizeTranscriptSegment } from "../utils/transcriptSpeakerState";

/**
 * State transition for live meeting segment events (partial / final / retract)
 * that never mutates its state argument; all side effects are confined to the
 * injected deps. Extracted from meetingRecordingStore's
 * onMeetingTranscriptionSegment handler; speaker identity side effects stay in
 * the store and are driven by the returned reduction. Phase 0: byte-for-byte
 * today's semantics.
 */
export interface MeetingSegmentEvent {
  text: string;
  /** "highlight" only ever arrives as a final; it never has a partial slot. */
  source: "mic" | "system" | "highlight";
  type: "partial" | "final" | "retract";
  timestamp?: number;
  /** Highlights only: when the dictation take stopped; `timestamp` is its start. */
  endTimestamp?: number;
}

export interface MeetingSegmentState {
  segments: TranscriptSegment[];
  micPartial: string;
  systemPartial: string;
}

export interface MeetingSegmentReducerDeps {
  /** Renderer-side id for a new final (today `seg-${++segmentCounter}`). */
  mintSegmentId: () => string;
  /** Applies speaker identifications, provisional speaker, index reservation, locks. Must be free of store writes — the reducer inserts into the segments snapshot it was handed. */
  decorateFinal: (segment: TranscriptSegment) => TranscriptSegment;
}

export type MeetingSegmentReduction =
  | { kind: "retract"; state: MeetingSegmentState; removed: TranscriptSegment[] }
  | { kind: "partial"; state: MeetingSegmentState; source: "mic" | "system" | "highlight" }
  | {
      kind: "final";
      state: MeetingSegmentState;
      inserted: TranscriptSegment;
      index: number;
      /** Mic finals a newly inserted highlight displaced (see isMicFinalInsideHighlight). */
      removed: TranscriptSegment[];
    }
  /** A mic final dropped because it is the meeting mic's copy of a highlight. */
  | { kind: "suppressed"; state: MeetingSegmentState };

// The meeting mic hears a highlight aside too. A mic final is stamped when it
// arrives in main, which lags the end of speech by the VAD commit and ASR time,
// so the window extends past the take's stop by this much (and before its
// start by the same, for a chunk that straddles the press).
export const HIGHLIGHT_MIC_OVERLAP_SLACK_MS = 1500;

export function isMicFinalInsideHighlight(
  micTimestamp: number | undefined,
  highlight: Pick<TranscriptSegment, "timestamp" | "endTimestamp">
): boolean {
  if (micTimestamp === undefined || highlight.timestamp === undefined) return false;
  const end = highlight.endTimestamp ?? highlight.timestamp;
  return (
    micTimestamp >= highlight.timestamp - HIGHLIGHT_MIC_OVERLAP_SLACK_MS &&
    micTimestamp <= end + HIGHLIGHT_MIC_OVERLAP_SLACK_MS
  );
}

// Live finals are inserted by capture timestamp. An incoming final without a
// timestamp goes to the end (`?? Infinity`); an existing row without one sorts
// as 0. Strict `>` keeps equal timestamps in arrival order.
export function insertSegmentByTimestamp(
  segments: TranscriptSegment[],
  seg: TranscriptSegment
): { segments: TranscriptSegment[]; index: number } {
  const ts = seg.timestamp ?? Infinity;
  let i = segments.length;
  while (i > 0 && (segments[i - 1].timestamp ?? 0) > ts) i--;
  const next =
    i === segments.length
      ? [...segments, seg]
      : [...segments.slice(0, i), seg, ...segments.slice(i)];
  return { segments: next, index: i };
}

export function reduceMeetingSegmentEvent(
  state: MeetingSegmentState,
  event: MeetingSegmentEvent,
  deps: MeetingSegmentReducerDeps
): MeetingSegmentReduction {
  if (event.type === "retract") {
    const removed: TranscriptSegment[] = [];
    const segments = state.segments.filter((seg) => {
      const hit =
        seg.source === event.source && seg.timestamp === event.timestamp && seg.text === event.text;
      if (hit) removed.push(seg);
      return !hit;
    });
    return { kind: "retract", state: { ...state, segments }, removed };
  }

  if (event.type === "partial") {
    if (event.source === "highlight") {
      return { kind: "partial", source: event.source, state };
    }
    const patch =
      event.source === "mic" ? { micPartial: event.text } : { systemPartial: event.text };
    return { kind: "partial", source: event.source, state: { ...state, ...patch } };
  }

  // A mic final arriving after its highlight: drop it, and its partial with it.
  if (
    event.source === "mic" &&
    state.segments.some(
      (seg) => seg.source === "highlight" && isMicFinalInsideHighlight(event.timestamp, seg)
    )
  ) {
    return { kind: "suppressed", state: { ...state, micPartial: "" } };
  }

  const isHighlight = event.source === "highlight";
  const raw = normalizeTranscriptSegment({
    id: deps.mintSegmentId(),
    text: event.text,
    source: event.source,
    timestamp: event.timestamp,
    // The note owner recorded it, so it is theirs; no diarization cluster.
    ...(isHighlight ? { speaker: "you" } : {}),
    ...(isHighlight && event.endTimestamp !== undefined
      ? { endTimestamp: event.endTimestamp }
      : {}),
  });
  const inserted = deps.decorateFinal(raw);
  // A highlight arriving after the mic's copy of it: remove that copy.
  const removed = isHighlight
    ? state.segments.filter(
        (seg) => seg.source === "mic" && isMicFinalInsideHighlight(seg.timestamp, inserted)
      )
    : [];
  const kept = removed.length
    ? state.segments.filter((seg) => !removed.includes(seg))
    : state.segments;
  const { segments, index } = insertSegmentByTimestamp(kept, inserted);
  const partialPatch = isHighlight
    ? {}
    : event.source === "mic"
      ? { micPartial: "" }
      : { systemPartial: "" };
  return {
    kind: "final",
    inserted,
    index,
    removed,
    state: { ...state, segments, ...partialPatch },
  };
}

// Main never learns which mic finals the reducer dropped, so a diarization
// result hands them back; without this they would be merged in again as
// unmatched rows.
export function dropMicCopiesOfHighlights<
  T extends Pick<TranscriptSegment, "source" | "timestamp">,
>(
  existing: Pick<TranscriptSegment, "source" | "timestamp" | "endTimestamp">[],
  incoming: T[]
): T[] {
  const highlights = existing.filter((seg) => seg.source === "highlight");
  if (!highlights.length) return incoming;
  return incoming.filter(
    (seg) =>
      seg.source !== "mic" ||
      !highlights.some((highlight) => isMicFinalInsideHighlight(seg.timestamp, highlight))
  );
}
