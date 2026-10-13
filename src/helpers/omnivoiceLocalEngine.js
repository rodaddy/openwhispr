/**
 * Local OmniVoice engine: owns the lifecycle of the kept-open `omnivoice-tts` sidecar (spawn,
 * one-at-a-time queue, idle stop, abort, timeout, crash recovery) and the framing of its output.
 * One child at a time: a new one starts only after the old one has exited.
 * `stop()` is final: afterwards the engine refuses requests, ignores resets and reports unavailable.
 *
 * Measured facts about the sidecar:
 * - `--stream-by-line -o -` stays alive on stdin; each newline-terminated line is one utterance.
 * - stdout carries one WAV per line: a 44-byte header with placeholder sizes, then 24 kHz mono s16le.
 * - It flushes stdout after every audio write and logs `[TTS-Stream] Done` on stderr after the last
 *   flush: once that line is readable, all of the chunk's audio is already in the stdout pipe.
 * - A line longer than 750 codepoints is rendered as several chunks, each with its own Done line, so
 *   the engine never sends one: long text goes out as several shorter lines (omnivoiceFraming.js).
 */

const childProcess = require("child_process");
const fs = require("fs");
const {
  splitForSidecar,
  parseSidecarWav,
  buildWav,
  MAX_LINE_CODEPOINTS,
} = require("./omnivoiceFraming");

const DONE_MARKER = "[TTS-Stream] Done";
const STDERR_TAIL_LINES = 20;
const STDERR_PARTIAL_MAX_CHARS = 4096;
const GRACEFUL_EXIT_MS = 2000;
// The sidecar renders a longer line as several chunks; no setting may raise the line limit past it.
const SIDECAR_CHUNK_CODEPOINTS = 750;

function abortError() {
  const error = new Error("Local speech aborted");
  error.name = "AbortError";
  return error;
}

const isPath = (value) => typeof value === "string" && value.length > 0;

function createOmnivoiceLocalEngine(options = {}) {
  const {
    spawnImpl = childProcess.spawn,
    existsSync = fs.existsSync,
    setImmediateImpl = setImmediate,
    binaryPath,
    modelPath,
    codecPath,
    steps = 16,
    seed = 42,
    lang = "English",
    idleMs = 600000,
    requestTimeoutMs = 120000,
    settleMs = 40,
    maxLineCodepoints = MAX_LINE_CODEPOINTS,
    onSpawn,
    onExit,
  } = options;

  const queue = [];
  // Every child that has not exited yet: the kept-open one plus any still shutting down.
  const live = new Set();
  let active = null;
  let current = null;
  let idleTimer = null;
  let resetPending = false;
  let stopped = false;

  function isAvailable() {
    if (stopped) return false;
    return [binaryPath, modelPath, codecPath].every(
      (filePath) => !!filePath && existsSync(filePath)
    );
  }

  function exitedError(record, reason) {
    const lastLine = record.stderrTail[record.stderrTail.length - 1] || "";
    return new Error(`Local speech process exited (${reason}): ${lastLine}`);
  }

  function kill(record) {
    if (record.gone) return;
    try {
      record.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  // Graceful stop: close stdin so the sidecar leaves its read loop, kill it if it lingers.
  function retire() {
    const record = active;
    if (!record) return;
    active = null;
    try {
      record.child.stdin.end();
    } catch {
      // Already gone.
    }
    record.graceTimer = setTimeout(() => kill(record), GRACEFUL_EXIT_MS);
    record.graceTimer.unref?.();
  }

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    if (idleMs <= 0 || !active || idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!current && queue.length === 0) retire();
    }, idleMs);
    idleTimer.unref?.();
  }

  function release(request) {
    clearTimeout(request.settleTimer);
    clearTimeout(request.timeoutTimer);
    if (request.signal) request.signal.removeEventListener("abort", request.onAbort);
  }

  // Fails the in-flight request and drops its child: the stream position is unknown from here on.
  function abandon(request, error) {
    const record = request.record;
    release(request);
    current = null;
    if (active === record) active = null;
    request.reject(error);
    kill(record);
    pump();
  }

  // Writes the request's next line; the timeout is per segment, so it is re-armed here.
  function writeSegment(request) {
    const record = request.record;
    request.chunks = [];
    request.markerSeen = false;
    request.stdoutSeq += 1;
    clearTimeout(request.timeoutTimer);
    request.timeoutTimer = setTimeout(() => {
      if (current === request) abandon(request, new Error("Local speech timed out"));
    }, requestTimeoutMs);
    try {
      record.child.stdin.write(`${request.segments[request.segmentIndex]}\n`);
    } catch {
      if (current === request) abandon(request, exitedError(record, "stdin closed"));
    }
  }

  function finishSegment(request) {
    if (current !== request) return;
    let parsed;
    try {
      parsed = parseSidecarWav(Buffer.concat(request.chunks));
    } catch (error) {
      abandon(request, error);
      return;
    }
    if (!request.header) request.header = parsed.header;
    request.pcmParts.push(parsed.pcm);
    request.segmentIndex += 1;
    if (request.segmentIndex < request.segments.length) {
      writeSegment(request);
      return;
    }
    release(request);
    current = null;
    request.resolve(buildWav(request.header, request.pcmParts));
    pump();
  }

  function armSettle(request) {
    clearTimeout(request.settleTimer);
    request.settleTimer = setTimeout(() => {
      // When the main process was blocked for longer than settleMs, the next loop turn runs this
      // expired timer BEFORE it reads the pipes, so the segment's last bytes may still be unread.
      // The immediate runs after that turn's pipe reads; a chunk read in between re-armed the timer.
      const seq = request.stdoutSeq;
      setImmediateImpl(() => {
        if (current === request && request.stdoutSeq === seq) finishSegment(request);
      });
    }, settleMs);
  }

  function onStdout(record, chunk) {
    if (current && current.record === record) {
      current.chunks.push(chunk);
      current.stdoutSeq += 1;
      if (current.markerSeen) armSettle(current);
      return;
    }
    // Audio nobody asked for: the kept-open child's stream position is unknown, so drop it.
    if (record !== active) return;
    active = null;
    kill(record);
  }

  function onStderr(record, chunk) {
    const lines = (record.stderrPartial + chunk.toString("utf8")).split(/[\r\n]+/);
    record.stderrPartial = lines.pop().slice(-STDERR_PARTIAL_MAX_CHARS);
    for (const line of lines) {
      if (!line) continue;
      record.stderrTail.push(line);
      if (record.stderrTail.length > STDERR_TAIL_LINES) record.stderrTail.shift();
      // The sidecar logs the marker as a line of its own; text that merely contains it is not it.
      if (!line.trimEnd().endsWith(DONE_MARKER)) continue;
      if (!current || current.record !== record || current.markerSeen) continue;
      current.markerSeen = true;
      armSettle(current);
    }
  }

  function onGone(record, reason) {
    if (record.gone) return;
    record.gone = true;
    clearTimeout(record.graceTimer);
    live.delete(record);
    if (active === record) active = null;
    if (onExit) {
      try {
        onExit(record.child);
      } catch {
        // A throwing callback changes nothing here.
      }
    }
    if (current && current.record === record) {
      const request = current;
      release(request);
      current = null;
      request.reject(exitedError(record, reason));
    }
    pump();
  }

  function spawnChild(request) {
    const child = spawnImpl(
      binaryPath,
      [
        "--model",
        modelPath,
        "--codec",
        codecPath,
        "--ref-wav",
        request.referenceWavPath,
        "--ref-text",
        request.referenceTextPath,
        "--lang",
        lang,
        "--steps",
        String(steps),
        "--seed",
        String(seed),
        "--stream-by-line",
        "-o",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }
    );
    const record = {
      child,
      key: request.key,
      stderrTail: [],
      stderrPartial: "",
      graceTimer: null,
      gone: false,
    };
    live.add(record);
    child.stdout.on("data", (chunk) => onStdout(record, chunk));
    child.stderr.on("data", (chunk) => onStderr(record, chunk));
    // A broken pipe leaves the stream position unknown: kill, the exit handler owns the failure.
    for (const stream of [child.stdout, child.stderr]) {
      if (typeof stream.on === "function") stream.on("error", () => kill(record));
    }
    child.on("exit", (code, signal) => onGone(record, code ?? signal));
    child.on("error", (error) => {
      // No pid: the process never started and no exit will follow. With a pid it may still be
      // running (a failed kill, a pipe error), so it stays tracked: kill it, its exit owns the rest.
      if (child.pid === undefined) {
        onGone(record, (error && (error.code || error.message)) || "error");
        return;
      }
      kill(record);
    });
    // A write racing the child's death surfaces as EPIPE here; the exit handler owns that failure.
    if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", () => {});
    return record;
  }

  function pump() {
    if (current) return;
    if (resetPending) {
      resetPending = false;
      retire();
    }
    const request = queue[0];
    if (!request) {
      armIdle();
      return;
    }
    if (active && active.key !== request.key) retire();
    // A retired child still alive holds the queue: its exit pumps again, the grace kill bounds it.
    if (!active && live.size > 0) return;
    queue.shift();
    const spawned = !active;
    if (spawned) {
      try {
        active = spawnChild(request);
      } catch (error) {
        release(request);
        const reason = (error && (error.code || error.message)) || "error";
        request.reject(new Error(`Local speech process exited (${reason}): `));
        pump();
        return;
      }
    }

    current = request;
    request.record = active;
    // Called with the request in flight, so an abort or a stop() from inside it is honoured.
    if (spawned && onSpawn) {
      try {
        onSpawn(active.child);
      } catch {
        // A throwing callback changes nothing here: the child stays tracked.
      }
      if (current !== request) return;
    }
    writeSegment(request);
  }

  function synthesize({ text, referenceWavPath, referenceTextPath, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (stopped) {
        reject(new Error("Local speech stopped"));
        return;
      }
      const segments = splitForSidecar(text, Math.min(maxLineCodepoints, SIDECAR_CHUNK_CODEPOINTS));
      if (segments.length === 0) {
        reject(new Error("Speech text is required"));
        return;
      }
      if (!isPath(referenceWavPath) || !isPath(referenceTextPath)) {
        reject(new Error("Reference clip is required"));
        return;
      }
      if (!isAvailable()) {
        reject(new Error("Local speech is not installed"));
        return;
      }
      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }

      const request = {
        segments,
        segmentIndex: 0,
        key: `${referenceWavPath}\n${referenceTextPath}`,
        referenceWavPath,
        referenceTextPath,
        signal,
        resolve,
        reject,
        // Per segment: the raw stdout bytes and whether its Done line was seen.
        chunks: [],
        markerSeen: false,
        // Bumped on every stdout chunk and every line written; a settle immediate checks it.
        stdoutSeq: 0,
        // Across segments: the first header, then every segment's PCM in order.
        header: null,
        pcmParts: [],
        settleTimer: null,
        timeoutTimer: null,
        record: null,
        onAbort: null,
      };
      request.onAbort = () => {
        if (current === request) {
          abandon(request, abortError());
          return;
        }
        const index = queue.indexOf(request);
        if (index === -1) return;
        queue.splice(index, 1);
        release(request);
        request.reject(abortError());
      };
      if (signal) signal.addEventListener("abort", request.onAbort, { once: true });

      clearIdle();
      queue.push(request);
      pump();
    });
  }

  function reset() {
    if (stopped) return;
    if (current) {
      resetPending = true;
      return;
    }
    clearIdle();
    retire();
  }

  function stop() {
    stopped = true;
    clearIdle();
    resetPending = false;
    const pending = current ? [current, ...queue] : [...queue];
    current = null;
    queue.length = 0;
    active = null;
    for (const request of pending) {
      release(request);
      request.reject(new Error("Local speech stopped"));
    }
    for (const record of [...live]) {
      clearTimeout(record.graceTimer);
      kill(record);
    }
  }

  function getStatus() {
    return { running: active !== null, queued: queue.length, busy: current !== null };
  }

  return { isAvailable, synthesize, reset, stop, getStatus };
}

module.exports = { createOmnivoiceLocalEngine, DONE_MARKER };
