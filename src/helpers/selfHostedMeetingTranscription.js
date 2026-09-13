// Transcribes one buffered meeting WAV chunk by POSTing it to a self-hosted
// OpenAI-compatible transcription endpoint. Pure: no electron imports, the
// caller injects the fetch implementation (Electron's proxyFetch in the main
// process, a fake in tests).
async function transcribeSelfHostedChunk({ endpoint, model, language, wav, fetchImpl, apiKey }) {
  const formData = new FormData();
  formData.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  if (model) {
    formData.append("model", model);
  }
  if (language) {
    formData.append("language", language);
  }

  // Content-Type is left to fetch so FormData can set the multipart boundary.
  const headers = {};
  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (trimmedKey) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Self-hosted API Error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return { success: true, text: data?.text ?? "" };
}

module.exports = { transcribeSelfHostedChunk };
