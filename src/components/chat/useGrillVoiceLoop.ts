import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import logger from "../../utils/logger";
import { useSettings } from "../../hooks/useSettings";
import { resolvePreferredMicrophone } from "../../helpers/microphoneSelection";
import { transcribeFile } from "../../services/fileTranscription";
import { recordGrillAnswer } from "../../services/grill/grillListen";
import { grillSpeechVoice, type GrillVoice } from "../../services/grill/grillVoices";
import {
  createGrillVoiceLoop,
  type GrillLateAudio,
  type GrillLoopNotice,
  type GrillLoopState,
  type GrillTakeState,
  type GrillTranscribeOutcome,
  type GrillVoiceLoop,
} from "../../services/grill/grillVoiceLoop";
import { useTranscriptionConfig } from "./useTranscriptionConfig";

const OWNER_ID = "grill";

/** A recorded answer: the take itself, or the saved file a failed take left behind. */
type GrillTake = { blob?: Blob; path?: string };

/**
 * A take's temp audio is deleted only once it transcribed and was not
 * orphaned (the saved note then points at the file). Anything else keeps it.
 */
export function shouldDeleteTempAudio({ ok, orphaned }: { ok: boolean; orphaned: boolean }) {
  return ok && !orphaned;
}

/** The file and model calls a take's transcription makes. */
export interface GrillTakeIo {
  saveTempAudio: (audio: ArrayBuffer) => Promise<{ path?: string }>;
  deleteTempAudio: (path: string) => Promise<unknown>;
  transcribeFile: (path: string) => Promise<{ success?: boolean; text?: string; error?: string }>;
}

/**
 * Saves the take (unless it is already on disk), transcribes it, and deletes
 * the temp audio per shouldDeleteTempAudio. The saved path goes into state
 * as soon as it exists, so a note written while this runs can point at it.
 */
export async function transcribeGrillTake(
  take: GrillTake,
  state: GrillTakeState,
  io: GrillTakeIo
): Promise<GrillTranscribeOutcome<GrillTake>> {
  let audioPath = take.path ?? null;
  if (audioPath) state.audioPath = audioPath;
  try {
    if (!audioPath) {
      if (!take.blob) return { ok: false, error: "Nothing was recorded" };
      const saved = await io.saveTempAudio(await take.blob.arrayBuffer());
      if (!saved?.path) throw new Error("The answer audio could not be saved");
      audioPath = saved.path;
      state.audioPath = audioPath;
    }
    const result = await io.transcribeFile(audioPath);
    const text = result.text?.trim();
    const ok = Boolean(result.success && text);
    if (shouldDeleteTempAudio({ ok, orphaned: state.orphaned })) {
      void Promise.resolve(io.deleteTempAudio(audioPath)).catch(() => {});
    }
    if (ok && text) return { ok: true, text };
    const error = result.error || "No words were recognized";
    // The take stays on disk for a retry; its path is in the log.
    logger.warn("Grill answer transcription failed", { audioPath, error }, "grill");
    return { ok: false, error, retry: { path: audioPath }, audioPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Grill answer transcription failed", { audioPath, error: message }, "grill");
    return audioPath
      ? { ok: false, error: message, retry: { path: audioPath }, audioPath }
      : { ok: false, error: message, retry: take };
  }
}

const abortError = () =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

// Synthesizes the question in the chosen voice and resolves when playback ends.
async function speakGrillQuestion(text: string, voice: GrillVoice, signal: AbortSignal) {
  const api = window.electronAPI;
  if (!api?.synthesizeGrillSpeech) throw new Error("Grill speech is not available");
  const requestId = crypto.randomUUID();
  const cancel = () => void api.cancelGrillSpeech?.(OWNER_ID, requestId).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await api.synthesizeGrillSpeech(
      OWNER_ID,
      requestId,
      text,
      grillSpeechVoice(voice)
    );
    if (signal.aborted) throw abortError();
    if (!result?.success || !result.audio)
      throw new Error(result?.error || "Spoken question failed");
    const bytes = Uint8Array.from(result.audio);
    const url = URL.createObjectURL(
      new Blob([bytes.buffer], { type: result.mimeType || "audio/wav" })
    );
    const audio = new Audio(url);
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          audio.pause();
          reject(abortError());
        };
        signal.addEventListener("abort", stop, { once: true });
        audio.addEventListener("ended", () => resolve(), { once: true });
        audio.addEventListener("error", () => reject(new Error("Playback failed")), {
          once: true,
        });
        audio.play().catch(reject);
      });
    } finally {
      audio.pause();
      URL.revokeObjectURL(url);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

interface UseGrillVoiceLoopOptions {
  /** A grill session is running. The loop lives exactly as long as it does. */
  active: boolean;
  voice: GrillVoice;
  sendAnswer: (text: string) => Promise<unknown>;
  requestNextQuestion: () => Promise<unknown>;
  endSession: () => Promise<unknown>;
  /** Hands the session an answer still transcribing, so End or an unmount saves it. */
  holdAnswer?: (answer: Promise<string | null>) => void;
  /**
   * An orphaned take's text, transcribed after the save; logged without the
   * text. audio: the kept file of a take orphaned before it was saved.
   */
  lateAnswer?: (text: string, audio?: GrillLateAudio) => unknown;
  notice: (kind: GrillLoopNotice, detail?: string) => void;
  stillThereText: string;
}

export interface GrillVoiceLoopControls {
  state: GrillLoopState | null;
  question: (text: string) => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  setMuted: (muted: boolean) => void;
  setPushToTalk: (pushToTalk: boolean) => void;
  retry: () => void;
  answeredByText: () => void;
  /** Ends through the loop (stopping any voice or mic) when it runs, else just leaves. */
  end: () => void;
}

/**
 * The spoken grill: each interviewer question is read in the chosen voice,
 * then the mic listens for the answer, which goes through the regular
 * transcription pipeline and is sent as Rico's turn.
 */
export function useGrillVoiceLoop(options: UseGrillVoiceLoopOptions): GrillVoiceLoopControls {
  const settings = useSettings();
  const getTranscriptionConfig = useTranscriptionConfig();
  const [state, setState] = useState<GrillLoopState | null>(null);
  const loopRef = useRef<GrillVoiceLoop | null>(null);
  // A question asked before the loop exists (the opening one) waits here.
  const pendingQuestionRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const transcribe = useCallback(
    (take: GrillTake, state: GrillTakeState) =>
      transcribeGrillTake(take, state, {
        saveTempAudio: (audio) => window.electronAPI.saveTempAudio(audio),
        deleteTempAudio: (path) => window.electronAPI.deleteTempAudio(path),
        transcribeFile: (path) => transcribeFile(path, getTranscriptionConfig(), false),
      }),
    [getTranscriptionConfig]
  );

  const listen = useCallback(async (signal: AbortSignal) => {
    const resolution = await resolvePreferredMicrophone({ settings: settingsRef.current });
    if (resolution.mode === "automatic" && !resolution.device) {
      throw new Error("No available microphone matched the automatic selection policy");
    }
    const outcome = await recordGrillAnswer({ signal, deviceId: resolution.device?.deviceId });
    return outcome.kind === "answer"
      ? { kind: "answer" as const, audio: { blob: outcome.audio } }
      : outcome;
  }, []);

  // Whether a global dictation is live (any activation mode, tap included),
  // so a take it overlapped is dropped.
  const dictationRef = useRef({ active: false, count: 0 });
  useEffect(() => {
    const apply = (active: boolean) => {
      const current = dictationRef.current;
      if (active === current.active) return;
      dictationRef.current = { active, count: current.count + (active ? 1 : 0) };
    };
    const unsubscribe = window.electronAPI?.onDictationLiveChanged?.(apply);
    window.electronAPI
      ?.getDictationLive?.()
      .then(apply)
      .catch(() => {});
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!options.active) return;
    const loop = createGrillVoiceLoop<GrillTake>({
      speak: (text, signal) => speakGrillQuestion(text, optionsRef.current.voice, signal),
      listen,
      dictation: () => ({ ...dictationRef.current }),
      transcribe,
      sendAnswer: (text) => optionsRef.current.sendAnswer(text),
      requestNextQuestion: () => optionsRef.current.requestNextQuestion(),
      endSession: () => optionsRef.current.endSession(),
      holdAnswer: (answer) => optionsRef.current.holdAnswer?.(answer),
      lateAnswer: (text, audio) => optionsRef.current.lateAnswer?.(text, audio),
      notice: (kind, detail) => optionsRef.current.notice(kind, detail),
      stillThereText: optionsRef.current.stillThereText,
      onChange: setState,
    });
    loopRef.current = loop;
    setState(loop.state());
    const pending = pendingQuestionRef.current;
    pendingQuestionRef.current = null;
    if (pending) loop.question(pending);
    return () => {
      loop.dispose();
      loopRef.current = null;
      setState(null);
    };
  }, [listen, options.active, transcribe]);

  const question = useCallback((text: string) => {
    if (loopRef.current) loopRef.current.question(text);
    else pendingQuestionRef.current = text;
  }, []);

  const end = useCallback(() => {
    if (loopRef.current) loopRef.current.end();
    else void optionsRef.current.endSession();
  }, []);

  return useMemo(
    () => ({
      state,
      question,
      pause: () => loopRef.current?.pause(),
      resume: () => loopRef.current?.resume(),
      skip: () => loopRef.current?.skip(),
      setMuted: (muted: boolean) => loopRef.current?.setMuted(muted),
      setPushToTalk: (ptt: boolean) => loopRef.current?.setPushToTalk(ptt),
      retry: () => loopRef.current?.retry(),
      answeredByText: () => loopRef.current?.answeredByText(),
      end,
    }),
    [end, question, state]
  );
}
