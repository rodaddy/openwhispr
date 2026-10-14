import { useEffect, useRef } from "react";
import { getSettings } from "../stores/settingsStore";
import type { PolicyDecisionSnapshot } from "../stores/policyRules";
import type { GrillQuestionEditorResult } from "../types/electron";
import { usePolicySnapshot } from "./usePolicy";
import { callNoteModel } from "../services/brainDumps/noteModel";
import {
  dueRoundupSlots,
  recordRoundupFailure,
  resolveRoundupTimes,
  roundupSince,
  runRoundup,
  type RoundupFailures,
  type RoundupLastRuns,
  type RoundupSlot,
  type RoundupTimes,
} from "../services/brainDumps/roundups";
import logger from "../utils/logger";

const LAST_RUNS_KEY = "brainDumpRoundupLastRuns";
const FAILURES_KEY = "brainDumpRoundupFailures";
const CURSOR_KEY = "brainDumpRoundupCursor";
export const ROUNDUP_SAVED_EVENT = "brain-dump-roundup-saved";

function readObject(key: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const readLastRuns = (): RoundupLastRuns => readObject(LAST_RUNS_KEY);
const readFailures = (): RoundupFailures => readObject(FAILURES_KEY);

function readCursor(): number | undefined {
  const cursor = Number(localStorage.getItem(CURSOR_KEY));
  return Number.isInteger(cursor) && cursor > 0 ? cursor : undefined;
}

export function roundupTimes(): RoundupTimes {
  const settings = getSettings();
  return resolveRoundupTimes({
    morning: settings.brainDumpRoundupMorning,
    night: settings.brainDumpRoundupNight,
  });
}

const unwrap = <T>(result: GrillQuestionEditorResult<T> | undefined) => {
  if (!result) throw new Error("Brain dumps are unavailable");
  if ("error" in result) throw new Error(result.error);
  return result;
};

let busy = false;

/** Runs one roundup slot now and records it. Returns null if one is already running. */
export async function runRoundupSlot(slot: RoundupSlot, policyState: PolicyDecisionSnapshot) {
  if (busy) return null;
  busy = true;
  try {
    const now = new Date();
    const outcome = await runRoundup(slot, {
      now: () => now,
      since: roundupSince(readLastRuns(), now),
      afterNoteId: readCursor(),
      context: async (sinceIso, afterNoteId) =>
        unwrap(await window.electronAPI.brainDumpsRoundupContext?.(sinceIso, afterNoteId)),
      summarize: (systemPrompt, content) => callNoteModel(policyState, systemPrompt, content),
      save: async (title, content) => {
        unwrap(await window.electronAPI.brainDumpsSaveRoundup?.(title, content));
      },
    });
    localStorage.setItem(
      LAST_RUNS_KEY,
      JSON.stringify({ ...readLastRuns(), [slot]: now.toISOString() })
    );
    if (Number.isInteger(outcome.lastNoteId)) {
      localStorage.setItem(CURSOR_KEY, String(outcome.lastNoteId));
    }
    const { [slot]: _cleared, ...failures } = readFailures();
    localStorage.setItem(FAILURES_KEY, JSON.stringify(failures));
    if (outcome.saved) window.dispatchEvent(new Event(ROUNDUP_SAVED_EVENT));
    return outcome;
  } finally {
    busy = false;
  }
}

// Mounted once, in the dictation window (App.jsx), which main.js always creates,
// so it runs while the app runs, even on a hidden or login launch.
// Checks on mount and every minute, which also catches up after sleep or a late launch.
export function useBrainDumpRoundups() {
  const policyState = usePolicySnapshot();
  const policyRef = useRef(policyState);
  policyRef.current = policyState;

  useEffect(() => {
    const tick = async () => {
      const now = new Date();
      for (const slot of dueRoundupSlots(now, roundupTimes(), readLastRuns(), readFailures())) {
        try {
          await runRoundupSlot(slot, policyRef.current);
        } catch (error) {
          // Counted, so dueRoundupSlots backs off and gives up for the day.
          const failures = recordRoundupFailure(readFailures(), slot, new Date(), roundupTimes());
          localStorage.setItem(FAILURES_KEY, JSON.stringify(failures));
          logger.warn(
            "brain-dump roundup failed",
            { slot, tries: failures[slot]?.tries, error: String(error) },
            "brain-dumps"
          );
          return;
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 60_000);
    return () => clearInterval(timer);
  }, []);
}
