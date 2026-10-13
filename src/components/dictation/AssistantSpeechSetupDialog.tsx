import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentName } from "../../utils/agentName";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export function AssistantSpeechSetupDialog({
  open,
  onOpenChange,
  onConfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: () => void;
}) {
  const { t } = useTranslation();
  const { agentName } = useAgentName();
  const [referenceTranscript, setReferenceTranscript] = useState("");
  const [seed, setSeed] = useState("42");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [configured, setConfigured] = useState(false);
  const [importing, setImporting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [clip, setClip] = useState<{
    name: string;
    window?: { index: number; count: number; startSec: number; endSec: number };
  } | null>(null);
  const importingRef = useRef(false);
  // Counts choose calls and closings, so a result that arrives late is ignored.
  const chooseRunRef = useRef(0);
  const chooseClip = useCallback(async () => {
    if (importingRef.current) return;
    importingRef.current = true;
    const run = ++chooseRunRef.current;
    setImporting(true);
    setAnalyzing(true);
    setError("");
    setNotice("");
    try {
      const result = await window.electronAPI.analyzeAssistantSpeechReference();
      if (run !== chooseRunRef.current) return;
      if (result.success) {
        setClip({ name: result.fileName || "", window: result.window });
        // Always replaced, so a clip with no transcript never keeps the last one.
        setReferenceTranscript(result.text ?? "");
        if (result.transcribed === false)
          setNotice(t("assistantSpeechSetup.reference.notTranscribed"));
      } else if (!result.canceled) {
        setClip(null);
        setError(
          t([
            `assistantSpeechSetup.reference.errors.${result.code}`,
            "assistantSpeechSetup.reference.errors.failed",
          ])
        );
      }
    } catch {
      if (run !== chooseRunRef.current) return;
      setClip(null);
      setError(t("assistantSpeechSetup.reference.errors.failed"));
    } finally {
      importingRef.current = false;
      setImporting(false);
      setAnalyzing(false);
    }
  }, [t]);
  const importProfile = useCallback(async () => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const result = await window.electronAPI.importAssistantSpeechProfile(
        referenceTranscript,
        seed
      );
      if (result.success) {
        onConfigured();
        onOpenChange(false);
      } else if (!result.canceled) setError(result.error || "Could not save voice profile");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not save voice profile");
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [onConfigured, onOpenChange, referenceTranscript, seed]);
  useEffect(() => {
    // Closing forgets the chosen clip; a new opening starts without one.
    setClip(null);
    if (!open) {
      chooseRunRef.current++;
      setReferenceTranscript("");
      return;
    }
    let current = true;
    setNotice("");
    window.electronAPI
      .getAssistantSpeechProfile()
      .then((profile) => {
        if (!current) return;
        setConfigured(!!profile?.configured);
        if (typeof profile?.seed === "number") setSeed(String(profile.seed));
      })
      .catch(() => {
        if (current) setConfigured(false);
      });
    return () => {
      current = false;
    };
  }, [open]);
  const runBundle = useCallback(
    async (kind: "export" | "import") => {
      if (importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      setError("");
      setNotice("");
      try {
        const result =
          kind === "export"
            ? await window.electronAPI.exportAssistantSpeechBundle(agentName)
            : await window.electronAPI.importAssistantSpeechBundle();
        if (result.success) {
          if (kind === "export") setNotice(t("assistantSpeechSetup.bundle.exported"));
          else {
            onConfigured();
            onOpenChange(false);
          }
        } else if (!result.canceled) {
          setError(
            t([
              `assistantSpeechSetup.bundle.errors.${result.error}`,
              "assistantSpeechSetup.bundle.errors.failed",
            ])
          );
        }
      } catch {
        setError(t("assistantSpeechSetup.bundle.errors.failed"));
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [agentName, onConfigured, onOpenChange, t]
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up spoken replies</DialogTitle>
          <DialogDescription>
            Choose a WAV voice sample and enter its exact transcript.
          </DialogDescription>
        </DialogHeader>
        <textarea
          className="min-h-24 rounded-md border border-border bg-background p-3 text-sm"
          value={referenceTranscript}
          onChange={(event) => setReferenceTranscript(event.target.value)}
          placeholder="Exact words spoken in the WAV"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="assistant-speech-seed" className="text-sm font-medium">
            {t("assistantSpeechSetup.seed.label")}
          </label>
          <input
            id="assistant-speech-seed"
            type="number"
            min={1}
            max={1000}
            step={1}
            className="w-28 rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            aria-describedby="assistant-speech-seed-description"
          />
          <p id="assistant-speech-seed-description" className="text-xs text-muted-foreground">
            {t("assistantSpeechSetup.seed.description")}
          </p>
        </div>
        {analyzing && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("assistantSpeechSetup.reference.transcribing")}
          </p>
        )}
        {clip && (
          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            <p>{t("assistantSpeechSetup.reference.chosen", { name: clip.name })}</p>
            {clip.window && (
              <p>
                {t("assistantSpeechSetup.reference.window", {
                  index: clip.window.index,
                  count: clip.window.count,
                  start: clip.window.startSec,
                  end: clip.window.endSec,
                })}
              </p>
            )}
          </div>
        )}
        {(error || notice) && (
          <p
            role={error ? "alert" : "status"}
            className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {error || notice}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={analyzing} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={!configured || importing}
            onClick={() => void runBundle("export")}
          >
            {t("assistantSpeechSetup.bundle.export")}
          </Button>
          <Button variant="outline" disabled={importing} onClick={() => void runBundle("import")}>
            {t("assistantSpeechSetup.bundle.import")}
          </Button>
          <Button variant="outline" disabled={importing} onClick={() => void chooseClip()}>
            {t("assistantSpeechSetup.reference.choose")}
          </Button>
          <Button
            disabled={!clip || !referenceTranscript.trim() || importing}
            onClick={() => void importProfile()}
          >
            {t("assistantSpeechSetup.reference.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
