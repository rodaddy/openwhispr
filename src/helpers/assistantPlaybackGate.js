// The dictation mic runs with echo cancellation OFF by design (#476, #472), so
// while the assistant is speaking out loud the mic hears the assistant. Preview
// audio captured then is the assistant's own voice, never the user's, so it is
// dropped outright rather than buffered — buffering would only transcribe it
// late. The tail covers the speaker/mic latency after playback ends.
const ASSISTANT_PLAYBACK_TAIL_MS = 400;

function createAssistantPlaybackGate(tailMs = ASSISTANT_PLAYBACK_TAIL_MS) {
  let playing = false;
  let playingUntil = 0;
  return {
    markPlaying(now) {
      playing = true;
      playingUntil = now + tailMs;
    },
    markStopped(now) {
      playing = false;
      playingUntil = now + tailMs;
    },
    shouldDropAudio(now) {
      return playing || now < playingUntil;
    },
  };
}

module.exports = { createAssistantPlaybackGate, ASSISTANT_PLAYBACK_TAIL_MS };
