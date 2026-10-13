// The spoken grill's turn loop: speak the question, listen for the answer,
// transcribe it, send it, wait for the next question. Pure over its deps so
// every transition is testable; useGrillVoiceLoop wires the real speech,
// mic, and transcription in.

/**
 * speaking / listening / transcribing / thinking (waiting on the interviewer),
 * paused, waiting (push-to-talk: auto-listen is off), failed (a take did not
 * transcribe; retry or type), ended.
 */
export type GrillLoopPhase =
  | "idle"
  | "speaking"
  | "listening"
  | "transcribing"
  | "thinking"
  | "paused"
  | "waiting"
  | "failed"
  | "ended";

export interface GrillLoopState {
  phase: GrillLoopPhase;
  paused: boolean;
  muted: boolean;
  pushToTalk: boolean;
  /** The last transcription error while phase is "failed". */
  error: string | null;
}

export type GrillListenOutcome<A> =
  { kind: "answer"; audio: A } | { kind: "no-speech" } | { kind: "aborted" };

/**
 * A failure hands back what a retry should transcribe (the saved take) and
 * where that take's audio is kept on disk, if it was saved.
 */
export type GrillTranscribeOutcome<A> =
  { ok: true; text: string } | { ok: false; error: string; retry?: A; audioPath?: string };

/** answer-lost: a take failed to transcribe after End or an unmount (a toast; the chat may be gone). */
export type GrillLoopNotice =
  | "speech-failed"
  | "listen-failed"
  | "still-there"
  | "transcription-failed"
  | "answer-skipped"
  | "answer-lost";

/**
 * The line a saved grill note carries for an answer that failed to transcribe
 * after End or an unmount. Part of the note, so not translated.
 */
export function grillLostAnswerLine(audioPath?: string): string {
  return audioPath
    ? `(An answer could not be transcribed; audio kept at ${audioPath})`
    : "(An answer could not be transcribed; no audio was kept)";
}

/**
 * The line a saved grill note carries for an answer still transcribing when
 * End or an unmount stopped waiting (answerWaitMs). Part of the note, so not
 * translated.
 */
export function grillOrphanedAnswerLine(audioPath?: string): string {
  return audioPath
    ? `(An answer was still transcribing when the grill ended; audio kept at ${audioPath})`
    : "(An answer was still being saved when the grill ended; its audio path will be in the log)";
}

/**
 * Where a take orphaned before its audio was saved ended up: the kept file,
 * or null with the reason when the audio never reached disk.
 */
export interface GrillLateAudio {
  audioPath: string | null;
  error?: string;
}

/**
 * One take being transcribed. The transcriber records where the take's audio
 * is saved; the loop marks it orphaned when End or an unmount stopped waiting
 * for it, so a later success keeps the audio (the note points at it).
 */
export interface GrillTakeState {
  orphaned: boolean;
  audioPath?: string;
}

/**
 * The abort reason that asks listen to end the take and hand back what it has
 * (Pause). Any other abort drops the take (Skip, End, a new question).
 */
export const GRILL_FINISH_TAKE = "grill-finish-take";

/** How long End or an unmount waits for an answer that is still transcribing. */
export const GRILL_ANSWER_WAIT_MS = 30_000;

export interface GrillVoiceLoopDeps<A> {
  /** Resolves when playback ends; rejects when synthesis or playback fails. */
  speak: (text: string, signal: AbortSignal) => Promise<void>;
  /** Records one answer with end-of-turn detection. */
  listen: (signal: AbortSignal) => Promise<GrillListenOutcome<A>>;
  /**
   * The global dictation hotkey's state: whether a dictation is live, and how
   * many have started. A take that overlaps one heard speech meant for another
   * app, so it is never a grill answer (#80).
   */
  dictation?: () => { active: boolean; count: number };
  transcribe: (audio: A, take: GrillTakeState) => Promise<GrillTranscribeOutcome<A>>;
  /** Sends the transcript as Rico's answer; the interviewer's reply comes back through question(). */
  sendAnswer: (text: string) => unknown;
  /** Asks the interviewer for the next question without answering this one. */
  requestNextQuestion: () => unknown;
  /** The session's existing save-and-leave. */
  endSession: () => unknown;
  /**
   * Called when a take starts transcribing, or when Pause starts closing one
   * (before the recorder hands it back). The promise resolves to the answer
   * text when the loop ended (End, unmount) before it could send it, so the
   * save puts it in the turns; otherwise to null. If answerWaitMs after End
   * or an unmount the take is still going, it resolves to
   * grillOrphanedAnswerLine and the take is orphaned.
   */
  holdAnswer?: (answer: Promise<string | null>) => void;
  /**
   * The text of an orphaned take that transcribed after the save stopped
   * waiting for it. Never in the note; log it without its text. A take
   * orphaned before its audio was saved always comes here (text may be ""),
   * with audio saying where its kept file is, since the note could not.
   */
  lateAnswer?: (text: string, audio?: GrillLateAudio) => unknown;
  /** Defaults to GRILL_ANSWER_WAIT_MS. */
  answerWaitMs?: number;
  /** A visible line in the chat. */
  notice: (kind: GrillLoopNotice, detail?: string) => void;
  stillThereText: string;
  onChange?: (state: GrillLoopState) => void;
}

export interface GrillVoiceLoop {
  state: () => GrillLoopState;
  /** The interviewer asked a question (the opening one or a reply). */
  question: (text: string) => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  setMuted: (muted: boolean) => void;
  setPushToTalk: (pushToTalk: boolean) => void;
  /** Transcribes the failed take again. */
  retry: () => void;
  /** Rico answered by typing or dictating: stop listening and wait for the next question. */
  answeredByText: () => void;
  end: () => void;
  /** Stops without saving (the view is going away; the session's own unmount saves). */
  dispose: () => void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createGrillVoiceLoop<A>(deps: GrillVoiceLoopDeps<A>): GrillVoiceLoop {
  const state: GrillLoopState = {
    phase: "idle",
    paused: false,
    muted: false,
    pushToTalk: false,
    error: null,
  };
  // The question awaiting an answer, and whether it has been read out.
  let current: { text: string; spoken: boolean } | null = null;
  let failedTake: A | null = null;
  let step: AbortController | null = null;

  const emit = () => deps.onChange?.({ ...state });
  const setPhase = (phase: GrillLoopPhase) => {
    state.phase = phase;
    emit();
  };
  // Starts a new step, aborting whatever step was running.
  const nextStep = () => {
    step?.abort();
    step = new AbortController();
    return step;
  };
  const stopStep = () => {
    step?.abort();
    step = null;
  };
  const live = (controller: AbortController) => step === controller && !controller.signal.aborted;
  // The chat side reports its own send and save errors; a rejection here must
  // not surface as an unhandled one.
  const detach = (run: () => unknown) => {
    void Promise.resolve()
      .then(run)
      .catch(() => {});
  };
  // A step that finished on its own: release it without aborting it.
  const settle = (controller: AbortController) => {
    if (step === controller) step = null;
  };

  // The answer a take being transcribed (or closing after Pause) will give,
  // handed to the session in case the loop ends before it is sent. It settles
  // when the take does, or answerWaitMs after End or an unmount, whichever
  // comes first.
  // A hold whose wait ran out is orphaned: its take's line is already in the
  // note, and whatever the take does later changes nothing there.
  type Hold = {
    settle: (text: string | null) => void;
    startWait: () => void;
    take: GrillTakeState;
    /** Orphaned before its audio was saved: the note could not name the file. */
    pathUnnoted?: boolean;
  };
  const held = new Set<Hold>();
  // A take Pause is closing: its answer is held from the moment of the abort,
  // so End or an unmount before MediaRecorder stops still waits for it.
  const closing = new Map<AbortController, Hold>();
  const holdAnswer = (): Hold => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveAnswer: (text: string | null) => void = () => {};
    const answer = new Promise<string | null>((resolve) => (resolveAnswer = resolve));
    const hold: Hold = {
      take: { orphaned: false },
      settle: (text: string | null) => {
        clearTimeout(timer);
        held.delete(hold);
        resolveAnswer(text);
      },
      startWait: () => {
        timer ??= setTimeout(() => {
          if (!held.has(hold)) return;
          hold.take.orphaned = true;
          const audioPath = hold.take.audioPath;
          hold.pathUnnoted = !audioPath;
          hold.settle(grillOrphanedAnswerLine(audioPath));
          deps.notice("answer-lost", audioPath);
        }, deps.answerWaitMs ?? GRILL_ANSWER_WAIT_MS);
      },
    };
    held.add(hold);
    deps.holdAnswer?.(answer);
    return hold;
  };
  const startWaits = () => held.forEach((hold) => hold.startWait());
  const takeClosing = (controller: AbortController) => {
    const hold = closing.get(controller) ?? null;
    closing.delete(controller);
    return hold;
  };

  const transcribe = async (audio: A, existingHold?: Hold | null) => {
    // Not abortable: once a take is recorded it is always transcribed and sent.
    stopStep();
    if (state.phase !== "ended") setPhase("transcribing");
    const hold = existingHold ?? holdAnswer();
    if (state.phase === "ended") hold.startWait();
    const settleHeld = hold.settle;
    let outcome: GrillTranscribeOutcome<A>;
    try {
      outcome = await deps.transcribe(audio, hold.take);
    } catch (error) {
      outcome = { ok: false, error: errorText(error), retry: audio };
    }
    const text = "text" in outcome ? outcome.text.trim() : "";
    // The wait ran out first: the note already says so and keeps the audio.
    if (hold.take.orphaned) {
      if (hold.pathUnnoted) {
        // The note points at the log, so the kept file's path goes there.
        const audioPath = hold.take.audioPath ?? null;
        const audio: GrillLateAudio = audioPath
          ? { audioPath }
          : { audioPath: null, error: "audio not saved" };
        detach(() => deps.lateAnswer?.(audioPath ? text : "", audio));
      } else if (text) detach(() => deps.lateAnswer?.(text));
      return;
    }
    // Ended (End or unmount) while this take transcribed: the session's save
    // puts the answer in the turns instead of sending it to the interviewer.
    // A take that failed there leaves a visible line in the note, and a toast.
    if (state.phase === "ended") {
      if (text) {
        settleHeld(text);
        return;
      }
      const audioPath = "audioPath" in outcome ? outcome.audioPath : undefined;
      settleHeld(grillLostAnswerLine(audioPath));
      deps.notice("answer-lost", audioPath);
      return;
    }
    settleHeld(null);
    if (text) {
      failedTake = null;
      state.error = null;
      current = null;
      setPhase("thinking");
      detach(() => deps.sendAnswer(text));
      return;
    }
    const error = "error" in outcome ? outcome.error : "No words were recognized";
    failedTake = "retry" in outcome && outcome.retry !== undefined ? outcome.retry : audio;
    state.error = error;
    setPhase("failed");
    deps.notice("transcription-failed", error);
  };

  const listen = async () => {
    if (state.paused || state.phase === "ended") return;
    if (state.pushToTalk) {
      stopStep();
      setPhase("waiting");
      return;
    }
    const controller = nextStep();
    setPhase("listening");
    const dictationBefore = deps.dictation?.();
    let outcome: GrillListenOutcome<A>;
    try {
      outcome = await deps.listen(controller.signal);
    } catch (error) {
      takeClosing(controller)?.settle(null);
      // No mic: the question stays on screen and Rico types or dictates.
      if (!live(controller)) return;
      settle(controller);
      setPhase("waiting");
      deps.notice("listen-failed", errorText(error));
      return;
    }
    // The grill takes answers only from its own voice loop: a take that
    // overlapped a global-hotkey dictation is dropped, never transcribed.
    const dictationAfter = deps.dictation?.();
    const foreign =
      outcome.kind === "answer" &&
      dictationBefore !== undefined &&
      dictationAfter !== undefined &&
      (dictationBefore.active ||
        dictationAfter.active ||
        dictationAfter.count !== dictationBefore.count);
    // Pause ends the take (GRILL_FINISH_TAKE): what was captured is still
    // transcribed, even if Resume or End came in while the take closed.
    const closingHold = takeClosing(controller);
    if (foreign) {
      closingHold?.settle(null);
      if (!live(controller)) return;
      settle(controller);
      await listen();
      return;
    }
    if (outcome.kind === "answer" && controller.signal.reason === GRILL_FINISH_TAKE) {
      await transcribe(outcome.audio, closingHold);
      return;
    }
    closingHold?.settle(null);
    if (!live(controller) || outcome.kind === "aborted") return;
    settle(controller);
    if (outcome.kind === "no-speech") {
      state.paused = true;
      setPhase("paused");
      deps.notice("still-there");
      if (!state.muted) {
        const ask = nextStep();
        try {
          await deps.speak(deps.stillThereText, ask.signal);
        } catch {
          // The notice already says it on screen.
        }
        settle(ask);
      }
      return;
    }
    await transcribe(outcome.audio);
  };

  const ask = async () => {
    if (!current || state.paused || state.phase === "ended") return;
    if (state.muted || current.spoken) {
      current.spoken = true;
      await listen();
      return;
    }
    const controller = nextStep();
    const asked = current;
    setPhase("speaking");
    try {
      await deps.speak(asked.text, controller.signal);
    } catch (error) {
      if (!live(controller)) return;
      deps.notice("speech-failed", errorText(error));
    }
    if (!live(controller)) return;
    settle(controller);
    asked.spoken = true;
    await listen();
  };

  return {
    state: () => ({ ...state }),
    question(text) {
      if (state.phase === "ended") return;
      current = { text, spoken: false };
      failedTake = null;
      state.error = null;
      if (state.paused) {
        stopStep();
        setPhase("paused");
        return;
      }
      void ask();
    },
    pause() {
      if (state.phase === "ended" || state.paused) return;
      state.paused = true;
      // A take being transcribed, or an answer the interviewer is reading,
      // carries on; only speaking and listening stop. A take being recorded
      // ends here and is still sent; the next question then waits for Resume.
      if (state.phase === "listening" && step) {
        closing.set(step, holdAnswer());
        step.abort(GRILL_FINISH_TAKE);
        setPhase("paused");
      } else if (
        state.phase === "speaking" ||
        state.phase === "listening" ||
        state.phase === "waiting"
      ) {
        stopStep();
        setPhase("paused");
      } else emit();
    },
    resume() {
      if (state.phase === "ended" || !state.paused) return;
      state.paused = false;
      if (state.phase === "paused") {
        stopStep();
        if (current) void ask();
        else setPhase("thinking");
      } else emit();
    },
    skip() {
      if (state.phase === "ended") return;
      // A take being recorded is dropped, and the chat says so.
      const dropped = state.phase === "listening";
      stopStep();
      if (dropped) deps.notice("answer-skipped");
      current = null;
      failedTake = null;
      state.error = null;
      setPhase("thinking");
      detach(deps.requestNextQuestion);
    },
    setMuted(muted) {
      if (state.muted === muted) return;
      state.muted = muted;
      if (muted && state.phase === "speaking" && current) {
        current.spoken = true;
        void listen();
      } else emit();
    },
    setPushToTalk(pushToTalk) {
      if (state.pushToTalk === pushToTalk) return;
      state.pushToTalk = pushToTalk;
      if (pushToTalk && state.phase === "listening") {
        stopStep();
        setPhase("waiting");
      } else if (!pushToTalk && state.phase === "waiting") {
        void listen();
      } else emit();
    },
    retry() {
      if (state.phase !== "failed" || failedTake === null) return;
      void transcribe(failedTake);
    },
    answeredByText() {
      if (state.phase === "ended") return;
      stopStep();
      current = null;
      failedTake = null;
      state.error = null;
      setPhase("thinking");
    },
    end() {
      if (state.phase === "ended") return;
      stopStep();
      current = null;
      setPhase("ended");
      startWaits();
      detach(deps.endSession);
    },
    dispose() {
      stopStep();
      current = null;
      state.phase = "ended";
      startWaits();
    },
  };
}
