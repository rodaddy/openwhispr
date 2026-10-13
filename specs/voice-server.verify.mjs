#!/opt/homebrew/opt/node@24/bin/node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const timestamp = (value, name) => {
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed), `${name} must be a date-time`);
  return parsed;
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function evidencePath(entry, receiptPath) {
  requireValue(entry && nonempty(entry.path), "evidence path is required");
  requireValue(/^[0-9a-f]{64}$/.test(entry.sha256), `invalid SHA-256 for ${entry.path}`);
  return isAbsolute(entry.path) ? entry.path : resolve(dirname(receiptPath), entry.path);
}

async function verifyEvidence(entry, receiptPath) {
  const path = evidencePath(entry, receiptPath);
  await access(path);
  const bytes = await readFile(path);
  requireValue(digest(bytes) === entry.sha256, `evidence hash mismatch: ${entry.path}`);
  return { path, bytes };
}

function verifyRenderedAudio(audio) {
  requireValue(audio?.audioElementAttached === true, "attached audio element proof is required");
  requireValue(Number.isInteger(audio.playingEvents) && audio.playingEvents > 0, "audio playing event proof is required");
  requireValue(Number.isInteger(audio.timeUpdates) && audio.timeUpdates > 0, "audio playback time proof is required");
  requireValue(Number.isInteger(audio.nonSilentPcmSamples) && audio.nonSilentPcmSamples > 0, "non-silent decoded PCM proof is required");
}

function eventWith(events, marker) {
  return Array.isArray(events) && events.find((event) => nonempty(event?.text) && event.text.toLowerCase().includes(marker.toLowerCase()));
}

async function jsonEvidence(entry, receiptPath) {
  return JSON.parse((await verifyEvidence(entry, receiptPath)).bytes.toString("utf8"));
}

async function verifySessionEvidence(session, other, receiptPath, agent) {
  const raw = agent.sessions?.[session.roomName];
  requireValue(raw, `agent evidence lacks room ${session.roomName}`);
  requireValue(eventWith(raw.finalSttEvents, session.injectedTestAudio.expectedMarker), "agent evidence lacks room-bound STT marker");
  requireValue(eventWith(raw.assistantResponseEvents, session.llmResponse), "agent evidence lacks room-bound assistant response");
  requireValue(!eventWith(raw.finalSttEvents, other.injectedTestAudio.expectedMarker), "other-room STT marker is present in agent evidence");
  requireValue(!eventWith(raw.assistantResponseEvents, other.llmResponse), "other-room response is present in agent evidence");
  const tts = raw.ttsEvents;
  requireValue(Array.isArray(tts) && tts.some((event) => event.sourceSampleRate === session.tts.sourceSampleRate && event.sourceWavFrames === session.tts.sourceWavFrames), "TTS source WAV observation mismatch");
  const browser = await jsonEvidence(session.renderedAudio.evidence, receiptPath);
  requireValue(browser.injectedTestAudio === true, "browser evidence must label injected test audio");
  requireValue((browser.playback?.attached > 0) === session.renderedAudio.audioElementAttached, "browser attached-audio proof mismatch");
  requireValue(browser.playback?.playingEvents === session.renderedAudio.playingEvents, "browser playing-event count mismatch");
  requireValue(browser.playback?.timeUpdates === session.renderedAudio.timeUpdates, "browser time-update count mismatch");
  requireValue(browser.playback?.nonSilentPcmSamples === session.renderedAudio.nonSilentPcmSamples, "browser PCM count mismatch");
  requireValue(nonempty(browser.messages) && browser.messages.toLowerCase().includes(session.injectedTestAudio.expectedMarker.toLowerCase()), "browser evidence lacks own transcript marker");
  requireValue(!browser.messages.toLowerCase().includes(other.injectedTestAudio.expectedMarker.toLowerCase()), "browser evidence contains other-room transcript marker");
  requireValue(!browser.messages.toLowerCase().includes(other.llmResponse.toLowerCase()), "browser evidence contains other-room response");
}

function verifyChronology(values, label) {
  const times = values.map(([name, value]) => timestamp(value, `${label}.${name}`));
  for (let index = 1; index < times.length; index += 1) requireValue(times[index] >= times[index - 1], `${label} chronology is invalid`);
}

async function verifyDeployment(receipt, receiptPath, manifestPath) {
  requireValue(nonempty(manifestPath), "VOICE_DEPLOY_MANIFEST is required for --phase full");
  const absoluteManifest = resolve(manifestPath);
  const manifestEvidence = await verifyEvidence(receipt.deployment?.manifest, receiptPath);
  requireValue(manifestEvidence.path === absoluteManifest, "receipt deployment manifest path does not match VOICE_DEPLOY_MANIFEST");
  const manifest = JSON.parse(manifestEvidence.bytes.toString("utf8"));
  requireValue(/^[0-9a-f]{40,64}$/.test(manifest.sourceSha), "deployment manifest sourceSha is invalid");
  requireValue(receipt.deployment.sourceSha === manifest.sourceSha, "receipt source SHA does not match deployment manifest");
  requireValue(receipt.deployment.artifactSha256 === manifest.artifactSha256, "receipt artifact SHA does not match deployment manifest");
  await verifyEvidence(manifest.commandReceipt, absoluteManifest);
  return manifest;
}

async function verifyCrossOwner(crossOwner, receiptPath, manifest) {
  const expectedName = "enforces ownership and refreshes with a unique participant identity";
  requireValue(crossOwner?.denied === true && crossOwner.status === 403, "cross-owner HTTP 403 proof is required");
  requireValue(crossOwner.testName === expectedName, "cross-owner exact test name mismatch");
  requireValue(crossOwner.passedTests === 1 && crossOwner.failedTests === 0, "cross-owner focused pass/fail count mismatch");
  requireValue(crossOwner.command.includes("--test-name-pattern") && crossOwner.command.includes(expectedName), "cross-owner focused command mismatch");
  requireValue(crossOwner.sourceFileSha256 === manifest.sourceFiles?.["server/gateway/src/app.ts"], "cross-owner source is not bound to deployed gateway source");
  const output = (await verifyEvidence(crossOwner.evidence, receiptPath)).bytes.toString("utf8");
  requireValue(output.includes(`✔ ${expectedName}`), "cross-owner output lacks exact passing test");
  requireValue(/ℹ pass 1(?:\D|$)/.test(output) && /ℹ fail 0(?:\D|$)/.test(output), "cross-owner output lacks focused pass/fail counts");
}

async function verifyRestart(restart, receiptPath) {
  requireValue(nonempty(restart?.command), "restart command is required");
  const before = restart.before; const after = restart.after;
  verifyChronology([["before", before?.observedAt], ["after", after?.observedAt]], "restart");
  for (const field of ["databaseIdentity", "sessionId", "sessionMetadataSha256", "voiceProfileSha256"]) {
    requireValue(nonempty(before?.[field]) && before[field] === after?.[field], `restart ${field} did not persist`);
  }
  const record = await jsonEvidence(restart.evidence, receiptPath);
  requireValue(record.sourceSha === restart.sourceSha, "restart evidence source mismatch");
  requireValue(record.restartPersistence?.command === restart.command && record.restartPersistence?.exitCode === 0, "restart command receipt mismatch");
  requireValue(JSON.stringify(record.restartPersistence.before) === JSON.stringify(before) && JSON.stringify(record.restartPersistence.after) === JSON.stringify(after), "restart snapshots are not bound to evidence");
}

export async function verifyReceiptData(receipt, receiptPath, manifestPath) {
  requireValue(receipt?.schemaVersion === 2, "schemaVersion must be 2");
  requireValue(receipt.targetHostname === "voice-host", "targetHostname mismatch");
  requireValue(Array.isArray(receipt.commands) && receipt.commands.length > 0 && receipt.commands.every(nonempty), "commands are required");
  const manifest = await verifyDeployment(receipt, receiptPath, manifestPath);
  const agent = await jsonEvidence(receipt.interrupt?.evidence, receiptPath);
  requireValue(agent.sourceSha === manifest.sourceSha && nonempty(agent.producerCommand), "agent evidence is not bound to deployed source/producer");
  requireValue(Array.isArray(receipt.sessions) && receipt.sessions.length === 2, "exactly two browser sessions are required");
  const [first, second] = receipt.sessions;
  for (const session of receipt.sessions) {
    requireValue([session.sessionId, session.roomName, session.participantIdentity, session.sttText, session.llmResponse].every(nonempty), "session identity/STT/LLM fields are required");
    requireValue(session.injectedTestAudio?.expectedMarker && /^[0-9a-f]{64}$/.test(session.injectedTestAudio.wavSha256), "injected test audio must be identified");
    requireValue(session.sttText.toLowerCase().includes(session.injectedTestAudio.expectedMarker.toLowerCase()), "STT does not contain injected-audio marker");
    requireValue(session.tts?.sourceSampleRate === 24000 && Number.isInteger(session.tts.sourceWavFrames) && session.tts.sourceWavFrames > 0, "24 kHz TTS source WAV proof is required");
    verifyRenderedAudio(session.renderedAudio);
    requireValue(Object.values(session.isolation || {}).every((value) => value === true) && Object.keys(session.isolation || {}).length === 3, "room isolation negatives are required");
    verifyChronology([["startedAt", session.startedAt], ["endedAt", session.endedAt]], "session");
    await verifyEvidence(session.tts.evidence, receiptPath); await verifyEvidence(session.renderedAudio.evidence, receiptPath);
  }
  requireValue(first.sessionId !== second.sessionId && first.roomName !== second.roomName && first.participantIdentity !== second.participantIdentity, "browser sessions must have distinct sessions, rooms, and participants");
  await verifySessionEvidence(first, second, receiptPath, agent); await verifySessionEvidence(second, first, receiptPath, agent);
  requireValue(timestamp(first.startedAt, "first.startedAt") < timestamp(second.endedAt, "second.endedAt") && timestamp(second.startedAt, "second.startedAt") < timestamp(first.endedAt, "first.endedAt"), "browser sessions must overlap");
  for (const field of ["unauthenticatedDenied", "directDenied", "spoofedIdentityDenied"]) requireValue(receipt.auth?.[field] === true, `auth negative missing: ${field}`);
  await verifyCrossOwner(receipt.auth?.crossOwner, receiptPath, manifest);
  verifyChronology([["assistantSpeechStartedAt", receipt.interrupt?.assistantSpeechStartedAt], ["injectedAudioStartedAt", receipt.interrupt?.injectedAudioStartedAt], ["overlappingSpeechAt", receipt.interrupt?.overlappingSpeechAt], ["sdkEventAt", receipt.interrupt?.sdkEventAt], ["assistantSpeechStoppedAt", receipt.interrupt?.assistantSpeechStoppedAt], ["responseEventAt", receipt.interrupt?.responseEventAt]], "interrupt");
  requireValue(timestamp(receipt.interrupt.injectedAudioEndedAt, "interrupt.injectedAudioEndedAt") >= timestamp(receipt.interrupt.overlappingSpeechAt, "interrupt.overlappingSpeechAt"), "interruption event was outside injected-audio interval");
  requireValue(receipt.interrupt?.sdkEvent === "overlapping_speech" && nonempty(receipt.interrupt?.assistantSpeechId) && nonempty(receipt.interrupt?.overlappingSpeechItemId) && nonempty(receipt.interrupt?.responseItemId) && nonempty(receipt.interrupt?.responseText), "turn-bound SDK interruption event and response are required");
  const rawInterrupt = agent.sessions?.[first.roomName]?.interruption;
  for (const field of ["assistantSpeechStartedAt", "assistantSpeechId", "overlappingSpeechAt", "overlappingSpeechItemId", "sdkEvent", "sdkEventAt", "assistantSpeechStoppedAt", "responseEventAt", "responseItemId", "responseText"]) requireValue(rawInterrupt?.[field] === receipt.interrupt[field], `interruption ${field} is not bound to agent evidence`);
  const interruptInput = eventWith(agent.sessions?.[first.roomName]?.finalSttEvents, receipt.interrupt.injectedAudioMarker);
  requireValue(interruptInput?.itemId === receipt.interrupt.overlappingSpeechItemId, "interruption input item is not bound to injected transcript marker");
  const interruptResponse = eventWith(agent.sessions?.[first.roomName]?.assistantResponseEvents, receipt.interrupt.responseText);
  requireValue(interruptResponse?.itemId === receipt.interrupt.responseItemId, "interruption response item is not bound to agent evidence");
  requireValue(JSON.stringify(receipt.reconnect?.states) === JSON.stringify(["reconnecting", "reconnected"]), "actual reconnect transition is required");
  verifyChronology([["disconnectedAt", receipt.reconnect?.disconnectedAt], ["reconnectedAt", receipt.reconnect?.reconnectedAt]], "reconnect");
  requireValue(nonempty(receipt.reconnect?.postReconnectStt) && nonempty(receipt.reconnect?.postReconnectResponse) && receipt.reconnect?.postReconnectNonSilentPcmSamples > 0, "post-reconnect STT/response/non-silent audio is required");
  const reconnectBrowser = await jsonEvidence(receipt.reconnect.evidence, receiptPath);
  const reconnectStatuses = reconnectBrowser.playback?.status || [];
  const reconnecting = reconnectStatuses.findIndex((entry) => entry.value === "Reconnecting…" && entry.at === receipt.reconnect.disconnectedAt);
  const reconnected = reconnectStatuses.findIndex((entry, index) => index > reconnecting && (entry.value === "Connected" || entry.value.startsWith("Connected until")) && entry.at === receipt.reconnect.reconnectedAt);
  requireValue(reconnecting >= 0 && reconnected > reconnecting, "reconnect states are not bound to browser evidence");
  requireValue(reconnectBrowser.messages.toLowerCase().includes(receipt.reconnect.postReconnectStt.toLowerCase()), "post-reconnect transcript is absent from browser evidence");
  requireValue(receipt.restartPersistence?.sourceSha === manifest.sourceSha, "restart source does not match deployment manifest");
  await verifyRestart(receipt.restartPersistence, receiptPath);
  requireValue(Array.isArray(receipt.evidence) && receipt.evidence.length > 0, "hashed evidence files are required");
  for (const entry of receipt.evidence) await verifyEvidence(entry, receiptPath);
}

async function fetchHealth(baseUrl) {
  for (const path of ["/healthz", "/readyz"]) {
    const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
    requireValue(response.ok, `${path} returned HTTP ${response.status}`);
  }
}

export async function runCli() {
  const args = process.argv.slice(2); const phaseIndex = args.indexOf("--phase");
  const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : "full";
  requireValue(phase === "health" || phase === "full", "--phase must be health or full");
  const baseUrl = (process.env.VOICE_VERIFY_URL || "http://voice-host.example.internal:8090").replace(/\/$/, "");
  await fetchHealth(baseUrl);
  if (phase === "full") {
    const receiptPath = process.env.VOICE_ACCEPTANCE_RECEIPT;
    requireValue(nonempty(receiptPath), "VOICE_ACCEPTANCE_RECEIPT is required for --phase full");
    const absolute = resolve(receiptPath);
    await verifyReceiptData(JSON.parse(await readFile(absolute, "utf8")), absolute, process.env.VOICE_DEPLOY_MANIFEST);
  }
  process.stdout.write(`voice-server.verify: PASS phase=${phase} target=${baseUrl}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => { process.stderr.write(`voice-server.verify: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
