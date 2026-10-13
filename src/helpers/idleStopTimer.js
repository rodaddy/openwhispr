// Counts in-flight users of a resource and fires `onIdle` once it has been
// unused for `idleMs`. Pure: timers and the clock are injected so tests never
// wait.

const MIN_IDLE_SECONDS = 30;
// setTimeout treats a longer delay as 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Seconds (from an env var) -> milliseconds. "0" disables the idle stop.
function resolveIdleMs(envValue, defaultSeconds = 600) {
  const defaultMs = defaultSeconds * 1000;
  if (envValue === undefined || envValue === null) return defaultMs;
  const raw = String(envValue).trim();
  if (raw === "") return defaultMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return defaultMs;
  if (seconds === 0) return 0;
  if (seconds < MIN_IDLE_SECONDS) return MIN_IDLE_SECONDS * 1000;
  return seconds * 1000;
}

function createIdleStopTimer({
  idleMs,
  onIdle,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = Date.now,
}) {
  const enabled = Number.isFinite(idleMs) && idleMs > 0;
  let active = 0;
  let handle = null;
  // When the idle period ends. Only a period longer than one timer can hold
  // needs it: its timer fires early and is re-armed for the remainder.
  let deadline = 0;

  const cancel = () => {
    if (handle === null) return;
    clearTimeoutImpl(handle);
    handle = null;
  };

  const fire = () => {
    handle = null;
    if (active !== 0) return;
    try {
      // An onIdle failure must never surface as an unhandled rejection.
      Promise.resolve(onIdle()).catch(() => {});
    } catch {}
  };

  const schedule = (delayMs, onFire) => {
    handle = setTimeoutImpl(onFire, delayMs);
    // An idle stop must never keep the process alive.
    handle?.unref?.();
  };

  // A capped timer fired: the period is over only once the deadline has passed.
  const fireCapped = () => {
    handle = null;
    if (active !== 0) return;
    const remaining = deadline - now();
    if (remaining <= 0) return fire();
    // Re-checked every time, the last stretch included: a clock set back
    // during the wait must not end the period early.
    schedule(Math.min(remaining, MAX_TIMER_MS), fireCapped);
  };

  const arm = () => {
    if (!enabled || active !== 0) return;
    cancel();
    if (idleMs > MAX_TIMER_MS) {
      deadline = now() + idleMs;
      schedule(MAX_TIMER_MS, fireCapped);
    } else {
      schedule(idleMs, fire);
    }
  };

  return {
    begin() {
      if (!enabled) return;
      active += 1;
      cancel();
    },
    end() {
      if (!enabled) return;
      if (active > 0) active -= 1;
      if (active === 0) arm();
    },
    arm,
    cancel,
    activeCount: () => active,
  };
}

module.exports = { createIdleStopTimer, resolveIdleMs };
