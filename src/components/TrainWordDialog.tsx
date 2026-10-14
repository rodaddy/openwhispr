import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useSettings } from "../hooks/useSettings";
import { useTrainerTake, type TrainerTakeResult } from "../hooks/useTrainerTake";
import { mergeCorrections, normalize, takeToCorrection } from "../utils/wordTrainer";

type Take =
  | { state: "idle" | "recording" | "discarded" }
  | { state: "heard"; text: string }
  | { state: "error"; error: string };

const fresh = (count: number): Take[] => Array.from({ length: count }, () => ({ state: "idle" }));

interface TrainWordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Train a word: record 3-4 takes of one word, review the corrections
 * they would make, drop any bad one, and only then save. Cancel saves nothing.
 */
export default function TrainWordDialog({ open, onOpenChange }: TrainWordDialogProps) {
  const { t } = useTranslation();
  const { snippets, setSnippets, updateCustomDictionary } = useSettings();
  const { startTake, stopTake, waitTake, cancelTake } = useTrainerTake();
  // Bumped on close: a take result that lands after its session ended is dropped.
  const session = useRef(0);
  const [target, setTarget] = useState("");
  const [takes, setTakes] = useState<Take[]>(() => fresh(3));
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<{ added: number; replaced: number } | null>(null);

  const word = normalize(target);
  const recording = takes.some((take) => take.state === "recording");
  const setTake = (index: number, take: Take) =>
    setTakes((all) => all.map((old, i) => (i === index ? take : old)));

  const errorText = (error: string) =>
    error === "No speech heard"
      ? t("dictionary.trainer.noSpeech")
      : error === "dictation is running"
        ? t("dictionary.trainer.dictationRunning")
        : t("dictionary.trainer.failed", { error });

  const record = async (index: number) => {
    setRemoved((all) => new Set([...all].filter((i) => i !== index)));
    setTake(index, { state: "recording" });
    const id = session.current;
    const started = await startTake();
    // Closed while the take was starting: the hook already released the mic.
    if (id !== session.current) return;
    if ("error" in started) {
      setTake(index, { state: "error", error: started.error });
      return;
    }
    // The take stops by itself once the speech has ended, or
    // through Stop; either way its one result lands here.
    const ended: TrainerTakeResult = await waitTake();
    if (id !== session.current) return;
    if ("rawText" in ended) setTake(index, { state: "heard", text: ended.rawText });
    else if ("error" in ended) setTake(index, { state: "error", error: ended.error });
    else setTake(index, { state: "discarded" });
  };

  // Manual fallback: record() applies the result, so stop only ends the take.
  const stop = () => {
    void stopTake();
  };

  const corrections = takes.map((take) =>
    take.state === "heard" && word ? takeToCorrection(take.text, word) : null
  );
  const kept = corrections.filter((c, i) => c && !removed.has(i)) as NonNullable<
    (typeof corrections)[number]
  >[];
  const canSave = !!word && !recording && takes.some((take) => take.state === "heard");

  const close = () => {
    session.current += 1;
    cancelTake();
    setTarget("");
    setTakes(fresh(3));
    setRemoved(new Set());
    setResult(null);
    onOpenChange(false);
  };

  const save = () => {
    if (!canSave) return;
    const merged = mergeCorrections(snippets, kept);
    setSnippets(merged.snippets);
    updateCustomDictionary({ add: [word] });
    setResult({ added: merged.added.length, replaced: merged.replaced.length });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dictionary.trainer.title")}</DialogTitle>
          <DialogDescription>{t("dictionary.trainer.description")}</DialogDescription>
        </DialogHeader>
        {result ? (
          <p className="text-xs">{t("dictionary.trainer.saved", result)}</p>
        ) : (
          <div className="space-y-3">
            <Input
              aria-label={t("dictionary.trainer.wordLabel")}
              placeholder={t("dictionary.trainer.wordLabel")}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              maxLength={80}
            />
            <div className="flex items-center gap-1.5 text-xs">
              {t("dictionary.trainer.takes")}
              {[3, 4].map((count) => (
                <Button
                  key={count}
                  size="sm"
                  variant={takes.length === count ? "default" : "ghost"}
                  disabled={recording}
                  onClick={() => setTakes((all) => [...all, ...fresh(4)].slice(0, count))}
                >
                  {String(count)}
                </Button>
              ))}
            </div>
            <ul className="space-y-1.5">
              {takes.map((take, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0">{t("dictionary.trainer.take", { n: i + 1 })}</span>
                  <span className="flex-1 min-w-0 truncate text-foreground/50">
                    {take.state === "heard"
                      ? take.text
                      : take.state === "error"
                        ? errorText(take.error)
                        : take.state === "discarded"
                          ? t("dictionary.trainer.discarded")
                          : take.state === "recording"
                            ? t("dictionary.trainer.listening")
                            : ""}
                  </span>
                  {take.state === "recording" ? (
                    <Button size="sm" onClick={stop}>
                      {t("dictionary.trainer.stop")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={recording}
                      onClick={() => record(i)}
                    >
                      {take.state === "idle"
                        ? t("dictionary.trainer.record")
                        : t("dictionary.trainer.redo")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="space-y-1 text-xs">
              <p className="font-medium">{t("dictionary.trainer.willSave")}</p>
              {takes.map((take, i) => {
                if (take.state !== "heard" || removed.has(i)) return null;
                const correction = corrections[i];
                if (!correction)
                  return (
                    <p key={i} className="text-foreground/40">
                      {normalize(take.text).toLowerCase() === word.toLowerCase()
                        ? t("dictionary.trainer.alreadyRight", { n: i + 1 })
                        : t("dictionary.trainer.nothingUsable", { n: i + 1 })}
                    </p>
                  );
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate">
                      {correction.trigger} → {correction.replacement}
                    </span>
                    <button
                      aria-label={t("dictionary.snippets.remove", { trigger: correction.trigger })}
                      onClick={() => setRemoved((all) => new Set(all).add(i))}
                      className="p-1 text-foreground/25 hover:text-destructive/70"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <DialogFooter className="pt-2">
          {result ? (
            <Button onClick={close}>{t("common.close")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button onClick={save} disabled={!canSave}>
                {t("common.save")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
