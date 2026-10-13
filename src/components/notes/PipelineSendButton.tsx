import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send } from "lucide-react";
import { cn } from "../lib/utils";
import { GLASS_SURFACE } from "../ui/glass";
import { useToast } from "../ui/useToast";
import type { PipelineSyncState } from "../../types/pipeline";

interface PipelineSendButtonProps {
  noteId: number | null | undefined;
  disabled?: boolean;
}

/**
 * "Send to pipeline" on a grill note: posts it to the social-media-pipeline
 * now. Re-sending is safe (the pipeline replaces the session by note_id).
 * Renders nothing for a note without grill turns.
 */
export default function PipelineSendButton({ noteId, disabled = false }: PipelineSendButtonProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [state, setState] = useState<PipelineSyncState | null>(null);
  const [configured, setConfigured] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    if (noteId == null || !window.electronAPI?.pipelineGetSyncState) return;
    void Promise.all([
      window.electronAPI.pipelineGetSettings(),
      window.electronAPI.pipelineGetSyncState(noteId),
    ]).then(([settings, sync]) => {
      if (cancelled) return;
      setConfigured("settings" in settings && settings.settings.configured);
      setState("state" in sync ? sync.state : null);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const send = useCallback(async () => {
    if (noteId == null) return;
    setSending(true);
    const result = await window.electronAPI.pipelineSendNote(noteId);
    setSending(false);
    if ("state" in result) {
      setState({ ...result.state, eligible: true });
      toast({
        title: t("notes.pipeline.sent", { count: result.state.piecesAdded ?? 0 }),
      });
    } else {
      const refreshed = await window.electronAPI.pipelineGetSyncState(noteId);
      if ("state" in refreshed) setState(refreshed.state);
      toast({
        title: t("notes.pipeline.failed", { reason: result.error }),
        variant: "destructive",
      });
    }
  }, [noteId, t, toast]);

  if (!state?.eligible) return null;

  const title = !configured ? t("notes.pipeline.configureFirst") : (state.lastError ?? undefined);

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={!configured || disabled || sending}
      title={title}
      className={cn(
        "shrink-0 h-11 mr-2 px-3 rounded-full border border-black/10 dark:border-white/14",
        GLASS_SURFACE,
        "inline-flex items-center gap-1.5 text-xs font-medium text-foreground/65",
        "hover:text-foreground hover:border-primary/25 transition-colors",
        "disabled:opacity-35 disabled:pointer-events-none"
      )}
    >
      {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
      <span className="hidden min-[760px]:inline">
        {state.syncedAt ? t("notes.pipeline.resend") : t("notes.pipeline.send")}
      </span>
      {(state.syncedAt || state.lastError) && (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            state.lastError ? "bg-destructive" : "bg-success"
          )}
          aria-label={state.lastError ? t("notes.pipeline.notSent") : t("notes.pipeline.synced")}
        />
      )}
    </button>
  );
}
