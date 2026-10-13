const path = require("path");
const { buildVoiceBundle, readVoiceBundle, MAX_WAV_BYTES } = require("./voiceBundle");
const { readPcm16Wav, sliceWav, planClip, analyzeReference } = require("./referenceClip");

// A bundle is the reference clip plus a small manifest and transcript.
const MAX_BUNDLE_BYTES = MAX_WAV_BYTES + 2 * 1024 * 1024;
const BUNDLE_ERROR_CODES = {
  "Not a voice bundle": "not-a-bundle",
  "Unsupported voice bundle format": "unsupported-format",
  "Reference audio is too large": "too-large",
  "Reference audio must be a WAV file": "not-wav",
};

const DEFAULT_SEED = 42;
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// What the voice server is asked to render with. Its limits are seed 1 to 1000
// and steps 10 to 20 (outside them is a 422), and a bundle can carry either
// outside those, so anything unusable falls back to the pinned default.
function resolveRenderSettings(profile) {
  const language = typeof profile?.language === "string" ? profile.language.trim() : "";
  return {
    seed: inRange(profile?.seed, 1, 1000) ? profile.seed : DEFAULT_SEED,
    numSteps: inRange(profile?.numSteps, 10, 20) ? profile.numSteps : 16,
    language: language && language.length <= 16 ? language : "en",
  };
}

function createAssistantSpeechProfileStore({
  fs,
  profileDir,
  endpoint,
  chooseWav,
  chooseBundle,
  chooseBundleSavePath,
  toTranscriptionWav,
  toPcm16Wav,
  transcribe,
}) {
  const profilePath = path.join(profileDir, "profile.json");
  // The clip chosen in the dialog and not saved yet. Memory only.
  let pending = null;
  // Each choose gets the next run number; only the latest run writes pending,
  // so a choose that finishes late cannot bring back its clip.
  let analysisRun = 0;
  // The one staged write: a new reference clip first, then profile.json switched
  // by rename, so a failure before the rename leaves the previous voice in place.
  function installProfile(writeReference, profile) {
    fs.mkdirSync(profileDir, { recursive: true });
    const referenceFile = `reference-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`;
    const referencePath = path.join(profileDir, referenceFile);
    const stagedProfilePath = path.join(profileDir, `profile-${Date.now()}.json.tmp`);
    const { promptText, ...settings } = profile;
    try {
      writeReference(referencePath);
      fs.writeFileSync(
        stagedProfilePath,
        JSON.stringify({ promptText, referenceFile, ...settings }),
        "utf8"
      );
      fs.renameSync(stagedProfilePath, profilePath);
    } catch (installError) {
      // Best effort: a failed install leaves nothing behind, so a retried Save
      // does not add one more reference file each time.
      for (const stagedPath of [stagedProfilePath, referencePath]) {
        try {
          if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
        } catch {
          // The install error is the one that matters.
        }
      }
      throw installError;
    }
  }
  return {
    read() {
      if (!fs.existsSync(profilePath)) return null;
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      if (typeof profile.promptText !== "string" || !profile.promptText.trim()) return null;
      const referencePath = path.join(profileDir, profile.referenceFile || "reference.wav");
      if (!fs.existsSync(referencePath)) return null;
      return {
        endpoint,
        promptText: profile.promptText.trim(),
        referenceAudioBase64: fs.readFileSync(referencePath).toString("base64"),
        ...resolveRenderSettings(profile),
      };
    },
    // Paths for the on-device engine, which takes the transcript as a file. The
    // text file is named after the WAV, so a re-imported profile gets a new one.
    readLocalPaths() {
      if (!fs.existsSync(profilePath)) return null;
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      if (typeof profile.promptText !== "string" || !profile.promptText.trim()) return null;
      const referenceFile = profile.referenceFile || "reference.wav";
      const referenceWavPath = path.join(profileDir, referenceFile);
      if (!fs.existsSync(referenceWavPath)) return null;
      const promptText = profile.promptText.trim();
      const baseName = referenceFile.slice(
        0,
        referenceFile.length - path.extname(referenceFile).length
      );
      const referenceTextPath = path.join(profileDir, `${baseName}.txt`);
      if (
        !fs.existsSync(referenceTextPath) ||
        fs.readFileSync(referenceTextPath, "utf8") !== promptText
      ) {
        const stagedTextPath = path.join(profileDir, `${baseName}-${Date.now()}.txt.tmp`);
        try {
          // Inside the try: a write can create the file and then fail (a full disk).
          fs.writeFileSync(stagedTextPath, promptText, "utf8");
          fs.renameSync(stagedTextPath, referenceTextPath);
        } catch (stagingError) {
          // Best effort: never leave the staged file behind.
          try {
            fs.unlinkSync(stagedTextPath);
          } catch {
            // The write or rename error is the one that matters.
          }
          throw stagingError;
        }
      }
      return { referenceWavPath, referenceTextPath };
    },
    // Choose a clip and transcribe it. Nothing is written until import().
    async analyze() {
      const sourcePath = await chooseWav();
      if (!sourcePath) return { success: false, canceled: true };
      // A new choice replaces the old one, also when its analysis fails.
      const run = ++analysisRun;
      pending = null;
      let wav;
      try {
        wav = await toTranscriptionWav(sourcePath);
      } catch {
        return { success: false, code: "not-audio" };
      }
      const { durationSec } = readPcm16Wav(wav);
      const plan = planClip(durationSec);
      if (plan.kind === "too-short" || plan.kind === "too-long")
        return { success: false, code: plan.kind, durationSec };
      const fileName = path.basename(sourcePath);
      let result;
      try {
        result = await analyzeReference({ wav, transcribe });
      } catch {
        // A whole clip can still be used with a typed transcript. A windowed one
        // cannot: the window is chosen from the transcripts.
        if (plan.kind !== "whole") return { success: false, code: "transcription-failed" };
        if (run === analysisRun) pending = { sourcePath, window: null };
        return { success: true, fileName, durationSec, text: "", transcribed: false };
      }
      if (run === analysisRun) pending = { sourcePath, window: result.window ?? null };
      return {
        success: true,
        fileName,
        durationSec,
        text: result.text,
        transcribed: true,
        ...(result.window ? { window: result.window } : {}),
      };
    },
    async import(promptText, seed) {
      if (typeof promptText !== "string" || !promptText.trim())
        return { success: false, error: "Reference transcript is required" };
      let storedSeed = DEFAULT_SEED;
      if (seed !== undefined && seed !== null && seed !== "") {
        storedSeed =
          typeof seed === "string" && /^\d+$/.test(seed.trim()) ? Number(seed.trim()) : seed;
        if (!inRange(storedSeed, 1, 1000))
          return { success: false, error: "Seed must be a whole number from 1 to 1000" };
      }
      if (!pending) return { success: false, error: "Choose a reference WAV first" };
      // The clip this Save is for. A choice made while the save is in flight
      // replaces pending, and that newer choice must survive this save.
      const chosen = pending;
      const { sourcePath, window } = chosen;
      try {
        // Cut before installProfile, whose write callback is synchronous.
        const windowWav = window
          ? sliceWav(await toPcm16Wav(sourcePath), window.startSec, window.endSec)
          : null;
        installProfile(
          (referencePath) =>
            windowWav
              ? fs.writeFileSync(referencePath, windowWav)
              : fs.copyFileSync(sourcePath, referencePath),
          { promptText: promptText.trim(), seed: storedSeed }
        );
      } catch (error) {
        // The clip stays chosen, so Save can be tried again. No path in the
        // message: the underlying error names the file. Its code (ENOSPC,
        // EACCES) carries the reason without the path, for the log.
        return {
          success: false,
          error: "The chosen clip could not be saved.",
          ...(error?.code ? { code: error.code } : {}),
        };
      }
      if (pending === chosen) pending = null;
      return { success: true };
    },
    async exportBundle(name) {
      if (!fs.existsSync(profilePath)) return { success: false, error: "no-profile" };
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      if (typeof profile.promptText !== "string" || !profile.promptText.trim())
        return { success: false, error: "no-profile" };
      const referencePath = path.join(profileDir, profile.referenceFile || "reference.wav");
      if (!fs.existsSync(referencePath)) return { success: false, error: "no-profile" };
      // Sized before it is read, so an oversize clip is never loaded into memory.
      if (fs.statSync(referencePath).size > MAX_WAV_BYTES)
        return { success: false, error: "too-large" };
      // Cut to the bundle's name limit, so a long agent name still exports.
      const voiceName = (typeof name === "string" && name.trim().slice(0, 80).trim()) || "Voice";
      let bundle;
      try {
        bundle = await buildVoiceBundle({
          name: voiceName,
          transcript: profile.promptText,
          wav: fs.readFileSync(referencePath),
          language: profile.language,
          seed: profile.seed,
          numSteps: profile.numSteps,
        });
      } catch (bundleError) {
        const code = BUNDLE_ERROR_CODES[bundleError?.message];
        if (code === "too-large" || code === "not-wav") return { success: false, error: code };
        throw bundleError;
      }
      const fileName = voiceName.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "voice";
      const destination = await chooseBundleSavePath(`${fileName}.rtwvoice`);
      if (!destination) return { success: false, canceled: true };
      fs.writeFileSync(destination, bundle);
      return { success: true, path: destination };
    },
    async importBundle() {
      const sourcePath = await chooseBundle();
      if (!sourcePath) return { success: false, canceled: true };
      if (fs.statSync(sourcePath).size > MAX_BUNDLE_BYTES)
        return { success: false, error: "too-large" };
      let bundle;
      try {
        bundle = await readVoiceBundle(fs.readFileSync(sourcePath));
      } catch (bundleError) {
        return { success: false, error: BUNDLE_ERROR_CODES[bundleError?.message] || "corrupt" };
      }
      const { name, language, seed, numSteps } = bundle.manifest;
      installProfile((referencePath) => fs.writeFileSync(referencePath, bundle.wav), {
        promptText: bundle.transcript,
        name,
        language,
        seed,
        numSteps,
      });
      return { success: true };
    },
  };
}

module.exports = { createAssistantSpeechProfileStore, resolveRenderSettings };
