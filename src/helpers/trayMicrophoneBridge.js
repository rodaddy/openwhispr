class TrayMicrophoneBridge {
  constructor(onSelection) {
    this.onSelection = onSelection;
    this.trayManager = null;
    this.latestState = null;
  }

  attach(trayManager) {
    this.trayManager = trayManager;
    trayManager?.setMicrophoneSelectionCallback?.(this.onSelection);
    if (this.latestState) {
      trayManager?.setMicrophoneState?.(this.latestState);
    }
  }

  update(state) {
    this.latestState = state;
    this.trayManager?.setMicrophoneState?.(state);
  }
}

module.exports = TrayMicrophoneBridge;
