import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { notesInputClass } from "./shared";
import { persistNoteShareState } from "../../stores/noteStore";
import { useToast } from "../ui/useToast";
import { ShareService, shareLink } from "../../services/ShareService";
import type { NoteItem } from "../../types/electron";

interface ShareNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteItem;
}

// The snapshot the share service stores: the enhanced text when there is one,
// otherwise the raw dictation.
function noteSnapshot(note: NoteItem): { title: string; markdown: string } {
  return {
    title: note.title?.trim() || "Untitled",
    markdown: note.enhanced_content?.trim() ? note.enhanced_content : note.content,
  };
}

export default function ShareNoteDialog({ open, onOpenChange, note }: ShareNoteDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Holds the token an action just produced so the UI updates before the note
  // prop refreshes from the database.
  const [localToken, setLocalToken] = useState<string | null>(null);
  const [localShared, setLocalShared] = useState<boolean | null>(null);

  useEffect(() => {
    setLocalToken(null);
    setLocalShared(null);
    setCopied(false);
  }, [note.id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    ShareService.status()
      .then((status) => {
        if (cancelled) return;
        setConfigured(status.configured);
        setBaseUrl(status.baseUrl);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // An is_shared note with no share_token is an old OpenWhispr cloud share:
  // this service knows nothing about it, so it counts as not shared.
  const noteToken = note.share_token ?? null;
  const token = localToken ?? noteToken;
  const shared = localShared ?? Boolean(note.is_shared && noteToken);
  const isShared = shared && Boolean(token);

  // Takes the failed result rather than its code: this tsconfig has
  // strictNullChecks off, so `if (!result.ok)` does not narrow the union.
  const reportFailure = useCallback(
    (failure: { ok: boolean; code?: string }) => {
      toast({
        title: t("noteEditor.share.dialog.failed", { defaultValue: "Sharing failed" }),
        description: failure.code,
        variant: "destructive",
      });
    },
    [t, toast]
  );

  const createShare = useCallback(async () => {
    setBusy(true);
    try {
      const result = await ShareService.create({ id: note.id, ...noteSnapshot(note) });
      if (!result.ok) {
        reportFailure(result);
        return;
      }
      setLocalToken(result.token);
      setLocalShared(true);
      await persistNoteShareState(note.id, { is_shared: 1, share_token: result.token });
    } finally {
      setBusy(false);
    }
  }, [note, reportFailure]);

  const revokeShare = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await ShareService.revoke(token);
      if (!result.ok) {
        reportFailure(result);
        return;
      }
      setLocalToken(null);
      setLocalShared(false);
      await persistNoteShareState(note.id, { is_shared: 0, share_token: null });
    } finally {
      setBusy(false);
    }
  }, [note.id, reportFailure, token]);

  const updateShare = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await ShareService.update(token, noteSnapshot(note));
      if (!result.ok) {
        reportFailure(result);
        return;
      }
      toast({
        title: t("noteEditor.share.dialog.updated", { defaultValue: "Shared copy updated" }),
      });
    } finally {
      setBusy(false);
    }
  }, [note, reportFailure, t, toast, token]);

  const rotateShare = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await ShareService.rotate(token);
      if (!result.ok) {
        reportFailure(result);
        return;
      }
      setLocalToken(result.token);
      setLocalShared(true);
      await persistNoteShareState(note.id, { is_shared: 1, share_token: result.token });
      toast({
        title: t("noteEditor.share.dialog.rotated", { defaultValue: "Old link no longer works" }),
      });
    } finally {
      setBusy(false);
    }
  }, [note.id, reportFailure, t, toast, token]);

  const link = isShared && token ? shareLink(baseUrl, token) : "";

  const copyLink = useCallback(async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [link]);

  const toggleShare = useCallback(
    (next: boolean) => {
      void (next ? createShare() : revokeShare());
    },
    [createShare, revokeShare]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t("noteEditor.share.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("noteEditor.share.dialog.help", {
            defaultValue: "Anyone with the link can view it. There is no expiry.",
          })}
        </DialogDescription>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-foreground/40" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs text-foreground/70">
                <Link2 className="h-3.5 w-3.5" />
                {t("noteEditor.share.dialog.linkLabel", { defaultValue: "Share link" })}
              </span>
              <Toggle checked={isShared} onChange={toggleShare} disabled={!configured || busy} />
            </div>

            {!configured ? (
              <p className="text-xs text-foreground/40">
                {t("noteEditor.share.dialog.notConfigured", {
                  defaultValue: "Sharing isn't set up in this build.",
                })}
              </p>
            ) : null}

            {configured && isShared ? (
              <div className="space-y-3">
                <input className={notesInputClass} readOnly value={link} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={copyLink}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied
                      ? t("noteEditor.share.dialog.copied")
                      : t("noteEditor.share.dialog.copyLink")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={updateShare}>
                    <Upload className="h-3.5 w-3.5" />
                    {t("noteEditor.share.dialog.update", {
                      defaultValue: "Update shared copy",
                    })}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={rotateShare}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("noteEditor.share.dialog.newLink", { defaultValue: "New link" })}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={revokeShare}>
                    <X className="h-3.5 w-3.5" />
                    {t("noteEditor.share.dialog.stopSharing", {
                      defaultValue: "Stop sharing",
                    })}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
