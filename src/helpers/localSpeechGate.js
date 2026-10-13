const SILENCE_RMS_THRESHOLD = 0.002;
const SPEECH_WINDOW_RMS_THRESHOLD = 0.003;
const SPEECH_WINDOW_PEAK_THRESHOLD = 0.02;
const STRONG_SPEECH_RMS_THRESHOLD = 0.006;

/** One analyser window counts as speech when it is both loud enough and peaky enough. */
export const isSpeechWindow = (rms, peak) =>
  rms >= SPEECH_WINDOW_RMS_THRESHOLD && peak >= SPEECH_WINDOW_PEAK_THRESHOLD;

export const createLocalSpeechGateState = () => ({
  peakRms: 0,
  peakAmplitude: 0,
  windowCount: 0,
  speechWindowCount: 0,
  consecutiveSpeechWindows: 0,
  maxConsecutiveSpeechWindows: 0,
});

export const recordLocalSpeechWindow = (state, rms, peak) => {
  if (!state) {
    return null;
  }

  state.windowCount += 1;
  state.peakRms = Math.max(state.peakRms, rms);
  state.peakAmplitude = Math.max(state.peakAmplitude, peak);

  if (!isSpeechWindow(rms, peak)) {
    state.consecutiveSpeechWindows = 0;
    return state;
  }

  state.speechWindowCount += 1;
  state.consecutiveSpeechWindows += 1;
  state.maxConsecutiveSpeechWindows = Math.max(
    state.maxConsecutiveSpeechWindows,
    state.consecutiveSpeechWindows
  );
  return state;
};

export const getLocalSpeechGateDecision = (state) => {
  if (!state?.windowCount) {
    return { skip: false, reason: "unavailable" };
  }

  const metrics = {
    peakRms: state.peakRms,
    peakAmplitude: state.peakAmplitude,
    windowCount: state.windowCount,
    speechWindowCount: state.speechWindowCount,
    maxConsecutiveSpeechWindows: state.maxConsecutiveSpeechWindows,
  };

  if (state.peakRms < SILENCE_RMS_THRESHOLD) {
    return { skip: true, reason: "silence", ...metrics };
  }

  const hasSpeech = state.speechWindowCount >= 1 || state.peakRms >= STRONG_SPEECH_RMS_THRESHOLD;

  if (!hasSpeech) {
    return { skip: true, reason: "insufficient_speech", ...metrics };
  }

  return { skip: false, reason: "speech_detected", ...metrics };
};

/**
 * End-of-speech tracker for a recording that stops by itself (desktop#533).
 * Fed one window at a time; it reports "speech_ended" once at least
 * minSpeechMs of speech (total) has been heard and trailingSilenceMs of
 * consecutive non-speech windows follow, or "no_speech" once
 * noSpeechTimeoutMs passes with less than minSpeechMs of speech. It fires at
 * most once.
 */
export const createEndOfSpeechState = ({
  trailingSilenceMs = 800,
  minSpeechMs = 200,
  noSpeechTimeoutMs = 8000,
  windowMs = 100,
} = {}) => ({
  trailingSilenceMs,
  minSpeechMs,
  noSpeechTimeoutMs,
  windowMs,
  elapsedMs: 0,
  speechMs: 0,
  trailingSilenceRunMs: 0,
  fired: false,
});

export const recordEndOfSpeechWindow = (state, isSpeech) => {
  if (!state || state.fired) {
    return null;
  }

  state.elapsedMs += state.windowMs;
  if (isSpeech) {
    state.speechMs += state.windowMs;
    state.trailingSilenceRunMs = 0;
    return null;
  }

  state.trailingSilenceRunMs += state.windowMs;
  if (state.speechMs >= state.minSpeechMs) {
    if (state.trailingSilenceRunMs >= state.trailingSilenceMs) {
      state.fired = true;
      return "speech_ended";
    }
    return null;
  }

  // A cough or click (less than minSpeechMs) counts as no speech, so it
  // cannot hold the take open forever.
  if (state.elapsedMs >= state.noSpeechTimeoutMs) {
    state.fired = true;
    return "no_speech";
  }
  return null;
};
