const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/grill/grillVoices.ts");

test("OmniVoice needs a reference clip, so no clip-free Default voice is seeded and Skippy is the default", async () => {
  const { CLIP_FREE_SYNTHESIS, DEFAULT_GRILL_VOICE_ID, SKIPPY_VOICE_ID, seedGrillVoices } =
    await load();
  assert.equal(CLIP_FREE_SYNTHESIS, false);
  assert.equal(DEFAULT_GRILL_VOICE_ID, SKIPPY_VOICE_ID);
  const seeded = seedGrillVoices([]);
  assert.deepEqual(
    seeded.map((v) => v.id),
    [SKIPPY_VOICE_ID]
  );
  assert.equal(seeded[0].name, "Skippy");
  // Skippy carries no clip of its own: it is the assistant's configured voice profile.
  assert.equal(seeded[0].referenceAudioPath, "");
  assert.equal(seeded[0].promptText, "");
});

test("stored voices are kept, Skippy is always present, and malformed entries are dropped", async () => {
  const { seedGrillVoices, SKIPPY_VOICE_ID } = await load();
  const custom = {
    id: "v1",
    name: "Morgan",
    referenceAudioPath: "/voices/morgan.wav",
    promptText: "Hi, this is Morgan.",
  };
  const seeded = seedGrillVoices([custom, { id: "", name: "x" }, null, "junk", { id: "v2" }]);
  assert.deepEqual(
    seeded.map((v) => v.id),
    [SKIPPY_VOICE_ID, "v1"]
  );
  assert.deepEqual(seeded[1], custom);
  assert.deepEqual(seedGrillVoices("not an array").length, 1);
});

test("resolveGrillVoice picks the selected voice, falls back to the default, and returns Skippy by default", async () => {
  const { resolveGrillVoice, seedGrillVoices, SKIPPY_VOICE_ID } = await load();
  const voices = seedGrillVoices([
    { id: "v1", name: "Morgan", referenceAudioPath: "/voices/morgan.wav", promptText: "Hi." },
  ]);
  assert.equal(resolveGrillVoice(voices, "v1").id, "v1");
  assert.equal(resolveGrillVoice(voices, SKIPPY_VOICE_ID).id, SKIPPY_VOICE_ID);
  assert.equal(resolveGrillVoice(voices, "gone").id, SKIPPY_VOICE_ID);
  assert.equal(resolveGrillVoice([], "").id, SKIPPY_VOICE_ID);
});

test("the synthesis request for Skippy uses the assistant profile; a custom voice sends its clip and transcript", async () => {
  const { grillSpeechVoice, seedGrillVoices } = await load();
  const [skippy] = seedGrillVoices([]);
  assert.equal(grillSpeechVoice(skippy), null);
  assert.deepEqual(
    grillSpeechVoice({
      id: "v1",
      name: "Morgan",
      referenceAudioPath: "/voices/morgan.wav",
      promptText: " Hi. ",
    }),
    { referenceAudioPath: "/voices/morgan.wav", promptText: "Hi." }
  );
});

test("adding a voice needs a name, a clip, and a transcript; Skippy cannot be removed", async () => {
  const { addGrillVoice, removeGrillVoice, seedGrillVoices, SKIPPY_VOICE_ID } = await load();
  const voices = seedGrillVoices([]);
  assert.throws(() =>
    addGrillVoice(voices, { name: " ", referenceAudioPath: "/a.wav", promptText: "x" })
  );
  assert.throws(() =>
    addGrillVoice(voices, { name: "A", referenceAudioPath: "", promptText: "x" })
  );
  assert.throws(() =>
    addGrillVoice(voices, { name: "A", referenceAudioPath: "/a.wav", promptText: " " })
  );
  const added = addGrillVoice(
    voices,
    { name: " Morgan ", referenceAudioPath: "/a.wav", promptText: " Hi. " },
    () => "id-1"
  );
  assert.deepEqual(added.at(-1), {
    id: "id-1",
    name: "Morgan",
    referenceAudioPath: "/a.wav",
    promptText: "Hi.",
  });
  assert.deepEqual(
    removeGrillVoice(added, SKIPPY_VOICE_ID).map((v) => v.id),
    [SKIPPY_VOICE_ID, "id-1"]
  );
  assert.deepEqual(
    removeGrillVoice(added, "id-1").map((v) => v.id),
    [SKIPPY_VOICE_ID]
  );
});
