import { useRef } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "../../stores/settingsStore";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import {
  getTranscriptionApiKey,
  type FileTranscriptionConfig,
} from "../../services/fileTranscription";

/**
 * The regular transcription pipeline's config (all providers, no LLM pass),
 * for a recorded take. Returns a stable getter that always reads the current
 * settings, so a recorder callback bound earlier still transcribes with them.
 */
export function useTranscriptionConfig(): () => FileTranscriptionConfig {
  const { isSignedIn } = useAuth();
  const settings = useSettings();
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);

  const build = (): FileTranscriptionConfig => ({
    useLocalWhisper: settings.useLocalWhisper,
    localTranscriptionProvider: settings.localTranscriptionProvider as string,
    whisperModel: settings.whisperModel,
    parakeetModel: settings.parakeetModel,
    cohereModel: settings.cohereModel,
    isOpenWhisprCloud:
      isSignedIn && settings.cloudTranscriptionMode === "openwhispr" && !settings.useLocalWhisper,
    getApiKey: () =>
      getTranscriptionApiKey(settings.cloudTranscriptionProvider as string, settings),
    cloudTranscriptionProvider: settings.cloudTranscriptionProvider as string,
    cloudTranscriptionBaseUrl: settings.cloudTranscriptionBaseUrl || "",
    cloudTranscriptionModel: settings.cloudTranscriptionModel,
    // Empty = auto-detect; the resolver supplies a default where one is required.
    language: getBaseLanguageCode(settings.preferredLanguage) || "",
    cortiEnvironment,
    cortiTenant,
    transcriptionMode: settings.transcriptionMode,
    remoteTranscriptionUrl: settings.remoteTranscriptionUrl,
    remoteTranscriptionModel: settings.remoteTranscriptionModel,
  });

  const buildRef = useRef(build);
  buildRef.current = build;
  const getterRef = useRef<() => FileTranscriptionConfig>(() => buildRef.current());
  return getterRef.current;
}
