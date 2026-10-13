import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { resolveMicDeviceSelection } from "./micDeviceSelection";

export const MICROPHONE_SELECTION_MODES = ["automatic", "system", "built-in", "specific"];

const LARK_M2_RECEIVER_LABEL = "wireless microphone (3547:0007)";

export function isLarkM2Receiver(device) {
  return normalizeMicrophoneLabel(device?.label) === LARK_M2_RECEIVER_LABEL;
}

export async function getLarkM2TrackAvailability(
  track,
  getStatus = () => window.electronAPI?.getLarkM2Status?.({ refresh: true })
) {
  if (!isLarkM2Receiver(track)) return null;
  try {
    const status = larkConnectionStatus(await getStatus?.());
    if (status === "connected") return true;
    if (status === "disconnected") return false;
  } catch {
    // A failed/timeout status read is unknown, not evidence of transmitter loss.
  }
  return null;
}

function larkConnectionStatus(wirelessStatus) {
  const status = typeof wirelessStatus === "string" ? wirelessStatus : wirelessStatus?.status;
  return status === "connected" || status === "disconnected" ? status : "unknown";
}

function selectableInputs(devices, wirelessStatus, excludedDeviceIds = null) {
  const larkDisconnected = larkConnectionStatus(wirelessStatus) === "disconnected";
  return devices.filter(
    (device) =>
      device.kind === "audioinput" &&
      !excludedDeviceIds?.has?.(device.deviceId) &&
      !(larkDisconnected && isLarkM2Receiver(device))
  );
}

const inputsContainLark = (devices) => devices.some(isLarkM2Receiver);

export function getMicrophoneSelectionMode(settings = {}) {
  if (MICROPHONE_SELECTION_MODES.includes(settings.microphoneSelectionMode)) {
    return settings.microphoneSelectionMode;
  }
  if (settings.preferBuiltInMic) return "built-in";
  return settings.selectedMicDeviceId && settings.selectedMicDeviceId !== "default"
    ? "specific"
    : "system";
}

export function normalizeMicrophoneLabel(label = "") {
  return String(label)
    .normalize("NFKC")
    .replace(/^\s*(?:default|communications)\s*-\s*/i, "")
    .replace(/\s*\((?:built[ -]?in|default)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function comparableLabel(label) {
  return normalizeMicrophoneLabel(label).replace(/[^\p{L}\p{N}]+/gu, "");
}

export function resolveSystemDefaultMicDevice(devices, systemDefault) {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const chromiumDefault = inputs.find((device) => device.deviceId === "default") || null;
  const physicalInputs = inputs.filter(
    (device) =>
      device.deviceId !== "default" &&
      device.deviceId !== "communications" &&
      !/^communications\s*-/i.test(device.label || "")
  );
  const nativeName = systemDefault?.name?.trim();

  if (nativeName) {
    const target = comparableLabel(nativeName);
    const exactMatches = physicalInputs.filter(
      (device) => target && comparableLabel(device.label) === target
    );
    if (exactMatches.length === 1) {
      return { device: exactMatches[0], status: "native-exact", systemDefault };
    }

    const containedMatches = physicalInputs.filter((device) => {
      const candidate = comparableLabel(device.label);
      return (
        target.length >= 8 &&
        candidate.length >= 8 &&
        (candidate.includes(target) || target.includes(candidate))
      );
    });
    if (containedMatches.length === 1) {
      return { device: containedMatches[0], status: "native-compatible", systemDefault };
    }
  }

  // Chromium's default alias and its physical device share a groupId. This is
  // the only safe way to disambiguate duplicate labels; a native UID is from a
  // different identity namespace and must never be compared with deviceId.
  if (chromiumDefault?.groupId) {
    const groupMatches = physicalInputs.filter(
      (device) => device.groupId && device.groupId === chromiumDefault.groupId
    );
    if (groupMatches.length === 1) {
      return { device: groupMatches[0], status: "chromium-group-alias", systemDefault };
    }
  }

  if (chromiumDefault) {
    return {
      device: chromiumDefault,
      status: nativeName ? "chromium-default-unmatched" : "chromium-default",
      systemDefault,
    };
  }

  return {
    device: null,
    status: nativeName ? "native-unmatched" : "unavailable",
    systemDefault,
  };
}

export function resolveMicrophoneSelection(
  devices,
  settings,
  systemDefault = null,
  wirelessStatus = null
) {
  const mode = getMicrophoneSelectionMode(settings);
  const inputs = selectableInputs(devices, wirelessStatus);

  if (mode === "automatic") {
    const preferred = resolveMicDeviceSelection(
      inputs,
      settings.preferredMicDeviceId,
      settings.preferredMicDeviceLabel
    );
    if (preferred.device) return { mode, ...preferred, source: "preferred" };

    const fallback = resolveMicDeviceSelection(
      inputs,
      settings.fallbackMicDeviceId,
      settings.fallbackMicDeviceLabel
    );
    if (fallback.device) return { mode, ...fallback, source: "configured-fallback" };

    return {
      mode,
      ...resolveSystemDefaultMicDevice(inputs, systemDefault),
      source: "system-default",
    };
  }

  if (mode === "system") {
    return {
      mode,
      ...resolveSystemDefaultMicDevice(inputs, systemDefault),
      source: "system-default",
    };
  }

  if (mode === "built-in") {
    const device = inputs.find(
      (candidate) => candidate.deviceId !== "default" && isBuiltInMicrophone(candidate.label)
    );
    return {
      mode,
      device: device || null,
      status: device ? "built-in" : "unavailable",
      source: "built-in",
    };
  }

  const selection = resolveMicDeviceSelection(
    inputs,
    settings.selectedMicDeviceId,
    settings.selectedMicDeviceLabel
  );
  return { mode, ...selection, source: "specific" };
}

export function isCacheableMicrophoneResolution(resolution) {
  const deviceId = resolution?.device?.deviceId;
  return Boolean(resolution?.mode !== "automatic" && deviceId && deviceId !== "default");
}

export async function resolvePreferredMicrophone({
  settings,
  mediaDevices = navigator.mediaDevices,
  forceSystemDefault = false,
  refreshSystemDefault = false,
  getSystemDefault = (options) => window.electronAPI?.getSystemDefaultMicrophone?.(options),
  // Recording paths need the live transmitter state; a transmitter switching
  // off fires no devicechange, so the 30 s main-process cache would hide it.
  getWirelessStatus = () => window.electronAPI?.getLarkM2Status?.({ refresh: true }),
  excludedDeviceIds = null,
}) {
  const requestedMode = getMicrophoneSelectionMode(settings);
  const effectiveSettings = forceSystemDefault
    ? { ...settings, microphoneSelectionMode: "system", preferBuiltInMic: false }
    : settings;
  const mode = getMicrophoneSelectionMode(effectiveSettings);
  const devices = await mediaDevices.enumerateDevices();
  let systemDefault = null;

  if (mode === "system" || mode === "automatic") {
    try {
      systemDefault = (await getSystemDefault?.({ refresh: refreshSystemDefault })) || null;
    } catch {
      // The explicit Chromium "default" device below remains the safe fallback.
    }
  }

  let wirelessStatus = null;
  if (requestedMode === "automatic" && inputsContainLark(devices)) {
    try {
      wirelessStatus = (await getWirelessStatus?.()) || null;
    } catch {
      wirelessStatus = null;
    }
  }

  const excludedGroupIds = new Set(
    excludedDeviceIds
      ? devices
          .filter((device) => excludedDeviceIds.has(device.deviceId))
          .map((device) => device.groupId)
          .filter(Boolean)
      : []
  );
  const eligibleDevices = excludedDeviceIds
    ? devices.filter(
        (device) =>
          !excludedDeviceIds.has(device.deviceId) &&
          !(device.groupId && excludedGroupIds.has(device.groupId))
      )
    : devices;
  const result = resolveMicrophoneSelection(
    eligibleDevices,
    effectiveSettings,
    systemDefault,
    wirelessStatus
  );
  if (
    result.mode === "specific" &&
    result.device &&
    (result.status === "remapped" || !settings.selectedMicDeviceLabel)
  ) {
    settings.setSelectedMicDevice?.(result.device.deviceId, result.device.label);
  }
  return result;
}
