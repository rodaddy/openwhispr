import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyListLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useAssistantPanel } from "./hooks/useAssistantPanel";
import { useNoteDestinationRequest } from "./hooks/useNoteDestinationRequest";
import { useLiveTranscriptPanel } from "./hooks/useLiveTranscriptPanel";
import { useMainWindowSizeOwner } from "./hooks/useMainWindowSizeOwner";
import { useMainProcessNotifications } from "./hooks/useMainProcessNotifications";
import { useListeningEntrancePhase } from "./hooks/useListeningEntrancePhase";
import { useWindowResizeCompensation } from "./hooks/useWindowResizeCompensation";
import { useTrayMicrophoneState } from "./hooks/useTrayMicrophoneState";
import { useBrainDumpRoundups } from "./hooks/useBrainDumpRoundups";
import { useSettingsStore } from "./stores/settingsStore";
import { useMeetingRecordingStore } from "./stores/meetingRecordingStore";
import { isAgentAllowed } from "./stores/policyRules";
import { usePolicyStore } from "./stores/policyStore";
import { VoicePill } from "./components/dictation/VoicePill";
import { AssistantPanel } from "./components/dictation/AssistantPanel";
import { LiveTranscriptPanel } from "./components/dictation/LiveTranscriptPanel";
import { VoiceModePanelCore } from "./components/dictation/VoiceModePanelCore";
import { PillTooltip } from "./components/dictation/PillTooltip";
import { PillCommandMenu } from "./components/dictation/PillCommandMenu";
import { LiquidCancelButton } from "./components/dictation/LiquidCancelButton";
import { createMainWindowResizeCoordinator } from "./utils/mainWindowResizeCoordinator";
import {
  ASSISTANT_FOOTER_TRANSITION_TIMING,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  resolveLiveTranscriptStageDurationMs,
  resolveLiveTranscriptEntrancePresentation,
  resolveAssistantFooterPresentation,
  resolveAgentModeActive,
  resolveListeningEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoiceHorizontalDirection,
  resolvePillVisualSuppression,
  resolveVoicePanelCorePresentation,
  resolveVoicePillDock,
  resolveVoicePillInteraction,
  VOICE_PILL_FOOTPRINT,
  isVoicePillActivationKey,
  LATENCY_CAPTION_MS,
  resolveLatencyCaption,
  resolveLatencyFlashPhase,
  shouldActivateVoicePill,
  shouldOfferLiveTranscriptReopen,
  shouldSuppressPillForAssistantActions,
} from "./helpers/voicePillPresentation";

const formatPillHotkeyLabel = (value) =>
  formatHotkeyListLabel(value)
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();

const UNMOUNTED_RESIZE = {
  success: false,
  superseded: true,
  message: "Resize coordinator not mounted",
};

export default function App() {
  const [dictationActivationState, setDictationActivationState] = useState("idle");
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const buttonRef = useRef(null);
  const { toast, dismiss, toastCount, dictationErrorActionCount, dismissByPresentation } =
    useToast();
  const { t } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const transcriptionPreviewLayout = useSettingsStore((s) => s.transcriptionPreviewLayout);
  const dictationShowLatency = useSettingsStore((s) => s.dictationShowLatency);
  const prevAutoHideRef = useRef(floatingIconAutoHide);
  const [voiceHorizontalDirection, setVoiceHorizontalDirection] = useState(() =>
    resolveVoiceHorizontalDirection(panelStartPosition)
  );
  const [mainWindowHorizontalDirection, setMainWindowHorizontalDirection] = useState(null);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);
  const dismissDictationError = React.useCallback(
    () => dismissByPresentation("dictation-error"),
    [dismissByPresentation]
  );

  useEffect(() => {
    let disposed = false;
    let eventSeen = false;
    const applyState = (state) => {
      if (disposed || !["idle", "held", "latched"].includes(state)) return;
      eventSeen = true;
      setDictationActivationState(state);
    };
    const unsubscribe = window.electronAPI?.onDictationActivationStateChanged?.(applyState);
    window.electronAPI
      ?.getDictationActivationState?.()
      .then((state) => {
        if (!eventSeen) applyState(state);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    let disposed = false;
    const applyDirection = (direction) => {
      if (!disposed && (direction === "left" || direction === "right")) {
        setMainWindowHorizontalDirection(direction);
      }
    };
    const unsubscribe =
      window.electronAPI?.onMainWindowHorizontalDirectionChanged?.(applyDirection);
    const initialDirection = window.electronAPI?.getMainWindowHorizontalDirection?.();
    initialDirection?.then(applyDirection).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useWindowResizeCompensation();
  useMainProcessNotifications({ toast, dismiss, t });

  const agentAllowed = usePolicyStore(isAgentAllowed);

  const mainWindowResizeCoordinatorRef = useRef(null);
  useEffect(() => {
    // Created in the effect, not lazily during render: React StrictMode's
    // dev-only setup→cleanup→setup cycle then disposes and recreates it
    // instead of disposing the only instance for the rest of the session.
    const coordinator = createMainWindowResizeCoordinator({
      resizeMainWindow: (sizeKey) => window.electronAPI?.resizeMainWindow?.(sizeKey),
      resizeAssistantWindowToContent: (height) =>
        window.electronAPI?.resizeAssistantWindowToContent?.(height),
    });
    mainWindowResizeCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (mainWindowResizeCoordinatorRef.current === coordinator) {
        mainWindowResizeCoordinatorRef.current = null;
      }
    };
  }, []);

  const requestMainWindowSize = React.useCallback(
    (sizeKey) =>
      mainWindowResizeCoordinatorRef.current?.resizeMainWindow(sizeKey) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );
  const resizeLiveTranscriptToContent = React.useCallback(
    (height) =>
      mainWindowResizeCoordinatorRef.current?.resizeAssistantWindowToContent(height) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );

  const onPanelOpened = React.useCallback(() => setIsHovered(false), []);

  // The assistant panel and the recording pipeline reference each other
  // (voice commands flow in, closing the panel cancels a recording), and the
  // live transcript needs recording state as effect deps. These refs break the
  // render-order cycle; both are read only at event time, never during render.
  const recordingControlsRef = useRef({});
  const liveTranscriptApiRef = useRef(null);

  const assistant = useAssistantPanel({
    requestMainWindowSize,
    dictationErrorActionCount,
    recordingControlsRef,
    onPanelOpened,
  });
  const { noteDictationError, openRef: assistantOpenRef } = assistant;
  const noteDestination = useNoteDestinationRequest();
  const resolveNoteDestinationVoiceCommand = noteDestination.resolveVoiceCommand;
  const handleAssistantPanelCommand = assistant.handleCommand;
  const handleAssistantCommand = React.useCallback(
    (command) => {
      if (resolveNoteDestinationVoiceCommand(command.text)) return;
      handleAssistantPanelCommand(command);
    },
    [handleAssistantPanelCommand, resolveNoteDestinationVoiceCommand]
  );

  const handleDictationError = React.useCallback(
    (options = {}) => {
      noteDictationError(options);
      liveTranscriptApiRef.current?.dismissForError();
    },
    [noteDictationError]
  );

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    if (!assistantOpenRef.current && !liveTranscriptApiRef.current?.openRef.current) {
      setWindowInteractivity(false);
    }
  }, [assistantOpenRef, setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    isAssistantVoice,
    isPreparing,
    isStopping,
    micCaptureStatus,
    latencyReadout,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    getAudioLevel,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onDemoEvent: (event) => {
      // Demo sessions only exist while onboarding is incomplete — skip the IPC otherwise.
      if (localStorage.getItem("onboardingCompleted") === "true") return;
      window.electronAPI?.publishOnboardingDemoEvent?.(event);
    },
    onAssistantCommand: handleAssistantCommand,
    dismissDictationError,
    onDictationError: handleDictationError,
    getAssistantSelectionContext: assistant.getSelectionContext,
    onShowTranscript: (text) => {
      // While the Agent panel is open the main window's transcript is suppressed
      // (openPanel refuses under assistantOpenRef); the companion hosts it instead.
      if (assistantOpenRef.current) {
        window.electronAPI?.showAgentDictationFinalTranscript?.(text);
        return;
      }
      liveTranscriptApiRef.current?.showFinalText(text);
    },
    assistantOpenRef,
  });
  const isVisuallyProcessing = isProcessing || isPreparing || isStopping;
  const meetingRecordingActive = useMeetingRecordingStore((state) => state.isRecording);
  useTrayMicrophoneState(isRecording || isPreparing || isStopping || meetingRecordingActive);
  // Daily brain-dump roundups (#423): this window always exists while the app
  // runs, even on a hidden or login launch, unlike the control panel.
  useBrainDumpRoundups();

  useLayoutEffect(() => {
    recordingControlsRef.current = {
      isAssistantVoice,
      isRecording,
      isPreparing,
      isProcessing,
      cancelRecording,
      cancelProcessing,
    };
  });

  const liveTranscript = useLiveTranscriptPanel({
    resizeToContent: resizeLiveTranscriptToContent,
    assistantOpenRef,
    onWillOpen: onPanelOpened,
    isRecording,
    isProcessing,
    isAssistantVoice,
  });

  useLayoutEffect(() => {
    liveTranscriptApiRef.current = liveTranscript;
  });

  // Must run before the size owner's ladder effect below: the error teardown
  // drops the live transcript's open ref, which the ladder reads this commit.
  useEffect(() => {
    if (dictationErrorActionCount > 0) handleDictationError();
  }, [dictationErrorActionCount, handleDictationError]);

  // Direction is part of the interaction's geometry, not a live decoration.
  // Hold the origin through processing and panel exit so every close animation
  // returns to the same side from which that voice session started.
  const voiceDirectionLocked =
    isRecording || isVisuallyProcessing || assistant.mounted || liveTranscript.mounted;
  useLayoutEffect(() => {
    if (voiceDirectionLocked) return;
    setVoiceHorizontalDirection(
      mainWindowHorizontalDirection ?? resolveVoiceHorizontalDirection(panelStartPosition)
    );
  }, [mainWindowHorizontalDirection, panelStartPosition, voiceDirectionLocked]);

  const { beginThinking: beginAssistantThinking } = assistant;
  useEffect(() => {
    if (isAssistantVoice && isProcessing && assistantOpenRef.current) {
      beginAssistantThinking();
    }
  }, [isAssistantVoice, isProcessing, assistantOpenRef, beginAssistantThinking]);

  // While the Agent panel is open, plain dictation renders on the
  // opposite-edge companion pill — neither its recording nor its processing
  // may animate the footer pill here. Ownership returns at close INTENT
  // (assistant.closing), not at fade completion: beginClose hides the
  // companion immediately, so waiting for the fade would leave a running
  // recording with no visual owner for the fade duration.
  const voicePillOwnsActivity = !assistant.open || assistant.closing || isAssistantVoice;
  const voicePillIsRecording = isRecording && voicePillOwnsActivity;
  const voicePillIsProcessing = (isProcessing || isStopping) && voicePillOwnsActivity;
  // #563: a start still opening the mic arms the floating pill (listening
  // shape, still bars) instead of reading as processing. Under the open Agent
  // panel the footer handoff owns the entrance, so arming stays off there.
  const voicePillIsArming = isPreparing && !isRecording && !isStopping && !assistant.open;
  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording: voicePillIsRecording,
    // Mic warm-up is an acknowledged press, not work on a transcript. Keeping
    // isPreparing out of the thinking state leaves the press on the arming
    // pill (#563) instead of lighting the glow at hotkey time.
    isProcessing: voicePillIsProcessing,
    isAssistantVoice,
    assistantThinking: assistant.thinking || assistant.busy,
  });
  const listeningEntrancePhase = useListeningEntrancePhase(voicePillIsRecording, {
    afterAssistantFooterHandoff: assistant.open,
    isArming: voicePillIsArming,
  });
  const listeningEntrance = resolveListeningEntrancePresentation({
    isRecording: voicePillIsRecording,
    isArming: voicePillIsArming,
    phase: listeningEntrancePhase,
  });
  // #699: each pasted take flashes its latency on the pill. A new readout
  // object queues the flash; its 2.5 s start once the pill rests.
  const [latencyFlashPhase, setLatencyFlashPhase] = useState("idle");
  useEffect(() => {
    if (latencyReadout) setLatencyFlashPhase("pending");
  }, [latencyReadout]);
  // isRecording and isVisuallyProcessing are the mic state's recording,
  // unavailable and processing values (getMicState below).
  const latencyPillBusy =
    voicePillIsRecording ||
    voicePillIsArming ||
    voicePillIsProcessing ||
    voiceActivity.activeState === "thinking" ||
    isRecording ||
    isVisuallyProcessing;
  const latencyPanelOpen =
    assistant.open || assistant.mounted || liveTranscript.open || liveTranscript.mounted;
  useEffect(() => {
    setLatencyFlashPhase((phase) =>
      resolveLatencyFlashPhase({
        phase,
        atRest: !latencyPillBusy && !latencyPanelOpen,
        recording: isRecording,
        settingOn: dictationShowLatency,
      })
    );
  }, [latencyFlashPhase, latencyPillBusy, latencyPanelOpen, isRecording, dictationShowLatency]);
  useEffect(() => {
    if (latencyFlashPhase !== "showing") return undefined;
    const timeout = setTimeout(() => setLatencyFlashPhase("idle"), LATENCY_CAPTION_MS);
    return () => clearTimeout(timeout);
  }, [latencyFlashPhase]);
  const latencyCaption = resolveLatencyCaption({
    settingOn: dictationShowLatency,
    flashActive: latencyFlashPhase === "showing",
    readout: latencyReadout,
    pillBusy: latencyPillBusy,
    panelOpen: latencyPanelOpen,
  });
  const latencyCaptionVisible = Boolean(latencyCaption);
  // With auto-hide on, the window may already be hidden when the paste lands.
  // The caption brings it back without focus; the auto-hide effect below hides
  // it again once the caption ends.
  useEffect(() => {
    if (latencyCaptionVisible && floatingIconAutoHide) window.electronAPI?.showDictationPanel?.();
  }, [latencyCaptionVisible, floatingIconAutoHide]);
  const isCompactPill =
    (voicePillIsRecording || voicePillIsArming
      ? listeningEntrance.compactPill
      : voiceActivity.compactPill) || latencyCaptionVisible;
  // BASE and RECORDING resolve to the same native box (windowConfig.js), so
  // recording edges never call setBounds — resizing the transparent window
  // always kicks a compositor frame. This flag still feeds the size ladder so
  // a menu opening over the compact pill resolves to EXPANDED geometry.
  const windowFitsCompactPill =
    voicePillIsRecording || voicePillIsArming || voiceActivity.compactPill || latencyCaptionVisible;

  const { dictationErrorPillHandoffActive, panelReturnResizeActive } = useMainWindowSizeOwner({
    requestMainWindowSize,
    dictationErrorActionCount,
    toastCount,
    isCommandMenuOpen,
    isCompactPill: windowFitsCompactPill,
    assistantOpen: assistant.open,
    assistantMounted: assistant.mounted,
    assistantOpenRef,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
    liveTranscriptOpenRef: liveTranscript.openRef,
    isTakeLive: isRecording || isVisuallyProcessing,
  });

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0 || assistant.mounted || liveTranscript.mounted) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [
    isCommandMenuOpen,
    isHovered,
    toastCount,
    assistant.mounted,
    liveTranscript.mounted,
    setWindowInteractivity,
  ]);

  useEffect(() => {
    if (isRecording && dictationErrorActionCount > 0) {
      dismissByPresentation("dictation-error");
    }
  }, [isRecording, dictationErrorActionCount, dismissByPresentation]);

  // Sync auto-hide from main process — setState directly to avoid IPC echo
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  const isRecordingRef = useRef(isRecording);

  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelHotkeyPressed?.(() => {
      if (isRecordingRef.current) cancelRecording("escape-hotkey");
    });
    return () => unsubscribe?.();
  }, [cancelRecording]);

  // The Agent companion pill's cancel button routes here: only this renderer
  // owns the recording, so it decides what "cancel" means at arrival time.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelDictation?.(() => {
      if (isRecording || isPreparing) cancelRecording("agent-pill");
      else if (isProcessing) cancelProcessing();
    });
    return () => unsubscribe?.();
  }, [isRecording, isPreparing, isProcessing, cancelRecording, cancelProcessing]);

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (
      floatingIconAutoHide &&
      !isRecording &&
      !isVisuallyProcessing &&
      toastCount === 0 &&
      !dictationErrorPillHandoffActive &&
      !assistant.mounted &&
      !liveTranscript.mounted &&
      !latencyCaptionVisible
    ) {
      // Delay briefly so processing can start after recording stops without a flash
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 500);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [
    isRecording,
    isVisuallyProcessing,
    floatingIconAutoHide,
    toastCount,
    dictationErrorPillHandoffActive,
    assistant.mounted,
    liveTranscript.mounted,
    latencyCaptionVisible,
  ]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        // The assistant panel owns Escape while it is open.
        if (assistant.mounted) return;
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else if (isRecording) {
          cancelRecording("escape-key");
        } else if (isPreparing) {
          cancelRecording("escape-key");
        } else if (isProcessing) {
          cancelProcessing();
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [
    isCommandMenuOpen,
    assistant.mounted,
    isRecording,
    isPreparing,
    isProcessing,
    cancelRecording,
    cancelProcessing,
  ]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isVisuallyProcessing) return "processing";
    if (isHovered && !isRecording && !isVisuallyProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const getMicTooltip = () => {
    if (voicePillIsArming) return t("app.mic.waitingForMicrophone");
    switch (micState) {
      case "recording":
        return t("app.mic.recording");
      case "unavailable":
        return t("app.mic.waitingForMicrophone");
      case "processing":
        return t("app.mic.processing");
      default:
        return formatPillHotkeyLabel(hotkey);
    }
  };

  const micTooltip = getMicTooltip();
  const assistantVoiceState =
    isRecording && isAssistantVoice
      ? "listening"
      : isProcessing && isAssistantVoice
        ? "transcribing"
        : "idle";
  const anyPanelOpen = assistant.open || liveTranscript.open;
  const anyPanelMounted = assistant.mounted || liveTranscript.mounted;
  const canReopenLiveTranscript =
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: liveTranscript.manuallyCollapsed,
      isRecording,
      isProcessing,
      isAssistantVoice,
    }) && !anyPanelMounted;
  const agentModeActive = resolveAgentModeActive({
    isAssistantVoice,
    isRecording,
    isProcessing: isVisuallyProcessing,
    assistantPanelMounted: assistant.mounted,
  });
  const assistantFooter = resolveAssistantFooterPresentation(assistant.footerPhase);
  const voicePillInteraction = resolveVoicePillInteraction({
    assistantMounted: assistant.mounted,
    liveTranscriptMounted: liveTranscript.mounted,
    isRecording,
    isProcessing,
    isHovered,
  });
  const pillIsInteractive = voicePillInteraction.pillInteractive;
  // The cancel button pours out of the pill as a fused liquid skin — except
  // inside the Live Transcript panel, where the pill is already headless and
  // the classic bordered circle stays (with the same emergence motion).
  const [cancelSkinActive, setCancelSkinActive] = useState(false);
  const cancelFused = !liveTranscript.open;
  // isCompactPill tracks the pill's footprint through the entrance phases
  // (logo-collapsed thinking renders 40×40 even while recording). These are
  // targets, not rendered sizes: the pill transitions between footprints over
  // GROW_TRANSITION, and the skin tweens its geometry to match
  // (usePillFootprintTween in LiquidCancelButton).
  const cancelPillFootprint = isCompactPill
    ? VOICE_PILL_FOOTPRINT.recording
    : VOICE_PILL_FOOTPRINT.idle;
  const activateVoicePill = () => {
    if (!pillIsInteractive) return;
    if (canReopenLiveTranscript) {
      liveTranscript.reopen();
      return;
    }
    if (
      shouldActivateVoicePill({
        hasDragged,
        liveTranscriptMounted: liveTranscript.mounted,
        isProcessing: micState === "processing",
        isAgentThinking: voiceActivity.isAgentThinking,
      })
    ) {
      setIsCommandMenuOpen(false);
      toggleListening({ voiceAgentRequested: assistant.mounted });
    }
  };
  // Prefer a currently open mode over a sibling finishing its exit. The core
  // itself never unmounts; only these inner sections change ownership.
  const activeVoicePanel = resolveVoicePanelCorePresentation({
    assistantOpen: assistant.open,
    assistantMounted: assistant.mounted,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
  });
  const activeVoicePanelMode = activeVoicePanel.mode;
  const liveTranscriptEntrance = resolveLiveTranscriptEntrancePresentation(
    liveTranscript.entrancePhase
  );
  const activeVoicePanelLabel =
    activeVoicePanelMode === "assistant"
      ? t("settingsPage.agentConfig.title")
      : activeVoicePanelMode === "live-transcript"
        ? t("transcriptionPreview.label")
        : undefined;
  const commonPillState =
    micState === "unavailable"
      ? "unavailable"
      : listeningEntrance.activeState ||
        voiceActivity.activeState ||
        (assistant.open ? (isHovered ? "hover" : "idle") : micState);
  const voicePillDock = resolveVoicePillDock({
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptEntrancePhase: liveTranscript.entrancePhase,
    assistantOpen: assistant.open,
    panelStartPosition,
    horizontalDirection: voiceHorizontalDirection,
  });
  const voicePillTravelDuration = resolveLiveTranscriptStageDurationMs(
    liveTranscript.open && liveTranscript.entrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs
  );
  const dictationErrorSuppressesPill =
    dictationErrorActionCount > 0 || dictationErrorPillHandoffActive;
  // Keep one pill DOM node alive while final Agent actions own the footer. On
  // close it can fade and travel from the panel dock instead of mounting at
  // the resting dock halfway through the surface contraction.
  const pillHasLiveActivity = voicePillIsRecording || voicePillIsProcessing;
  const assistantActionsSuppressPill = shouldSuppressPillForAssistantActions({
    assistantOpen: assistant.open,
    footerPillVisible: assistantFooter.pillVisible,
    assistantClosing: assistant.closing,
    hasLiveActivity: pillHasLiveActivity,
  });
  // assistant.closing folds the pill into the panel's own exit: it fades with
  // the closing content, stays hidden through the surface contraction, the
  // travel, and the masked window shrink (panelReturnResizeActive picks up at
  // unmount), and materializes once at its settled dock — one beat, not a
  // condense-then-blink. Live activity opts out of that fold: the pill is the
  // only owner left once beginClose hides the companion.
  const pillVisuallySuppressed = resolvePillVisualSuppression({
    dictationErrorSuppressed: dictationErrorSuppressesPill,
    assistantActionsSuppressed: assistantActionsSuppressPill,
    assistantClosing: assistant.closing,
    panelReturnResizeActive,
    hasLiveActivity: pillHasLiveActivity,
  });

  return (
    <div className="dictation-window">
      {/* The panel footer can hide this pill, but never unmounts it. */}
      <div
        className={`voice-pill-position voice-pill-position-${voicePillDock} fixed z-50 transition-opacity duration-150 ease-out ${
          pillVisuallySuppressed ? "pointer-events-none" : ""
        } ${pillVisuallySuppressed ? "opacity-0" : "opacity-100"}`}
        style={{
          "--voice-pill-travel-duration": `${voicePillTravelDuration}ms`,
        }}
        data-dictation-error-suppressed={dictationErrorSuppressesPill || undefined}
        data-assistant-actions-suppressed={assistantActionsSuppressPill || undefined}
        aria-hidden={pillVisuallySuppressed || undefined}
      >
        <div
          className="assistant-pill-presence relative flex items-center"
          data-assistant-footer-phase={assistant.open ? assistant.footerPhase : undefined}
          data-horizontal-direction={voiceHorizontalDirection}
          style={{
            "--assistant-pill-retreat-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.pillRetreatMs}ms`,
            "--assistant-pill-entrance-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.pillEntranceMs}ms`,
          }}
          onMouseEnter={() => {
            if (!pillIsInteractive) return;
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            if (!pillIsInteractive) return;
            if (!isCommandMenuOpen && !assistant.mounted) {
              setWindowInteractivity(false);
            }
          }}
        >
          <PillTooltip
            content={canReopenLiveTranscript ? t("transcriptionPreview.label") : micTooltip}
            disabled={anyPanelMounted}
            align={panelStartPosition === "center" ? "center" : voiceHorizontalDirection}
          >
            <VoicePill
              ref={buttonRef}
              variant={anyPanelOpen ? "panel" : "floating"}
              state={commonPillState}
              expanded={!anyPanelOpen && isCompactPill}
              collapseToLogo={
                listeningEntrance.collapseToLogo || assistantFooter.collapsePillToLogo
              }
              waveformVisible={listeningEntrance.waveformVisible}
              waveformOnlyWhileRecording={anyPanelMounted}
              integratedWithPanel={liveTranscript.open}
              liquidFused={cancelSkinActive}
              agentMode={agentModeActive}
              showExpandChevron={canReopenLiveTranscript && isHovered}
              getAudioLevel={getAudioLevel}
              activationState={dictationActivationState}
              caption={
                latencyCaption
                  ? {
                      top: t("transcriptionPreview.latencyLast", { ms: latencyCaption.lastMs }),
                      bottom:
                        latencyCaption.averageMs === null
                          ? null
                          : t("transcriptionPreview.latencyAverageShort", {
                              average: latencyCaption.averageMs,
                            }),
                    }
                  : null
              }
              isDragging={isDragging}
              horizontalDirection={voiceHorizontalDirection}
              role={pillIsInteractive ? "button" : "status"}
              tabIndex={pillIsInteractive ? 0 : undefined}
              aria-label={
                canReopenLiveTranscript
                  ? t("transcriptionPreview.label")
                  : assistant.mounted
                    ? t("settingsPage.agentConfig.title")
                    : liveTranscript.mounted
                      ? t("transcriptionPreview.label")
                      : micTooltip
              }
              onMouseDown={(e) => {
                if (anyPanelMounted) {
                  setHasDragged(false);
                  return;
                }
                setIsCommandMenuOpen(false);
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
                if (anyPanelMounted) return;
                if (dragStartPos && !hasDragged) {
                  const distance = Math.sqrt(
                    Math.pow(e.clientX - dragStartPos.x, 2) +
                      Math.pow(e.clientY - dragStartPos.y, 2)
                  );
                  if (distance > 5) {
                    // 5px threshold for drag
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                if (anyPanelMounted) return;
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                activateVoicePill();
                e.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.repeat || !isVoicePillActivationKey(event.key)) return;
                event.preventDefault();
                activateVoicePill();
              }}
              onContextMenu={(e) => {
                if (anyPanelMounted) return;
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
            />
          </PillTooltip>
          <LiquidCancelButton
            visible={voicePillInteraction.cancelVisible}
            fused={cancelFused}
            pillWidth={cancelPillFootprint.width}
            pillHeight={cancelPillFootprint.height}
            pillState={commonPillState}
            ariaLabel={
              isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
            }
            onCancel={() => {
              if (isRecording) cancelRecording("pill-button");
              else cancelProcessing();
            }}
            onFusedSkinChange={setCancelSkinActive}
          />
          {!anyPanelMounted && isCommandMenuOpen && (
            <PillCommandMenu
              buttonRef={buttonRef}
              isRecording={isRecording}
              agentAllowed={agentAllowed}
              isHovered={isHovered}
              setWindowInteractivity={setWindowInteractivity}
              onToggleListening={() => {
                toggleListening();
              }}
              onAskAssistant={() => {
                setIsCommandMenuOpen(false);
                assistant.openPanel();
              }}
              onHide={() => {
                setIsCommandMenuOpen(false);
                setWindowInteractivity(false);
                handleClose();
              }}
              onClose={() => setIsCommandMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <VoiceModePanelCore
        mode={activeVoicePanelMode}
        open={activeVoicePanel.open}
        closing={activeVoicePanelMode === "assistant" && assistant.closing}
        stage={
          activeVoicePanelMode === "live-transcript" ? liveTranscriptEntrance.coreStage : "content"
        }
        horizontalDirection={voiceHorizontalDirection}
        label={activeVoicePanelLabel}
        measurementRevision={
          activeVoicePanelMode === "live-transcript" ? liveTranscript.measurementText : null
        }
        onPreferredHeightChange={liveTranscript.requestHeight}
        transcriptionPreviewLayout={transcriptionPreviewLayout}
        onClosingFadeComplete={assistant.completeContentFade}
      >
        {activeVoicePanelMode === "assistant" && assistant.mounted && (
          <AssistantPanel
            pendingCommand={assistant.pendingCommand}
            onCommandConsumed={assistant.handleCommandConsumed}
            onCommandDiscarded={assistant.handleCommandDiscarded}
            onCommandSettled={assistant.handleCommandSettled}
            initialConversationId={assistant.conversationId}
            onConversationIdChange={assistant.setConversationId}
            voiceState={assistantVoiceState}
            thinking={assistant.thinking && assistant.open}
            open={assistant.open}
            footerPhase={assistant.footerPhase}
            horizontalDirection={voiceHorizontalDirection}
            onClose={assistant.handleClose}
            onBusyChange={assistant.setBusy}
            onResponseReadyChange={assistant.setResponseReady}
            onResponseContent={assistant.handleResponseContent}
            onConversationReset={assistant.handleConversationReset}
            onSelectionContextChange={assistant.handleSelectionContextChange}
            noteDestination={noteDestination}
          />
        )}

        {activeVoicePanelMode !== "assistant" && (
          <LiveTranscriptPanel
            text={liveTranscript.mounted ? liveTranscript.text : ""}
            measurementText={liveTranscript.mounted ? liveTranscript.measurementText : ""}
            phase={liveTranscript.phase}
            processing={liveTranscript.mounted && isProcessing && !isAssistantVoice}
            controlsVisible={liveTranscript.mounted && liveTranscriptEntrance.controlsVisible}
            contentVisible={liveTranscript.mounted && liveTranscriptEntrance.contentVisible}
            onCollapse={() => liveTranscript.close({ suppress: true })}
            onHoldChange={liveTranscript.holdFinal}
            layout={transcriptionPreviewLayout}
            latency={dictationShowLatency ? latencyReadout : null}
          />
        )}
      </VoiceModePanelCore>
    </div>
  );
}
