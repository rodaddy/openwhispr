import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../utils/logger";

export function useAssistantSpeech(eligible: boolean, ownerId = "assistant-panel") {
  const activeRef = useRef<{ requestId: string; audio?: HTMLAudioElement; url?: string } | null>(
    null
  );
  const generationRef = useRef(0);
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;
  const [error, setError] = useState("");
  const stop = useCallback(() => {
    generationRef.current += 1;
    const active = activeRef.current;
    activeRef.current = null;
    if (!active) return;
    active.audio?.pause();
    // Main gates dictation preview audio on this flag, so a stop must clear it
    // or preview capture stays deaf for as long as the app runs (#78).
    window.electronAPI.setAssistantSpeechPlaying?.(false);
    if (active.url) URL.revokeObjectURL(active.url);
    void window.electronAPI.cancelAssistantSpeech(ownerId, active.requestId).catch(() => {});
  }, [ownerId]);
  const captureGeneration = useCallback(() => generationRef.current, []);
  const speak = useCallback(
    async (text: string, expectedGeneration = generationRef.current) => {
      if (expectedGeneration !== generationRef.current) {
        logger.debug("Spoken reply skipped: stale generation", { ownerId }, "speech");
        return false;
      }
      if (!eligibleRef.current || !text.trim()) {
        logger.debug(
          "Spoken reply skipped: not eligible",
          { ownerId, eligible: eligibleRef.current, empty: !text.trim() },
          "speech"
        );
        return false;
      }
      stop();
      const generation = generationRef.current;
      const requestId = crypto.randomUUID();
      activeRef.current = { requestId };
      logger.debug(
        "Spoken reply synthesis requested",
        { ownerId, requestId, chars: text.length },
        "speech"
      );
      let result;
      try {
        result = await window.electronAPI.synthesizeAssistantSpeech(ownerId, requestId, text);
        logger.debug(
          "Spoken reply synthesis returned",
          {
            ownerId,
            requestId,
            success: !!result?.success,
            bytes: result?.audio?.length ?? 0,
            error: result?.error,
          },
          "speech"
        );
      } catch (synthesisError) {
        logger.error(
          "Spoken reply synthesis threw",
          {
            ownerId,
            requestId,
            error:
              synthesisError instanceof Error ? synthesisError.message : String(synthesisError),
          },
          "speech"
        );
        const ownsRequest = activeRef.current?.requestId === requestId;
        if (ownsRequest) activeRef.current = null;
        if (ownsRequest && generation === generationRef.current && eligibleRef.current) {
          setError(
            synthesisError instanceof Error ? synthesisError.message : "Spoken reply failed"
          );
        }
        return false;
      }
      if (generation !== generationRef.current || !eligibleRef.current) {
        if (activeRef.current?.requestId === requestId) activeRef.current = null;
        return false;
      }
      if (!result.success || !result.audio) {
        if (activeRef.current?.requestId === requestId) {
          activeRef.current = null;
          setError(result.error || "Spoken reply failed");
        }
        return false;
      }
      const audioBytes = Uint8Array.from(result.audio);
      const url = URL.createObjectURL(
        new Blob([audioBytes.buffer], { type: result.mimeType || "audio/wav" })
      );
      const audio = new Audio(url);
      activeRef.current = { requestId, audio, url };
      const release = () => {
        if (activeRef.current?.requestId !== requestId || activeRef.current.audio !== audio) return;
        activeRef.current = null;
        URL.revokeObjectURL(url);
        window.electronAPI.setAssistantSpeechPlaying?.(false);
      };
      audio.addEventListener("ended", release, { once: true });
      audio.addEventListener("error", release, { once: true });
      try {
        await audio.play();
        window.electronAPI.setAssistantSpeechPlaying?.(true);
        logger.debug(
          "Spoken reply playing",
          { ownerId, requestId, bytes: audioBytes.length },
          "speech"
        );
        if (
          generation === generationRef.current &&
          eligibleRef.current &&
          activeRef.current?.requestId === requestId
        )
          setError("");
      } catch (playbackError) {
        logger.error(
          "Spoken reply playback failed",
          {
            ownerId,
            requestId,
            error: playbackError instanceof Error ? playbackError.message : String(playbackError),
          },
          "speech"
        );
        audio.pause();
        const ownsRequest =
          generation === generationRef.current && activeRef.current?.requestId === requestId;
        release();
        if (ownsRequest && eligibleRef.current) {
          setError(playbackError instanceof Error ? playbackError.message : "Spoken reply failed");
        }
        return false;
      }
      return (
        generation === generationRef.current &&
        eligibleRef.current &&
        activeRef.current?.requestId === requestId
      );
    },
    [ownerId, stop]
  );
  useEffect(() => {
    if (!eligible) stop();
  }, [eligible, stop]);
  // Barge-in: a dictation recording started in any window silences us (#78).
  useEffect(() => window.electronAPI.onAssistantSpeechStop?.(() => stop()), [stop]);
  useEffect(() => stop, [stop]);
  return {
    speak,
    stop,
    captureGeneration,
    error,
    clearError: () => setError(""),
    reportError: setError,
  };
}
