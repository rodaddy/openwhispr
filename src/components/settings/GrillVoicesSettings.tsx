import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import {
  addGrillVoice,
  removeGrillVoice,
  resolveGrillVoice,
  SKIPPY_VOICE_ID,
  type GrillVoice,
} from "../../services/grill/grillVoices";

interface GrillVoicesSettingsProps {
  voices: GrillVoice[];
  voiceId: string;
  onVoicesChange: (voices: GrillVoice[]) => void;
  onVoiceIdChange: (id: string) => void;
}

// The spoken grill's voice: pick one, or add a voice from a WAV clip plus the
// exact words spoken in it (OmniVoice clones from that pair). Skippy is the
// assistant's own voice profile and cannot be removed.
export function GrillVoicesSettings({
  voices,
  voiceId,
  onVoicesChange,
  onVoiceIdChange,
}: GrillVoicesSettingsProps) {
  const { t } = useTranslation();
  const selected = resolveGrillVoice(voices, voiceId);
  const [name, setName] = useState("");
  const [promptText, setPromptText] = useState("");
  const [clipPath, setClipPath] = useState("");
  const [error, setError] = useState("");

  const chooseClip = async () => {
    setError("");
    try {
      const result = await window.electronAPI?.importGrillVoiceClip?.();
      if (result?.success && result.referenceAudioPath) setClipPath(result.referenceAudioPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = () => {
    try {
      const next = addGrillVoice(voices, { name, referenceAudioPath: clipPath, promptText });
      onVoicesChange(next);
      onVoiceIdChange(next[next.length - 1].id);
      setName("");
      setPromptText("");
      setClipPath("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (id: string) => {
    onVoicesChange(removeGrillVoice(voices, id));
    if (id === selected.id) onVoiceIdChange(SKIPPY_VOICE_ID);
  };

  return (
    <div>
      <SectionHeader
        title={t("settingsPage.general.grillVoices.title")}
        description={t("settingsPage.general.grillVoices.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.general.grillVoices.voice")}>
            <div className="flex items-center gap-2">
              <Select value={selected.id} onValueChange={onVoiceIdChange}>
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id} className="text-xs">
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected.id !== SKIPPY_VOICE_ID && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => remove(selected.id)}
                >
                  {t("settingsPage.general.grillVoices.remove")}
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">
              {t("settingsPage.general.grillVoices.addTitle")}
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settingsPage.general.grillVoices.namePlaceholder")}
              className="h-7 text-xs"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void chooseClip()}
              >
                {t("settingsPage.general.grillVoices.chooseClip")}
              </Button>
              <span className="truncate text-xs text-muted-foreground">
                {clipPath
                  ? t("settingsPage.general.grillVoices.clipChosen")
                  : t("settingsPage.general.grillVoices.noClip")}
              </span>
            </div>
            <Input
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t("settingsPage.general.grillVoices.transcriptPlaceholder")}
              className="h-7 text-xs"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!name.trim() || !clipPath || !promptText.trim()}
                onClick={add}
              >
                {t("settingsPage.general.grillVoices.add")}
              </Button>
              {error && (
                <span role="alert" className="text-xs text-destructive">
                  {error}
                </span>
              )}
            </div>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
