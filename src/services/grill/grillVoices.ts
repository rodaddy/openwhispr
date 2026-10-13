// The voices a spoken grill can ask its questions in. Settings keep the list
// (grillVoices) and the selection (grillVoiceId); main resolves a voice to the
// OmniVoice reference clip and transcript (src/helpers/grillVoiceStore.js).

export interface GrillVoice {
  id: string;
  name: string;
  /** A WAV clip main copied into its grill-voices folder; "" = the assistant's voice profile. */
  referenceAudioPath: string;
  /** The exact words spoken in the clip; "" for the assistant's voice profile. */
  promptText: string;
}

/**
 * OmniVoice cannot speak without a reference clip: /upstream/omnivoice/synthesize
 * answers 422 "Field required" for audio_base64 and prompt_text when they are
 * left out (probed 2026-09-26 against the self-hosted server). So there is no clip-free
 * "Default" voice, and Skippy is the default.
 */
export const CLIP_FREE_SYNTHESIS = false;

export const SKIPPY_VOICE_ID = "skippy";

/** Skippy is the voice the assistant already speaks in (its imported profile). */
export const SKIPPY_VOICE: Readonly<GrillVoice> = Object.freeze({
  id: SKIPPY_VOICE_ID,
  name: "Skippy",
  referenceAudioPath: "",
  promptText: "",
});

export const DEFAULT_GRILL_VOICE_ID = SKIPPY_VOICE_ID;

const isVoice = (value: unknown): value is GrillVoice => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.trim().length > 0 &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    typeof v.referenceAudioPath === "string" &&
    v.referenceAudioPath.length > 0 &&
    typeof v.promptText === "string" &&
    v.promptText.trim().length > 0
  );
};

/** The stored list, cleaned, with Skippy always first. */
export function seedGrillVoices(stored: unknown): GrillVoice[] {
  const custom = Array.isArray(stored)
    ? stored.filter((v): v is GrillVoice => isVoice(v) && v.id !== SKIPPY_VOICE_ID)
    : [];
  return [{ ...SKIPPY_VOICE }, ...custom.map((v) => ({ ...v }))];
}

export function resolveGrillVoice(voices: GrillVoice[], id: string | null | undefined): GrillVoice {
  const list = seedGrillVoices(voices);
  return (
    list.find((v) => v.id === id) ??
    list.find((v) => v.id === DEFAULT_GRILL_VOICE_ID) ?? { ...SKIPPY_VOICE }
  );
}

/** What the synthesize IPC gets: null means the assistant's own profile (Skippy). */
export function grillSpeechVoice(
  voice: GrillVoice
): { referenceAudioPath: string; promptText: string } | null {
  if (!voice.referenceAudioPath) return null;
  return { referenceAudioPath: voice.referenceAudioPath, promptText: voice.promptText.trim() };
}

export function addGrillVoice(
  voices: GrillVoice[],
  input: { name: string; referenceAudioPath: string; promptText: string },
  makeId: () => string = () => crypto.randomUUID()
): GrillVoice[] {
  const voice: GrillVoice = {
    id: makeId(),
    name: input.name.trim(),
    referenceAudioPath: input.referenceAudioPath,
    promptText: input.promptText.trim(),
  };
  if (!voice.name) throw new Error("A voice needs a name");
  if (!voice.referenceAudioPath) throw new Error("A voice needs a clip");
  if (!voice.promptText) throw new Error("A voice needs the clip's transcript");
  return [...seedGrillVoices(voices), voice];
}

export function removeGrillVoice(voices: GrillVoice[], id: string): GrillVoice[] {
  if (id === SKIPPY_VOICE_ID) return seedGrillVoices(voices);
  return seedGrillVoices(voices).filter((v) => v.id !== id);
}
