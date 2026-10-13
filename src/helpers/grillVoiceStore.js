const path = require("path");

// Grill voices: the reference clips a spoken grill can ask its questions in.
// A voice with no clip is Skippy, the assistant's own imported voice profile.
// Custom clips are copied into voicesDir on import, and only clips inside it
// are ever read, so the renderer cannot name an arbitrary file.
function createGrillVoiceStore({ fs, voicesDir, endpoint, readAssistantProfile, chooseWav }) {
  const root = path.resolve(voicesDir);
  const insideRoot = (file) => {
    const relative = path.relative(root, path.resolve(file));
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  return {
    resolveConfig(voice) {
      if (!voice?.referenceAudioPath) return readAssistantProfile();
      const promptText = typeof voice.promptText === "string" ? voice.promptText.trim() : "";
      if (!promptText || !insideRoot(voice.referenceAudioPath)) return null;
      const clip = path.resolve(voice.referenceAudioPath);
      if (!fs.existsSync(clip)) return null;
      return {
        endpoint,
        promptText,
        referenceAudioBase64: fs.readFileSync(clip).toString("base64"),
      };
    },
    async importClip() {
      const sourcePath = await chooseWav();
      if (!sourcePath) return { success: false, canceled: true };
      fs.mkdirSync(root, { recursive: true });
      const referenceAudioPath = path.join(
        root,
        `voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
      );
      fs.copyFileSync(sourcePath, referenceAudioPath);
      return { success: true, referenceAudioPath };
    },
  };
}

module.exports = { createGrillVoiceStore };
