// Energy-based end-of-turn detection for the spoken grill. Pure: the caller
// feeds one RMS value per frame (grillListen.ts reads them from the mic) and
// acts on the returned event. No VAD model; the rules are timing over RMS.

export interface TurnDetectorConfig {
  /** Frame length the caller measures RMS over. */
  frameMs: number;
  /** RMS at or above this counts as voice. */
  threshold: number;
  /** Continuous voice needed before the take counts as speech. */
  speechStartMs: number;
  /** Silence after speech that ends the turn. */
  endSilenceMs: number;
  /** Hard cap on one answer, from the start of listening. */
  maxAnswerMs: number;
  /** With no speech by then, the take is dropped as no-speech. */
  noSpeechTimeoutMs: number;
}

export const GRILL_TURN_DEFAULTS: Readonly<TurnDetectorConfig> = Object.freeze({
  frameMs: 30,
  // About -40 dBFS: above a quiet room through a typical USB or wireless mic,
  // well below speech at arm's length. Tune here if the mic runs hot or cold.
  threshold: 0.01,
  speechStartMs: 300,
  endSilenceMs: 1800,
  maxAnswerMs: 180_000,
  noSpeechTimeoutMs: 20_000,
});

/**
 * waiting: no speech yet. speech-start: the frame that confirmed speech.
 * speaking: in a turn. end / cap / no-speech: terminal, repeated on every later push.
 */
export type TurnEvent = "waiting" | "speech-start" | "speaking" | "end" | "cap" | "no-speech";

export interface TurnDetector {
  push: (rms: number) => TurnEvent;
  speechStarted: () => boolean;
}

export function frameRms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

export function createTurnDetector(overrides: Partial<TurnDetectorConfig> = {}): TurnDetector {
  const config = { ...GRILL_TURN_DEFAULTS, ...overrides };
  let elapsedMs = 0;
  let voicedRunMs = 0;
  let silenceMs = 0;
  let started = false;
  let terminal: TurnEvent | null = null;

  return {
    speechStarted: () => started,
    push(rms) {
      if (terminal) return terminal;
      elapsedMs += config.frameMs;
      const voiced = rms >= config.threshold;

      if (!started) {
        voicedRunMs = voiced ? voicedRunMs + config.frameMs : 0;
        if (voicedRunMs >= config.speechStartMs) {
          started = true;
          return elapsedMs >= config.maxAnswerMs ? (terminal = "cap") : "speech-start";
        }
        if (elapsedMs >= config.noSpeechTimeoutMs) return (terminal = "no-speech");
        return "waiting";
      }

      silenceMs = voiced ? 0 : silenceMs + config.frameMs;
      if (silenceMs >= config.endSilenceMs) return (terminal = "end");
      if (elapsedMs >= config.maxAnswerMs) return (terminal = "cap");
      return "speaking";
    },
  };
}
