// Transcribes one buffered meeting WAV chunk by POSTing it to a self-hosted
// OpenAI-compatible transcription endpoint. Pure: no electron imports, the
// caller injects the fetch implementation (Electron's proxyFetch in the main
// process, a fake in tests).
//
// hubFirst is optional: when set and configured, the chunk
// goes to the hub first and this direct POST is the fallback. Meeting and live
// preview chunks are only RMS-gated, never trimmed, so the hub trims them
// (clientTrimmed: false).
async function transcribeSelfHostedChunk({ hubFirst, ...options }) {
  if (!hubFirst) return transcribeDirect(options);
  const { wav, language, prompt, signal } = options;
  const { text } = await hubFirst.withFallback(
    () => hubFirst.transcribeViaHub(wav, { language, prompt, clientTrimmed: false, signal }),
    () => transcribeDirect(options)
  );
  return { success: true, text };
}

async function transcribeDirect({
  endpoint,
  model,
  language,
  wav,
  fetchImpl,
  apiKey,
  prompt,
  signal,
}) {
  const formData = new FormData();
  formData.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  if (model) {
    formData.append("model", model);
  }
  if (language) {
    formData.append("language", language);
  }
  if (prompt) {
    formData.append("prompt", prompt);
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    body: formData,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw Object.assign(new Error(`Self-hosted API Error: ${response.status} ${errorText}`), {
      status: response.status,
    });
  }

  const data = await response.json();
  if (typeof data?.text !== "string") {
    throw new Error("Self-hosted API response is missing a text string");
  }
  return { success: true, text: data.text };
}

module.exports = { transcribeSelfHostedChunk };
