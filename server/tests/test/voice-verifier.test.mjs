import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { verifyReceiptData } from "../../../specs/voice-server.verify.mjs";

const root = resolve(tmpdir(), "openwhispr-checker-tests");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceSha = "a".repeat(40); const artifactSha256 = "b".repeat(64); const appSha = "c".repeat(64);
const at = (seconds) => new Date(Date.UTC(2026, 8, 15, 12, 0, seconds)).toISOString();

async function jsonFile(name, value) {
  const path = resolve(root, name); const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes); return { path, sha256: sha(bytes) };
}
async function textFile(name, value) { const path = resolve(root, name); await writeFile(path, value); return { path, sha256: sha(value) }; }

async function fixture() {
  await mkdir(root, { recursive: true });
  const command = await textFile("deploy-command.txt", "deploy exit 0\n");
  const manifestValue = { sourceSha, artifactSha256, sourceFiles: { "server/gateway/src/app.ts": appSha }, commandReceipt: command };
  const manifest = await jsonFile("deploy-manifest.json", manifestValue);
  const interruption = { assistantSpeechStartedAt: at(10), assistantSpeechId: "speech-1", overlappingSpeechAt: at(12), overlappingSpeechItemId: "input-2", sdkEvent: "overlapping_speech", sdkEventAt: at(13), assistantSpeechStoppedAt: at(14), responseEventAt: at(15), responseText: "reply after interrupt", responseItemId: "response-2" };
  const agentValue = { sourceSha, producerCommand: "voice-agent start", sessions: {
    roomA: { finalSttEvents: [{ text: "alpha marker", at: at(2), itemId: "a1" }, { text: "interrupt marker", at: at(12), itemId: "input-2" }], assistantResponseEvents: [{ text: "alpha response", at: at(3), itemId: "a2" }, { text: "reply after interrupt", at: at(15), itemId: "response-2" }], ttsEvents: [{ sourceSampleRate: 24000, sourceWavFrames: 2400, at: at(4) }], interruption },
    roomB: { finalSttEvents: [{ text: "bravo marker", at: at(2), itemId: "b1" }, { text: "reconnect marker", at: at(8), itemId: "b2" }], assistantResponseEvents: [{ text: "bravo response", at: at(3), itemId: "b3" }, { text: "reconnect response", at: at(9), itemId: "b4" }], ttsEvents: [{ sourceSampleRate: 24000, sourceWavFrames: 2400, at: at(4) }] }
  }};
  const agent = await jsonFile("agent.json", agentValue);
  const playbackA = { attached: 1, playingEvents: 1, timeUpdates: 2, nonSilentPcmSamples: 300, lastNonSilentAt: at(10), status: [] };
  const playbackB = { attached: 1, playingEvents: 2, timeUpdates: 4, nonSilentPcmSamples: 500, status: [{ value: "Reconnecting…", at: at(6) }, { value: "Connected", at: at(7) }] };
  const browserA = await jsonFile("browser-a.json", { injectedTestAudio: true, playback: playbackA, messages: "alpha marker alpha response" });
  const browserB = await jsonFile("browser-b.json", { injectedTestAudio: true, playback: playbackB, messages: "bravo marker bravo response reconnect marker reconnect response" });
  const snapshot = { observedAt: at(20), databaseIdentity: "db-1", sessionId: "session-a", sessionMetadataSha256: "d".repeat(64), voiceProfileSha256: "e".repeat(64) };
  const after = { ...snapshot, observedAt: at(22) };
  const infraValue = { sourceSha, restartPersistence: { command: "systemctl restart voice", exitCode: 0, before: snapshot, after } };
  const infra = await jsonFile("infra.json", infraValue);
  const crossText = "✔ enforces ownership and refreshes with a unique participant identity\nℹ pass 1\nℹ fail 0\n";
  const cross = await textFile("cross-owner.txt", crossText);
  const session = (which) => ({
    sessionId: `session-${which}`, roomName: `room${which.toUpperCase()}`, participantIdentity: `participant-${which}`, startedAt: at(which === "a" ? 0 : 1), endedAt: at(30),
    injectedTestAudio: { wavSha256: (which === "a" ? "1" : "2").repeat(64), expectedMarker: which === "a" ? "alpha marker" : "bravo marker" },
    sttText: which === "a" ? "alpha marker" : "bravo marker", llmResponse: which === "a" ? "alpha response" : "bravo response",
    tts: { sourceSampleRate: 24000, sourceWavFrames: 2400, evidence: agent }, renderedAudio: { audioElementAttached: true, playingEvents: which === "a" ? 1 : 2, timeUpdates: which === "a" ? 2 : 4, nonSilentPcmSamples: which === "a" ? 300 : 500, evidence: which === "a" ? browserA : browserB },
    isolation: { otherRoomMarkerAbsent: true, otherRoomTranscriptAbsent: true, otherRoomContextAbsent: true },
  });
  const receipt = { schemaVersion: 2, targetHostname: "voice-host", commands: ["browser harness"], deployment: { sourceSha, artifactSha256, manifest }, sessions: [session("a"), session("b")],
    auth: { unauthenticatedDenied: true, directDenied: true, spoofedIdentityDenied: true, crossOwner: { denied: true, status: 403, testName: "enforces ownership and refreshes with a unique participant identity", passedTests: 1, failedTests: 0, command: "node --test --test-name-pattern enforces ownership and refreshes with a unique participant identity", sourceFileSha256: appSha, evidence: cross } },
    interrupt: { ...interruption, injectedAudioStartedAt: at(11), injectedAudioMarker: "interrupt marker", injectedAudioEndedAt: at(13), browserNonSilentSamplesBefore: 100, evidence: agent },
    reconnect: { states: ["reconnecting", "reconnected"], disconnectedAt: at(6), reconnectedAt: at(7), postReconnectStt: "reconnect marker", postReconnectResponse: "reconnect response", postReconnectNonSilentPcmSamples: 50, evidence: browserB },
    restartPersistence: { sourceSha, command: infraValue.restartPersistence.command, before: snapshot, after, evidence: infra }, evidence: [manifest, agent, infra, cross, browserA, browserB] };
  return { receipt, manifest: manifest.path };
}

test("accepts a fully source-bound receipt", async () => { const value = await fixture(); await verifyReceiptData(value.receipt, resolve(root, "receipt.json"), value.manifest); });

for (const [name, mutate, pattern] of [
  ["rejects reconnect without transition", (r) => { r.reconnect.states = ["reconnected"]; }, /reconnect transition/],
  ["rejects reconnect without new played audio", (r) => { r.reconnect.postReconnectNonSilentPcmSamples = 0; }, /post-reconnect/],
  ["rejects unbound interruption", (r) => { r.interrupt.responseItemId = "unrelated"; }, /not bound/],
  ["rejects restart profile drift", (r) => { r.restartPersistence.after.voiceProfileSha256 = "f".repeat(64); }, /did not persist/],
  ["rejects fake cross-owner counts", (r) => { r.auth.crossOwner.passedTests = 2; }, /pass\/fail count/],
  ["rejects silent browser playback", (r) => { r.sessions[0].renderedAudio.nonSilentPcmSamples = 0; }, /non-silent decoded PCM/],
  ["rejects cross-room contamination", (r) => { r.sessions[0].isolation.otherRoomMarkerAbsent = false; }, /isolation negatives/],
  ["rejects source SHA unrelated to deployment", (r) => { r.deployment.sourceSha = "9".repeat(40); }, /source SHA/],
]) test(name, async () => { const value = await fixture(); mutate(value.receipt); await assert.rejects(() => verifyReceiptData(value.receipt, resolve(root, "receipt.json"), value.manifest), pattern); });

test("rejects contamination present in raw room evidence despite true receipt flags", async () => {
  const value = await fixture(); const entry = value.receipt.interrupt.evidence;
  const raw = JSON.parse(await readFile(entry.path, "utf8")); raw.sessions.roomA.finalSttEvents.push({ text: "bravo marker", at: at(5), itemId: "leak" });
  const bytes = `${JSON.stringify(raw, null, 2)}\n`; await writeFile(entry.path, bytes); const nextHash = sha(bytes);
  for (const session of value.receipt.sessions) session.tts.evidence.sha256 = nextHash;
  value.receipt.interrupt.evidence.sha256 = nextHash;
  value.receipt.evidence.find((file) => file.path === entry.path).sha256 = nextHash;
  await assert.rejects(() => verifyReceiptData(value.receipt, resolve(root, "receipt.json"), value.manifest), /other-room STT marker/);
});
