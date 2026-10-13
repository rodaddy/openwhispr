const test = require("node:test");
const assert = require("node:assert/strict");

const mic = (deviceId, label, groupId = deviceId) => ({
  kind: "audioinput",
  deviceId,
  label,
  groupId,
});
const lark = mic("lark", "Wireless microphone (3547:0007)");
const fallback = mic("backup", "Backup microphone");
const system = mic("default", "Default - LG UltraFine Display Audio (043e:9a66)", "lg");
const lg = mic("lg", "LG UltraFine Display Audio (043e:9a66)");
const settings = {
  microphoneSelectionMode: "automatic",
  preferredMicDeviceId: lark.deviceId,
  preferredMicDeviceLabel: lark.label,
  fallbackMicDeviceId: fallback.deviceId,
  fallbackMicDeviceLabel: fallback.label,
};

test("automatic selection uses preferred, configured fallback, then system default", async () => {
  const { resolveMicrophoneSelection: resolve } =
    await import("../../src/helpers/microphoneSelection.js");
  const devices = [system, lg, fallback, lark];
  for (const [inputs, status, expectedId, source] of [
    [devices, "connected", "lark", "preferred"],
    [devices, "disconnected", "backup", "configured-fallback"],
    [[system, lg], "disconnected", "lg", "system-default"],
  ]) {
    const result = resolve(inputs, settings, { name: "LG UltraFine Display Audio" }, status);
    assert.equal(result.device?.deviceId, expectedId);
    assert.equal(result.source, source);
  }
});

test("unknown radio status cannot disqualify a present mic or affect another receiver", async () => {
  const { resolveMicrophoneSelection: resolve } =
    await import("../../src/helpers/microphoneSelection.js");
  assert.equal(resolve([fallback, lark], settings, null, "unknown").device, lark);
  const unrelated = mic("lark", "Other wireless microphone");
  assert.equal(resolve([fallback, unrelated], settings, null, "disconnected").device, unrelated);
});

test("manual selection remains sticky until automatic mode is resumed", async () => {
  const { resolveMicrophoneSelection: resolve } =
    await import("../../src/helpers/microphoneSelection.js");
  const manual = {
    ...settings,
    microphoneSelectionMode: "specific",
    selectedMicDeviceId: "backup",
  };
  assert.equal(resolve([lark, fallback], manual, null, "connected").device, fallback);
  assert.equal(
    resolve(
      [lark, fallback],
      { ...manual, microphoneSelectionMode: "automatic" },
      null,
      "connected"
    ).device,
    lark
  );
});

test("default group identity disambiguates the two LG displays without guessing native IDs", async () => {
  const { resolveSystemDefaultMicDevice: resolve } =
    await import("../../src/helpers/microphoneSelection.js");
  const other = mic("other-lg", "LG UltraFine Display Audio (043e:9a4b)");
  const result = resolve([system, other, lg], {
    name: "LG UltraFine Display Audio",
    nativeId: "not-a-chromium-id",
  });
  assert.equal(result.device, lg);
  assert.equal(result.status, "chromium-group-alias");
  const ambiguous = resolve([system, { ...other, groupId: "lg" }, lg], {
    name: "LG UltraFine Display Audio",
  });
  assert.equal(ambiguous.device, system);
});

test("stop-on-loss keeps a healthy capture pinned, then notifies once without acquiring a replacement", async () => {
  const { ActiveMicRecoveryController } = await import("../../src/helpers/activeMicRecovery.js");
  const track = new EventTarget();
  Object.assign(track, {
    readyState: "live",
    muted: false,
    getSettings: () => ({ deviceId: "backup", groupId: "backup" }),
  });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const mediaDevices = new EventTarget();
  let devices = [fallback];
  mediaDevices.enumerateDevices = async () => devices;
  let acquired = 0;
  let losses = 0;
  const controller = new ActiveMicRecoveryController({
    mediaDevices,
    acquire: async () => {
      acquired += 1;
      return stream;
    },
    onRecovered: async () => {},
    onActiveLoss: () => {
      losses += 1;
    },
  });
  try {
    await controller.start(stream, { followDefault: false });
    devices = [lark, fallback];
    await controller.evaluateDeviceChange();
    assert.equal(acquired, 0, "preferred return must not interrupt the healthy fallback capture");
    assert.equal(losses, 0);
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    await new Promise(setImmediate);
    track.dispatchEvent(new Event("ended"));
    await new Promise(setImmediate);
    assert.equal(losses, 1, "caller must finalize captured audio exactly once");
    assert.equal(acquired, 0, "loss must not swap streams or restart capture");
  } finally {
    controller.stop();
  }
});
