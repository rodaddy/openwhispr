import { useCallback, useEffect, useRef, useState } from "react";

export interface LocalVoiceStatus {
  localAvailable?: boolean;
  engineInstalled?: boolean;
  weightsInstalled?: boolean;
  weightsDownloading?: boolean;
  weightsPercentage?: number;
}

type DownloadResult = { success: boolean; code?: string };

/** A failure the user should read. A cancel or a download already running is not one. */
export type LocalVoiceWeightsError = "disk-full" | "checksum" | "failed";

const toErrorCode = (code: string | undefined): LocalVoiceWeightsError | null => {
  if (code === "cancelled" || code === "in-progress") return null;
  if (code === "disk-full" || code === "checksum") return code;
  return "failed";
};

/**
 * The local voice weights (945 MB) for the Settings page: what is installed,
 * and a download that runs only when `start` is called (#630).
 */
export function useLocalVoiceWeights() {
  const [status, setStatus] = useState<LocalVoiceStatus | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [percentage, setPercentage] = useState(0);
  const [errorCode, setErrorCode] = useState<LocalVoiceWeightsError | null>(null);
  const mountedRef = useRef(true);
  // True while this mount waits for its own download request to be answered.
  const runningRef = useRef(false);
  // True from the moment a download is followed until its end is handled, once.
  const followingRef = useRef(false);
  // True once the followed download has reported a percentage of its own.
  const heardProgressRef = useRef(false);
  // Counts the downloads this hook has seen end. A status read or a click's
  // reply that began under an earlier count may not change the download state.
  const epochRef = useRef(0);

  // Reads the status and settles it against what the hook believes: a running
  // download is followed, and a followed one the status no longer knows has
  // ended without this hook hearing it.
  const refresh = useCallback(async () => {
    const epoch = epochRef.current;
    try {
      const profile = await window.electronAPI?.getAssistantSpeechProfile?.();
      if (!mountedRef.current || !profile) return profile;
      setStatus(profile);
      // A download ended while this read was pending: what it says about a
      // running download is about the one that is over.
      if (epoch !== epochRef.current) return profile;
      if (profile.weightsDownloading) {
        followingRef.current = true;
        setDownloading(true);
        const reported = profile.weightsPercentage;
        if (
          !heardProgressRef.current &&
          typeof reported === "number" &&
          Number.isFinite(reported)
        ) {
          setPercentage(Math.round(reported));
        }
      } else if (followingRef.current && !runningRef.current) {
        followingRef.current = false;
        heardProgressRef.current = false;
        setDownloading(false);
      }
      return profile;
    } catch {
      // The status stays as it was; the next refresh reads it again.
      return undefined;
    }
  }, []);

  // The end of a download arrives twice for the window that started it (the
  // awaited result and the terminal event); only the first one is handled.
  const finish = useCallback(
    async (result: DownloadResult) => {
      if (!followingRef.current) return;
      followingRef.current = false;
      heardProgressRef.current = false;
      epochRef.current += 1;
      // The click that started it may still wait for its reply; the next click
      // must not wait with it.
      runningRef.current = false;
      if (!mountedRef.current) return;
      setDownloading(false);
      if (!result.success) {
        setErrorCode(toErrorCode(result.code));
        return;
      }
      // Before the refresh, so a failed refresh cannot bring the button back.
      setStatus((current) => ({ ...current, weightsInstalled: true }));
      await refresh();
    },
    [refresh]
  );

  // One subscription for the life of the mount, made before the first status
  // read, so no download can end between the read and the subscribe.
  useEffect(() => {
    mountedRef.current = true;
    // Main sends every progress event of a run before that run's terminal
    // event, on one ordered channel, so a progress event after a terminal
    // event belongs to a new download.
    const unsubscribe = window.electronAPI?.onAssistantSpeechWeightsProgress?.((event) => {
      if ("done" in event) {
        void finish(event);
        return;
      }
      // A percentage means a download runs, whoever started it.
      if (!mountedRef.current || !Number.isFinite(event.percentage)) return;
      followingRef.current = true;
      heardProgressRef.current = true;
      setDownloading(true);
      setPercentage(Math.round(event.percentage));
    });
    void refresh();
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
    };
  }, [refresh, finish]);

  const start = useCallback(async () => {
    const download = window.electronAPI?.downloadAssistantSpeechWeights;
    if (runningRef.current || followingRef.current || !download) return;
    const epoch = epochRef.current;
    runningRef.current = true;
    followingRef.current = true;
    setErrorCode(null);
    // The percentage is left as it is: a partial file is resumed, and a click
    // answered "in-progress" must not reset what is shown.
    setDownloading(true);

    let result: DownloadResult;
    try {
      result = await download();
    } catch {
      result = { success: false, code: "failed" };
    }
    // The download this click asked for already ended on its terminal event:
    // the reply is late and must not end or fail a newer download.
    if (epoch !== epochRef.current) return;
    runningRef.current = false;
    // Another window or an earlier mount owns the download: keep following it.
    if (result.code === "in-progress") return;
    await finish(result);
  }, [finish]);

  const cancel = useCallback(() => {
    void window.electronAPI?.cancelAssistantSpeechWeightsDownload?.();
  }, []);

  return { status, downloading, percentage, errorCode, start, cancel, refresh };
}
