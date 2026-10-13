// Fallback mode: both channels must stay quiet this long before proposing a stop.
const SILENCE_WINDOW_MS = 120_000;
// Fallback mode after the tracked meeting app exits — a much stronger signal.
const FAST_SILENCE_MS = 30_000;
// A mic release must stay uncontradicted this long before it proposes a stop.
// The OS reports a release for things that are not the call ending: a device
// flap emits MIC_STOP and MIC_START in one reconcile pass, an app rebuilds its
// input unit when screen share starts, and an app that drops the mic on mute
// looks identical to one that left the call. A recording that stopped
// mid-sentence on 2026-10-13 is why this waits a full minute.
const OWNERSHIP_CONFIRM_MS = 60_000;
// An external mic hold shorter than this (Siri, a permission prompt, the Sound
// settings input meter) is incidental — it must not arm the mic-ignoring
// ownership path on what is really an in-person recording.
const OWNERSHIP_MIN_ACTIVE_MS = 30_000;
// A tick gap longer than this means the machine slept; silence accumulated
// before the gap is stale and must not stop the recording on wake.
const TICK_GAP_MS = 5_000;
// Each proposal withdrawn by renewed activity holds the next one off for longer
// (1, 2, 4... minutes, capped), so a noisy room after a call does not flash the
// card every minute, while a real end still gets asked about.
const WITHDRAW_BACKOFF_MS = 60_000;
const WITHDRAW_BACKOFF_MAX_MS = 15 * 60_000;

// Two evidence sources decide "the meeting is over":
//
// The controller never stops anything itself: it proposes a stop (onPropose) and
// the owner asks the user. While a proposal is open, renewed activity on either
// channel or the external mic coming back withdraws it (onCancel).
//
//   ownership — an external app held the mic and released it. Propose only once the
//     release has held for OWNERSHIP_CONFIRM_MS with the SYSTEM channel also
//     quiet throughout (remote voices still playing means the call is live, e.g.
//     an app that releases the mic on mute). The mic channel is deliberately
//     ignored here so room noise after the call cannot mask the end.
//   fallback — ownership is unreliable, or no external app ever held the mic
//     this session. Both channels quiet for the silence window proposes; a tracked
//     meeting app exiting shortens the window.
//
// Tick-driven and timer-free: every input updates state and re-evaluates; the
// owner calls tick() about once a second. This keeps sleep handling correct.
const createMeetingAutoEndController = ({ now = Date.now, onPropose, onCancel = () => {} }) => {
  let session = null;
  let lastSeenAt = null;

  const isLive = (sessionId) =>
    session !== null && session.sessionId === sessionId && session.eligible;

  const observeClock = () => {
    const nowMs = now();
    const gap = lastSeenAt === null ? 0 : nowMs - lastSeenAt;
    lastSeenAt = nowMs;
    if (gap > TICK_GAP_MS && session) {
      // A card nobody could have seen across a sleep must not stop the recording
      // on wake.
      withdraw(nowMs, "clock-gap");
      session.quietSince = nowMs;
      session.fastArmAt = null;
      session.ownershipQuietSince = null;
      if (session.externalMicActive) {
        // Ownership observed before sleep is stale. Count it again from wake so
        // a release delivered with the first resumed poll cannot stop at once.
        session.externalMicActiveSince = nowMs;
      } else {
        session.mode = "fallback";
        session.externalMicActiveSince = null;
      }
    }
    return nowMs;
  };

  const resetClocks = (nowMs) => {
    session.quietSince = nowMs;
    session.fastArmAt = null;
    session.ownershipQuietSince = null;
  };

  const propose = (reason) => {
    const { sessionId, mode, micActive, systemActive, externalMicActive } = session;
    session.proposed = reason;
    onPropose(sessionId, reason, { mode, micActive, systemActive, externalMicActive });
  };

  // Renewed activity withdraws an open proposal and starts the windows over.
  const withdraw = (nowMs, trigger) => {
    if (!session.proposed) return;
    const reason = session.proposed;
    session.proposed = null;
    resetClocks(nowMs);
    // Only the room disagreeing counts toward backoff; a sleep or lost mic
    // evidence is not that.
    if (trigger !== "clock-gap" && trigger !== "mic-unreliable") {
      const backoffMs = Math.min(
        WITHDRAW_BACKOFF_MS * 2 ** session.withdrawals,
        WITHDRAW_BACKOFF_MAX_MS
      );
      session.withdrawals += 1;
      session.suppressUntil = Math.max(session.suppressUntil, nowMs + backoffMs);
    }
    onCancel(session.sessionId, reason, trigger);
  };

  const evaluate = () => {
    if (!session || !session.eligible || session.proposed) return;
    const nowMs = now();

    // The user has just told us the meeting is still live (Keep recording, or a
    // restart): hold every stop path and keep the quiet clocks reset, so the
    // grace expiring cannot propose instantly.
    if (nowMs < session.suppressUntil) {
      resetClocks(nowMs);
      return;
    }

    if (session.mode === "ownership") {
      // Any contradicting evidence — the mic coming back, or remote audio
      // resuming — restarts the window rather than merely deferring the stop.
      if (session.externalMicActive || session.systemActive) {
        session.ownershipQuietSince = null;
        return;
      }
      if (session.ownershipQuietSince === null) session.ownershipQuietSince = nowMs;
      if (nowMs - session.ownershipQuietSince >= OWNERSHIP_CONFIRM_MS) propose("mic-released");
      return;
    }

    if (session.micActive || session.systemActive) return;
    const fastArmed = session.fastArmAt !== null;
    const quietStart = fastArmed
      ? Math.max(session.quietSince, session.fastArmAt)
      : session.quietSince;
    const windowMs = fastArmed ? FAST_SILENCE_MS : SILENCE_WINDOW_MS;
    if (nowMs - quietStart >= windowMs) propose(fastArmed ? "process-exit" : "silence");
  };

  const beginSession = ({
    sessionId,
    eligible,
    reliable,
    externalMicActive,
    micActive = false,
    systemActive = false,
    suppressUntil = 0,
  }) => {
    const nowMs = now();
    lastSeenAt = nowMs;
    const ownership = eligible && reliable && externalMicActive;
    session = {
      sessionId,
      eligible: eligible === true,
      mode: ownership ? "ownership" : "fallback",
      externalMicActive: ownership,
      externalMicActiveSince: ownership ? nowMs : null,
      micActive,
      systemActive,
      quietSince: nowMs,
      fastArmAt: null,
      ownershipQuietSince: null,
      suppressUntil,
      proposed: null,
      withdrawals: 0,
    };
    evaluate();
  };

  const handleExternalMicState = ({ sessionId, reliable, externalMicActive }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;

    if (!reliable) {
      // The ownership evidence behind a mic-released proposal is gone.
      if (session.proposed === "mic-released") withdraw(nowMs, "mic-unreliable");
      session.mode = "fallback";
      session.externalMicActive = false;
      session.externalMicActiveSince = null;
      session.quietSince = nowMs;
      session.fastArmAt = null;
      evaluate();
      return;
    }

    if (externalMicActive) {
      if (!session.externalMicActive) {
        session.externalMicActiveSince = nowMs;
        withdraw(nowMs, "external-mic");
      }
      session.externalMicActive = true;
      session.mode = "ownership";
      session.fastArmAt = null;
      evaluate();
      return;
    }

    if (session.mode === "ownership" && session.externalMicActive) {
      session.externalMicActive = false;
      const heldMs = nowMs - session.externalMicActiveSince;
      session.externalMicActiveSince = null;
      if (heldMs < OWNERSHIP_MIN_ACTIVE_MS) {
        session.mode = "fallback";
        session.quietSince = nowMs;
      }
    }
    evaluate();
  };

  const handleAudioActivity = ({ sessionId, micActive, systemActive }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;
    const micBecameActive = micActive && !session.micActive;
    const systemBecameActive = systemActive && !session.systemActive;
    const wasQuiet = !session.micActive && !session.systemActive;
    session.micActive = micActive;
    session.systemActive = systemActive;
    // Either channel withdraws, ownership mode included: the proposal is a
    // question to someone who may be talking, and a stop they never saw loses
    // audio. The mic tail is short, so ongoing speech keeps producing edges.
    if (micBecameActive || systemBecameActive) {
      withdraw(nowMs, systemBecameActive ? "system-activity" : "mic-activity");
    }

    if (session.mode === "fallback" && (micBecameActive || systemBecameActive)) {
      session.fastArmAt = null;
    }
    if (!wasQuiet && !micActive && !systemActive) session.quietSince = nowMs;
    evaluate();
  };

  const handleMeetingProcessExit = ({ sessionId }) => {
    const nowMs = observeClock();
    if (!isLive(sessionId) || session.mode !== "fallback") return;
    session.fastArmAt = nowMs;
    evaluate();
  };

  // The user answered Keep recording: hold every path until `untilMs` and
  // start the windows over, with no new session and no lost audio.
  const suppress = (sessionId, untilMs) => {
    const nowMs = observeClock();
    if (!isLive(sessionId)) return;
    session.proposed = null;
    session.withdrawals = 0;
    session.suppressUntil = untilMs;
    resetClocks(nowMs);
  };

  const endSession = (sessionId) => {
    if (!session || session.sessionId !== sessionId) return;
    session = null;
  };

  const tick = () => {
    observeClock();
    evaluate();
  };

  return {
    beginSession,
    handleExternalMicState,
    handleAudioActivity,
    handleMeetingProcessExit,
    suppress,
    endSession,
    tick,
  };
};

module.exports = createMeetingAutoEndController;
module.exports.SILENCE_WINDOW_MS = SILENCE_WINDOW_MS;
module.exports.FAST_SILENCE_MS = FAST_SILENCE_MS;
module.exports.OWNERSHIP_MIN_ACTIVE_MS = OWNERSHIP_MIN_ACTIVE_MS;
module.exports.OWNERSHIP_CONFIRM_MS = OWNERSHIP_CONFIRM_MS;
module.exports.TICK_GAP_MS = TICK_GAP_MS;
module.exports.WITHDRAW_BACKOFF_MS = WITHDRAW_BACKOFF_MS;
module.exports.WITHDRAW_BACKOFF_MAX_MS = WITHDRAW_BACKOFF_MAX_MS;
