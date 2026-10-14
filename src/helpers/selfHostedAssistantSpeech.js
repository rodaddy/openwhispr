const { sanitizeForSpeech, stripSpeechTags } = require("./speechTags");
const { resolveRenderSettings } = require("./assistantSpeechProfile");

const SYNTHESIS_PATH = "/upstream/omnivoice/synthesize";

const abortError = () =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

// hubFirst is optional: when set and configured, speech goes
// to the hub first and the direct request below is the fallback.
// local is optional: it picks the provider ("hub" | "local" |
// "auto") and carries the on-device engine. Without it every request is "hub".
function createAssistantSpeechService({ fetchImpl, getConfig, hubFirst, local }) {
  const active = new Map();
  const keyFor = (ownerId, requestId) => `${ownerId}:${requestId}`;

  return {
    // voice is passed through to getConfig untouched (the grill picks one);
    // the assistant never passes it.
    async synthesize(ownerId, requestId, text, voice) {
      if (typeof text !== "string" || !text.trim()) throw new Error("Speech text is required");
      // Known tags are performed by OmniVoice; the on-device engine gets none.
      const spoken = sanitizeForSpeech(text).trim();
      const plain = stripSpeechTags(spoken).trim();
      if (!spoken) throw new Error("Speech text is required");
      const key = keyFor(ownerId, requestId);
      const controller = new AbortController();
      active.get(key)?.abort();
      active.set(key, controller);
      const superseded = () => active.get(key) !== controller || controller.signal.aborted;

      const viaHub = async () => {
        const config = await getConfig(voice);
        if (superseded()) throw abortError();
        if (!config?.endpoint || !config.referenceAudioBase64 || !config.promptText) {
          throw new Error("Assistant speech profile is not configured");
        }
        const direct = async () => {
          const endpoint = config.endpoint.replace(/\/+$/, "");
          const url = endpoint.endsWith(SYNTHESIS_PATH) ? endpoint : `${endpoint}${SYNTHESIS_PATH}`;
          // Pinned here too, so a config from any source renders the same way twice.
          const { seed, numSteps, language } = resolveRenderSettings(config);
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: spoken,
              audio_base64: config.referenceAudioBase64,
              prompt_text: config.promptText,
              seed,
              num_steps: numSteps,
              language,
              guidance_scale: 1.2,
            }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Speech service failed (${response.status})`);
          return response.json();
        };
        const body = hubFirst
          ? await hubFirst.withFallback(
              () =>
                hubFirst.synthesizeViaHub({
                  text: spoken,
                  audio_base64: config.referenceAudioBase64,
                  prompt_text: config.promptText,
                  signal: controller.signal,
                }),
              direct
            )
          : await direct();
        if (superseded()) throw abortError();
        if (typeof body?.audio_base64 !== "string" || !body.audio_base64) {
          throw new Error("Speech service returned invalid audio");
        }
        return {
          audio: Uint8Array.from(Buffer.from(body.audio_base64, "base64")),
          mimeType: "audio/wav",
        };
      };

      // knownPaths: the "auto" fallback has already resolved them, so getPaths()
      // runs once per request.
      const viaLocal = async (knownPaths) => {
        let paths = knownPaths;
        if (!paths) {
          if (!local.isAvailable()) throw new Error("Local speech is not installed");
          paths = local.getPaths();
          if (!paths) throw new Error("Assistant speech profile is not configured");
        }
        if (!plain) throw new Error("Speech text is required");
        let wav;
        try {
          wav = await local.synthesize({
            text: plain,
            ...paths,
            signal: controller.signal,
          });
        } catch (engineError) {
          // A cancelled engine call rejects with whatever the engine died of.
          if (superseded()) throw abortError();
          throw engineError;
        }
        if (superseded()) throw abortError();
        if (!(wav instanceof Uint8Array) || wav.length === 0) {
          throw new Error("Speech service returned invalid audio");
        }
        return { audio: Uint8Array.from(wav), mimeType: "audio/wav" };
      };

      try {
        // The on-device engine can only speak the profile voice, so a request
        // that names a voice always goes to the hub.
        const provider = local && voice == null ? local.getProvider() : "hub";
        if (provider === "local") return await viaLocal();
        if (provider !== "auto") return await viaHub();
        try {
          return await viaHub();
        } catch (hubError) {
          // A cancelled or superseded request never falls back.
          if (superseded()) throw abortError();
          try {
            const paths = local.isAvailable() ? local.getPaths() : null;
            if (paths) return await viaLocal(paths);
          } catch (localError) {
            // viaLocal's own AbortError (superseded) carries no cause.
            if (
              !superseded() &&
              localError &&
              typeof localError === "object" &&
              localError.cause == null
            ) {
              localError.cause = hubError;
            }
            throw localError;
          }
          // The engine cannot take over: the hub error stands.
          throw hubError;
        }
      } finally {
        if (active.get(key) === controller) active.delete(key);
      }
    },
    cancel(ownerId, requestId) {
      active.get(keyFor(ownerId, requestId))?.abort();
    },
  };
}

module.exports = { createAssistantSpeechService };
