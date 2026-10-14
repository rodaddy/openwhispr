import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import type { GrillTopicRow } from "../types/electron";

/** Editor results are intersections, so narrow on the failure member explicitly. */
const failed = (result: { success: boolean }): result is { success: false; error: string } =>
  !result.success;

// The "To grill" list: pending topics the next daily grill asks
// first. Brain dumps land here through Process; Rico can add or drop one by hand.
export function GrillTopicsCard() {
  const { t } = useTranslation();
  const [topics, setTopics] = useState<GrillTopicRow[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await window.electronAPI.grillTopicsList?.("pending");
    if (!result) return;
    if (failed(result)) return setError(result.error);
    setTopics(result.topics);
    setError(null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    const next = text.trim();
    if (!next) return;
    const result = await window.electronAPI.grillTopicsAdd?.({ text: next, source: "manual" });
    if (result && failed(result)) return setError(result.error);
    setText("");
    await reload();
  };

  const remove = async (id: string) => {
    const result = await window.electronAPI.grillTopicsRemove?.(id);
    if (result && failed(result)) return setError(result.error);
    await reload();
  };

  return (
    <div>
      <SectionHeader title={t("grillTopics.title")} description={t("grillTopics.description")} />
      <SettingsPanel>
        {error && (
          <SettingsPanelRow>
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          </SettingsPanelRow>
        )}
        <SettingsPanelRow>
          <div className="flex flex-col gap-2">
            {topics.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("grillTopics.empty")}</p>
            ) : (
              topics.map((topic) => (
                <div key={topic.id} className="flex items-center gap-2">
                  <span className="flex-1 text-xs text-foreground">{topic.text}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-xs"
                    aria-label={t("grillTopics.remove")}
                    onClick={() => void remove(topic.id)}
                  >
                    ×
                  </Button>
                </div>
              ))
            )}
            <div className="flex items-center gap-2">
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("grillTopics.addPlaceholder")}
                className="h-7 flex-1 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!text.trim()}
                onClick={() => void add()}
              >
                {t("grillTopics.add")}
              </Button>
            </div>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
