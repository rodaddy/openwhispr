const test = require("node:test");
const assert = require("node:assert/strict");

const TrayMicrophoneBridge = require("../../src/helpers/trayMicrophoneBridge");

test("replays a system-mode update received before the tray manager is created", () => {
  const selections = [];
  const bridge = new TrayMicrophoneBridge((selection) => selections.push(selection));
  const state = {
    devices: [{ deviceId: "default", label: "System Default" }],
    mode: "system",
    selectedMicDeviceId: "default",
    resolvedActiveLabel: "Built-in Microphone",
    captureActive: false,
  };

  bridge.update(state);

  let selectionCallback = null;
  let appliedState = null;
  bridge.attach({
    setMicrophoneSelectionCallback(callback) {
      selectionCallback = callback;
    },
    setMicrophoneState(nextState) {
      appliedState = nextState;
    },
  });

  assert.equal(appliedState, state);
  assert.equal(typeof selectionCallback, "function");
  selectionCallback({ mode: "automatic" });
  assert.deepEqual(selections, [{ mode: "automatic" }]);
});
