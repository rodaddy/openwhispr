const os = require("os");
const fs = require("fs");
const path = require("path");

let cachedSafeTempDir = null;

function hasProblematicChars(dir) {
  return !/^[\x21-\x7E]*$/.test(dir);
}

// Ordered candidate temp dirs. The base is <userData>/tmp when the data folder
// is known, else the system temp. On Windows, falls back to ProgramData when the
// base contains spaces or non-ASCII characters, as many native binaries
// (whisper-server, ffmpeg) don't handle these paths correctly.
function tempDirCandidates({ userDataDir, platform, systemTemp, env = {} }) {
  const base =
    typeof userDataDir === "string" && userDataDir.length > 0
      ? path.join(userDataDir, "tmp")
      : systemTemp;
  if (platform !== "win32" || !hasProblematicChars(base)) return [base];
  return [
    path.join(env.ProgramData || "C:\\ProgramData", "OpenWhispr", "temp"),
    path.join(env.SystemDrive || "C:", "OpenWhispr", "temp"),
    base,
  ];
}

// Pure: returns the preferred temp dir, creates nothing.
function resolveSafeTempDir(opts) {
  return tempDirCandidates(opts)[0];
}

// Returns a safe temp directory for native binaries on Windows.
// Falls back to ProgramData when TEMP contains spaces or non-ASCII characters,
// as many native binaries (whisper-server, ffmpeg) don't handle these paths correctly.
function getSafeTempDir() {
  if (cachedSafeTempDir) return cachedSafeTempDir;

  let userDataDir;
  try {
    const { app } = require("electron");
    userDataDir = app && typeof app.getPath === "function" ? app.getPath("userData") : null;
  } catch {
    userDataDir = null;
  }

  const systemTemp = os.tmpdir();
  const fromUserData = typeof userDataDir === "string" && userDataDir.length > 0;
  const candidates = tempDirCandidates({
    userDataDir,
    platform: process.platform,
    systemTemp,
    env: process.env,
  });

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Cache only a userData-based dir, so a call before boot sets the data
      // folder does not pin the system temp for the whole run.
      if (fromUserData) cachedSafeTempDir = dir;
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return systemTemp;
}

module.exports = { getSafeTempDir, resolveSafeTempDir };
