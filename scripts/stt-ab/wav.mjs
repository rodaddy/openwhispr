// WAV conversion for the STT A/B replay. ffmpeg writes to a temp path
// beside the target and the file is renamed into place only on success, so a
// failed or interrupted conversion never leaves a partial WAV for the next
// model to reuse.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// run(target) converts into target and returns { status, stderr, error }.
export function convertToWav(out, run) {
  if (fs.existsSync(out)) return out;
  const tmp = `${out}.${process.pid}.partial.wav`;
  try {
    const r = run(tmp);
    // error is set when the binary could not start at all (status and stderr are null)
    if (r.status !== 0)
      throw new Error(`ffmpeg failed: ${r.error?.message ?? String(r.stderr ?? "").slice(0, 200)}`);
    fs.renameSync(tmp, out);
    return out;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function ffmpegRunner(ffmpeg, src) {
  return (target) =>
    spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", target], {
      stdio: ["ignore", "ignore", "pipe"],
    });
}
