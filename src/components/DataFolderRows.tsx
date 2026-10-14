import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "./ui/button";
import { SettingsRow } from "./ui/SettingsSection";
import type { AlertDialogState, ConfirmDialogState } from "../hooks/useDialogs";

type DataFolderInfo = { current: string; previous: string | null; canMove: boolean };

// Settings > Data folder. The picker, confirm, and restart are native
// dialogs in main; this row only shows where the data is and starts the move.
type Props = {
  showConfirmDialog: (options: Omit<ConfirmDialogState, "open">) => void;
  showAlertDialog: (options: Omit<AlertDialogState, "open">) => void;
};

export default function DataFolderRows({ showConfirmDialog, showAlertDialog }: Props) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DataFolderInfo | null>(null);

  useEffect(() => {
    window.electronAPI
      ?.getDataFolderInfo?.()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const failed = (reason?: string) =>
    showAlertDialog({
      title: t("settingsPage.developer.dataFolder.removeOld"),
      description: t("settingsPage.developer.dataFolder.removeOldFailed", { reason }),
    });

  // Size first so the confirm names what will be freed.
  const removeOldCopy = async () => {
    const size = await window.electronAPI?.getOldDataCopySize?.();
    if (!size?.ok) return failed(size?.reason);
    showConfirmDialog({
      title: t("settingsPage.developer.dataFolder.removeOld"),
      description: t("settingsPage.developer.dataFolder.removeOldConfirm", { size: size.size }),
      variant: "destructive",
      confirmText: t("settingsPage.developer.dataFolder.removeOld"),
      onConfirm: async () => {
        const result = await window.electronAPI?.removeOldDataCopy?.();
        if (result?.ok) setInfo((prev) => (prev ? { ...prev, previous: null } : prev));
        else failed(result?.reason);
      },
    });
  };

  if (!info) return null;
  return (
    <div className="space-y-3">
      <SettingsRow label={t("settingsPage.developer.dataFolder.label")} description={info.current}>
        <Button
          variant="outline"
          size="sm"
          disabled={!info.canMove}
          onClick={() => window.electronAPI?.moveDataFolder?.()}
        >
          {t("settingsPage.developer.dataFolder.move")}
        </Button>
      </SettingsRow>
      {info.previous && (
        <SettingsRow
          label={t("settingsPage.developer.dataFolder.previous", { path: info.previous })}
          description={t("settingsPage.developer.dataFolder.previousHint")}
        >
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.electronAPI?.revealPreviousDataFolder?.()}
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {t("settingsPage.developer.dataFolder.reveal")}
            </Button>
            <Button variant="outline" size="sm" onClick={removeOldCopy}>
              {t("settingsPage.developer.dataFolder.removeOld")}
            </Button>
          </div>
        </SettingsRow>
      )}
    </div>
  );
}
