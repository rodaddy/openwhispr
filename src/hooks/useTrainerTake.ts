import { useCallback, useEffect, useRef } from "react";
import AudioManager from "../helpers/audioManager";

/** How a trainer take ends: its raw words, a discard, or an error. */
export type TrainerTakeResult = { rawText: string } | { discarded: true } | { error: string };
export type TrainerTakeStart = { ok: true } | { error: string };

type TranscriptionResult = { success?: boolean; text?: string; rawText?: string };

interface Take {
  promise: Promise<TrainerTakeResult>;
  settle: (result: TrainerTakeResult) => void;
}

function newTake(): Take {
  let settle!: (result: TrainerTakeResult) => void;
  const promise = new Promise<TrainerTakeResult>((resolve) => (settle = resolve));
  return { promise, settle };
}

/**
 * Records one word-trainer take at a time (#94) on its own AudioManager.
 * It never pastes and never saves history: the take only resolves to the
 * pre-cleanup text. A take does not start while global dictation is live,
 * and global dictation starting mid-take discards it so the UI asks for a redo.
 * A take stops by itself once the speech has ended (desktop#533); stopTake is
 * the manual fallback.
 */
export function useTrainerTake() {
  const managerRef = useRef<any>(null);
  const takeRef = useRef<Take | null>(null);
  // The take startTake last reserved. Unlike takeRef it is not cleared when the
  // take settles, so waitTake still returns its result if it already ended.
  const reservedRef = useRef<Take | null>(null);
  const liveRef = useRef(false);
  // A startRecording() still in flight. The take that began it may already be
  // cancelled, but the mic is not released until the start lands, so a new
  // take waits for it rather than opening a second recorder.
  const startingRef = useRef<Promise<unknown> | null>(null);
  // Bumped by every cancel, stop-without-take, dictation going live, and
  // unmount. A startTake that has not reserved its take yet (parked behind an
  // in-flight start, or awaiting the live check) has nothing in takeRef to
  // cancel, so it checks this instead before it opens the mic.
  const cancelGenRef = useRef(0);

  const finish = useCallback((result: TrainerTakeResult) => {
    const take = takeRef.current;
    if (!take) return;
    takeRef.current = null;
    take.settle(result);
  }, []);

  useEffect(() => {
    // persistHistory: false — no failed, discarded, or completed row ever
    // reaches history from a trainer take.
    // autoStopOnSilence: true — the take ends by itself once the speech has
    // ended, or after a stretch with no speech at all (desktop#533).
    const manager = new AudioManager({ persistHistory: false, autoStopOnSilence: true });
    managerRef.current = manager;
    manager.setCallbacks({
      onStateChange: () => {},
      onError: (error: { description?: string; title?: string } | undefined) =>
        finish({ error: error?.description || error?.title || "The take failed" }),
      // A silent take (the speech gate's silence skip, or a recording too short
      // to keep) completes with empty text; it ends as "No speech heard" (#533).
      onTranscriptionComplete: (result: TranscriptionResult) => {
        const rawText = result?.rawText ?? result?.text ?? "";
        finish(rawText.trim() ? { rawText } : { error: "No speech heard" });
      },
      // A provider's "no audio" and a dictionary-echo take land here instead.
      onNoAudio: () => finish({ error: "No speech heard" }),
      onPartialTranscript: () => {},
      onStreamingCommit: () => {},
      onTranslationFallback: () => {},
      onActiveMicLoss: () => {},
    });

    const apply = (live: boolean) => {
      liveRef.current = live;
      if (live) cancelGenRef.current += 1;
      if (live && takeRef.current) {
        manager.cancelRecording();
        finish({ discarded: true });
      }
    };
    const unsubscribe = window.electronAPI?.onDictationLiveChanged?.(apply);
    window.electronAPI
      ?.getDictationLive?.()
      .then(apply)
      .catch(() => {});

    return () => {
      unsubscribe?.();
      cancelGenRef.current += 1;
      finish({ discarded: true });
      managerRef.current = null;
      manager.cleanup();
    };
  }, [finish]);

  const startTake = useCallback(async (): Promise<TrainerTakeStart> => {
    const manager = managerRef.current;
    if (!manager) return { error: "The recorder is not ready" };
    if (takeRef.current) return { error: "a take is already running" };
    const gen = cancelGenRef.current;
    const cancelled = () => gen !== cancelGenRef.current || managerRef.current !== manager;
    while (startingRef.current) await startingRef.current;
    if (cancelled()) {
      return { error: liveRef.current ? "dictation is running" : "The take was cancelled" };
    }
    const live =
      liveRef.current || (await window.electronAPI?.getDictationLive?.().catch(() => false));
    if (live) return { error: "dictation is running" };
    if (cancelled()) return { error: "The take was cancelled" };
    if (takeRef.current || startingRef.current) return { error: "a take is already running" };
    const take = newTake();
    takeRef.current = take;
    reservedRef.current = take;
    const starting = Promise.resolve()
      .then(() => manager.startRecording())
      .catch(() => false);
    startingRef.current = starting;
    const started = await starting;
    startingRef.current = null;
    // The take ended while the mic was opening (closed, dictation went live,
    // unmounted): the cancel then could not stop a recorder that had not
    // started yet, so release the one that just did.
    if (takeRef.current !== take && started !== false) {
      manager.cancelRecording();
      return { error: liveRef.current ? "dictation is running" : "The take was cancelled" };
    }
    if (started === false) {
      finish({ error: "The take could not start recording" });
      return { error: "The take could not start recording" };
    }
    return { ok: true };
  }, [finish]);

  const stopTake = useCallback((): Promise<TrainerTakeResult> => {
    const take = takeRef.current;
    if (!take) {
      cancelGenRef.current += 1;
      return Promise.resolve({ discarded: true });
    }
    managerRef.current?.stopRecording();
    return take.promise;
  }, []);

  /** Resolves with the result of the take startTake last reserved, however it ends. */
  const waitTake = useCallback(
    (): Promise<TrainerTakeResult> =>
      reservedRef.current?.promise ?? Promise.resolve({ discarded: true }),
    []
  );

  /** Drops a running take (the dialog closed): mic off, the take settles discarded. */
  const cancelTake = useCallback(() => {
    cancelGenRef.current += 1;
    if (!takeRef.current) return;
    managerRef.current?.cancelRecording();
    finish({ discarded: true });
  }, [finish]);

  return { startTake, stopTake, waitTake, cancelTake };
}
