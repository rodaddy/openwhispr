import { useLayoutEffect, useRef, useState } from "react";
import { getListeningEntranceTimeline } from "../helpers/voicePillPresentation";

export type ListeningEntrancePhase = "idle" | "thinking" | "expanding" | "settled" | "waveform";

/**
 * Drives the recording pill's entrance choreography (thinking → expanding →
 * settled → waveform). The main pill and the Agent companion pill share this
 * single timeline so their entrances can never drift apart (recording-visual
 * ownership guarantees only one of them runs it at a time).
 */
export function useListeningEntrancePhase(
  isRecording: boolean,
  options?: {
    /** The recording starts under the open assistant panel, whose footer must
     *  finish handing final actions back to the pill before the expansion may
     *  begin — this stretches the thinking hold past that handoff. Sampled at
     *  the recording edge, so a panel closing mid-recording cannot restart
     *  the entrance. */
    afterAssistantFooterHandoff?: boolean;
    /** #563: the pill is showing the arming look for a start still opening
     *  the mic. A recording edge straight out of arming skips the staged
     *  entrance — arming already drew the expanded listening pill. */
    isArming?: boolean;
  }
): ListeningEntrancePhase {
  const [phase, setPhase] = useState<ListeningEntrancePhase>("idle");
  const afterFooterRef = useRef(options?.afterAssistantFooterHandoff ?? false);
  afterFooterRef.current = options?.afterAssistantFooterHandoff ?? false;
  // The previous commit's arming flag: on the recording edge the caller has
  // already dropped isArming, so the edge must read what was on screen.
  const wasArmingRef = useRef(false);
  const isArming = options?.isArming ?? false;

  useLayoutEffect(() => {
    if (!isRecording) {
      setPhase("idle");
      return undefined;
    }

    const timeline = getListeningEntranceTimeline({
      afterAssistantFooterHandoff: afterFooterRef.current,
      fromArming: wasArmingRef.current,
    });
    if (timeline.waveformAtMs === 0) {
      setPhase("waveform");
      return undefined;
    }
    setPhase("thinking");
    const expansionTimer = setTimeout(() => setPhase("expanding"), timeline.expandAtMs);
    const settledTimer = setTimeout(() => setPhase("settled"), timeline.settleAtMs);
    const waveformTimer = setTimeout(() => setPhase("waveform"), timeline.waveformAtMs);
    return () => {
      clearTimeout(expansionTimer);
      clearTimeout(settledTimer);
      clearTimeout(waveformTimer);
    };
  }, [isRecording]);

  // Declared after the edge effect so that effect still sees the old value.
  useLayoutEffect(() => {
    wasArmingRef.current = isArming && !isRecording;
  }, [isArming, isRecording]);

  // The edge render itself must not paint the collapsed thinking frame first.
  if (isRecording && phase === "idle" && wasArmingRef.current) return "waveform";
  return phase;
}
