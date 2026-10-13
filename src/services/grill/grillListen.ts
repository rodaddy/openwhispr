// Records one spoken grill answer from the mic and ends it with the energy
// detector (turnDetector.ts): RMS over 30ms frames read from an analyser. The
// recording itself is a MediaRecorder take, the same format the chat's voice
// draft sends through the transcription pipeline.
import {
  createTurnDetector,
  frameRms,
  GRILL_TURN_DEFAULTS,
  type TurnDetectorConfig,
} from "./turnDetector";
import { GRILL_FINISH_TAKE, type GrillListenOutcome } from "./grillVoiceLoop";

export interface GrillListenOptions {
  signal: AbortSignal;
  /** An exact input device, or undefined for the system default. */
  deviceId?: string;
  detector?: Partial<TurnDetectorConfig>;
}

export async function recordGrillAnswer({
  signal,
  deviceId,
  detector: overrides,
}: GrillListenOptions): Promise<GrillListenOutcome<Blob>> {
  if (signal.aborted) return { kind: "aborted" };
  const config = { ...GRILL_TURN_DEFAULTS, ...overrides };
  const stopTracks = (media: MediaStream) => media.getTracks().forEach((track) => track.stop());
  // Listen for an abort before the mic opens: an abort while it opens answers
  // at once, and the mic is released the moment it does open.
  let onOpeningAbort: () => void = () => {};
  const abortedWhileOpening = new Promise<null>((resolve) => {
    onOpeningAbort = () => resolve(null);
    signal.addEventListener("abort", onOpeningAbort, { once: true });
  });
  const opening = navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  let stream: MediaStream | null;
  try {
    stream = await Promise.race([opening, abortedWhileOpening]);
  } finally {
    signal.removeEventListener("abort", onOpeningAbort);
  }
  if (!stream) {
    opening.then(stopTracks, () => {});
    return { kind: "aborted" };
  }
  if (signal.aborted) {
    stopTracks(stream);
    return { kind: "aborted" };
  }
  const media = stream;
  const context = new AudioContext();
  const source = context.createMediaStreamSource(media);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  // Chrome only fills the analyser when the graph reaches the destination.
  const sink = context.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(context.destination);

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(media, { mimeType: "audio/webm;codecs=opus" });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const samples = new Float32Array(analyser.fftSize);
  const frameSamples = Math.min(
    samples.length,
    Math.round((context.sampleRate * config.frameMs) / 1000)
  );
  const turn = createTurnDetector(config);

  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (outcome: "answer" | "no-speech" | "aborted") => {
      if (done) return;
      done = true;
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      // Only an answer keeps its audio; a no-speech or aborted take is dropped.
      const release = () => {
        stopTracks(media);
        context.close().catch(() => {});
        if (outcome === "answer") {
          resolve({ kind: "answer", audio: new Blob(chunks, { type: "audio/webm" }) });
        } else resolve({ kind: outcome });
      };
      recorder.onstop = release;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    };
    // Pause asks for the take so far (GRILL_FINISH_TAKE); it is kept once
    // speech was heard. Any other abort drops it.
    const onAbort = () =>
      finish(signal.reason === GRILL_FINISH_TAKE && turn.speechStarted() ? "answer" : "aborted");
    signal.addEventListener("abort", onAbort);

    recorder.start(1000);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      // The newest frameMs of audio: the tail of the analyser's window.
      const event = turn.push(frameRms(samples.subarray(samples.length - frameSamples)));
      if (event === "end" || event === "cap") finish("answer");
      else if (event === "no-speech") finish("no-speech");
    }, config.frameMs);
  });
}
