import { useEffect, useRef } from "react";
import { resolvePreferredMicrophone } from "../helpers/microphoneSelection";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { useSettingsStore } from "../stores/settingsStore";
import logger from "../utils/logger";

// The settings resolvePreferredMicrophone reads. Any other settings write
// (theme, prompts, history) must not refresh: a refresh forces both helpers.
const MIC_SETTING_KEYS = [
  "microphoneSelectionMode",
  "preferBuiltInMic",
  "selectedMicDeviceId",
  "selectedMicDeviceLabel",
  "preferredMicDeviceId",
  "preferredMicDeviceLabel",
  "fallbackMicDeviceId",
  "fallbackMicDeviceLabel",
] as const;

export function useTrayMicrophoneState(captureActive: boolean) {
  const displayedInputRef = useRef("");

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;
    let dirty = false;
    let generation = 0;

    // A forced refresh spawns the default-input and Lark status helpers. Only a real
    // change signal (device hot-plug, settings edit, first run) warrants
    // that; the 2s automatic-mode tick reads the 30s cache instead, or it
    // forks a helper every tick for as long as the app is open.
    let forceSystemDefault = false;

    const refresh = () => {
      if (disposed) return null;
      if (inFlight) {
        dirty = true;
        return inFlight;
      }
      const refreshSystemDefault = forceSystemDefault;
      forceSystemDefault = false;
      const startedGeneration = generation;
      inFlight = (async () => {
        try {
          const settings = useSettingsStore.getState();
          const resolution = await resolvePreferredMicrophone({
            settings,
            refreshSystemDefault,
            getWirelessStatus: () =>
              window.electronAPI?.getLarkM2Status?.({ refresh: refreshSystemDefault }),
          });
          const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === "audioinput")
            .map((device) => ({
              deviceId: device.deviceId,
              groupId: device.groupId,
              label: device.label || "Unknown microphone",
              isBuiltIn: isBuiltInMicrophone(device.label),
            }));
          const latest = useSettingsStore.getState();
          if (startedGeneration !== generation) {
            dirty = true;
            return;
          }
          if (disposed) return;
          const resolvedLabel = resolution.device?.label || "";
          if (!captureActive || !displayedInputRef.current) {
            displayedInputRef.current = resolvedLabel;
          }
          if (!disposed) {
            await window.electronAPI?.updateTrayMicrophoneState?.({
              devices,
              mode: latest.microphoneSelectionMode,
              selectedMicDeviceId: latest.selectedMicDeviceId,
              resolvedActiveLabel: displayedInputRef.current,
              captureActive,
            });
          }
        } catch (error) {
          logger.debug("Unable to refresh tray microphone inventory", {
            error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
          });
        } finally {
          inFlight = null;
          if (dirty && !disposed) {
            dirty = false;
            queueMicrotask(refresh);
          }
        }
      })();
      return inFlight;
    };

    const onDeviceChange = () => schedule();
    const schedule = (force = true) => {
      generation += 1;
      if (force) forceSystemDefault = true;
      void refresh();
      clearTimeout(timer);
      if (useSettingsStore.getState().microphoneSelectionMode === "automatic") {
        timer = setTimeout(() => schedule(false), 2000);
      }
    };
    const unsubscribeStore = useSettingsStore.subscribe((next, prev) => {
      if (!prev || MIC_SETTING_KEYS.some((key) => next?.[key] !== prev[key])) schedule();
    });
    const unsubscribeTray = window.electronAPI?.onTrayMicrophoneSelection?.((selection) => {
      const state = useSettingsStore.getState();
      if (selection.mode === "specific" && selection.deviceId) {
        state.setSelectedMicDevice(selection.deviceId, selection.label || "");
      }
      state.setMicrophoneSelectionMode(selection.mode);
    });
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    schedule();

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribeStore();
      unsubscribeTray?.();
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
    };
  }, [captureActive]);
}
