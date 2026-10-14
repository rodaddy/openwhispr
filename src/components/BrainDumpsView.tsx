import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, CheckSquare, Flame, NotebookPen } from "lucide-react";
import { Button } from "./ui/button";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { Input } from "./ui/input";
import { callNoteModel } from "../services/brainDumps/noteModel";
import { currentRoundupSlot, isRoundupTime } from "../services/brainDumps/roundups";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { ROUNDUP_SAVED_EVENT, roundupTimes, runRoundupSlot } from "../hooks/useBrainDumpRoundups";
import { formatRelativeTime } from "../utils/dateFormatting";
import {
  firstLine,
  setBrainDumpRunError,
  startBrainDumpRun,
  undoBrainDumpRow,
  useBrainDumpRunStore,
  type BrainDumpResultRow as ResultRow,
} from "../stores/brainDumpRunStore";
import type { NoteItem } from "../types/electron";

const failed = (result: { success: boolean }): result is { success: false; error: string } =>
  !result.success;

const ROUNDUPS_FOLDER = "Brain dumps - Roundups";

const KIND_ICONS = { note: NotebookPen, grill: Flame, todo: CheckSquare } as const;

// Brain dumps: the phone's dumps waiting in the Brain dumps
// folder, a Process button that sorts them with the configured model, and the
// last run's results with Undo.
export default function BrainDumpsView() {
  const { t } = useTranslation();
  const policyState = usePolicySnapshot();
  const [dumps, setDumps] = useState<NoteItem[]>([]);
  // Run state is module-level (review desktop-pr-395) so switching view mid-run
  // does not lose the run's progress or its Last run rows and Undo buttons.
  const results = useBrainDumpRunStore((s) => s.results);
  const progress = useBrainDumpRunStore((s) => s.progress);
  const error = useBrainDumpRunStore((s) => s.error);
  const setError = setBrainDumpRunError;
  const [roundups, setRoundups] = useState<NoteItem[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [roundupState, setRoundupState] = useState<"idle" | "running" | "nothing">("idle");
  const morning = useSettingsStore((s) => s.brainDumpRoundupMorning);
  const night = useSettingsStore((s) => s.brainDumpRoundupNight);
  const setMorning = useSettingsStore((s) => s.setBrainDumpRoundupMorning);
  const setNight = useSettingsStore((s) => s.setBrainDumpRoundupNight);

  const reload = useCallback(async () => {
    const result = await window.electronAPI.brainDumpsList?.();
    if (!result) return;
    if (failed(result)) return setError(result.error);
    setDumps(result.dumps);
  }, []);

  // Roundup notes, newest first. Main owns the folder; this only reads it.
  const loadRoundups = useCallback(async () => {
    const folders = (await window.electronAPI.getFolders?.()) ?? [];
    const lists = await Promise.all(
      folders
        .filter((folder) => folder.name === ROUNDUPS_FOLDER)
        .map((folder) => window.electronAPI.getNotes(null, 60, folder.id))
    );
    setRoundups(
      lists.flat().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    );
  }, []);

  useEffect(() => {
    void reload();
    void loadRoundups();
    const onSaved = () => void loadRoundups();
    window.addEventListener(ROUNDUP_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(ROUNDUP_SAVED_EVENT, onSaved);
  }, [reload, loadRoundups]);

  const classify = (systemPrompt: string, content: string) =>
    callNoteModel(policyState, systemPrompt, content);

  const runNow = async () => {
    setError(null);
    setRoundupState("running");
    try {
      const outcome = await runRoundupSlot(
        currentRoundupSlot(new Date(), roundupTimes()),
        policyState
      );
      setRoundupState(outcome && !outcome.saved ? "nothing" : "idle");
    } catch (err) {
      setRoundupState("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async () => {
    await startBrainDumpRun(
      {
        list: async () => {
          const result = await window.electronAPI.brainDumpsList?.();
          if (!result) throw new Error(t("brainDumps.unavailable"));
          if (failed(result)) throw new Error(result.error);
          return result;
        },
        classify,
        process: async (outputs) => {
          const result = await window.electronAPI.brainDumpsProcess?.(outputs);
          if (!result) throw new Error(t("brainDumps.unavailable"));
          if (failed(result)) throw new Error(result.error);
          return result.results;
        },
      },
      dumps.length
    );
    await reload();
  };

  const undo = async (row: ResultRow) => {
    await undoBrainDumpRow(row, async (actionId) => window.electronAPI.brainDumpsUndo?.(actionId));
    await reload();
  };

  const kindLabel = (row: ResultRow) =>
    row.kind === "note"
      ? t("brainDumps.kind.note", { folder: row.target ?? "" })
      : row.kind === "grill"
        ? t("brainDumps.kind.grill")
        : t("brainDumps.kind.todo");

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-base font-semibold text-foreground">
          {t("brainDumps.title")}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            {t("brainDumps.waitingCount", { count: dumps.length })}
          </span>
        </h2>
        <Button size="sm" disabled={dumps.length === 0 || progress !== null} onClick={run}>
          {progress
            ? t("brainDumps.progress", { current: progress.current, total: progress.total })
            : t("brainDumps.process")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div>
        <SectionHeader title={t("brainDumps.waiting")} />
        <SettingsPanel>
          {dumps.length === 0 ? (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground">{t("brainDumps.empty")}</p>
            </SettingsPanelRow>
          ) : (
            dumps.map((dump) => (
              <SettingsPanelRow key={dump.id}>
                <div className="flex items-center gap-2">
                  <Brain size={12} className="shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-xs text-foreground">{firstLine(dump)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatRelativeTime(dump.created_at, t)}
                  </span>
                </div>
              </SettingsPanelRow>
            ))
          )}
        </SettingsPanel>
      </div>

      {results.length > 0 && (
        <div>
          <SectionHeader title={t("brainDumps.lastRun")} />
          <SettingsPanel>
            {results.map((row) => {
              const Icon = row.kind ? KIND_ICONS[row.kind] : Brain;
              return (
                <SettingsPanelRow key={row.noteId}>
                  <div className="flex items-center gap-2">
                    <Icon size={12} className="shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-xs text-foreground">{row.title}</p>
                      {row.error || row.undoError ? (
                        <p className="text-[11px] text-destructive">{row.error || row.undoError}</p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">{kindLabel(row)}</p>
                      )}
                    </div>
                    {row.actionId != null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        disabled={row.undone}
                        onClick={() => void undo(row)}
                      >
                        {row.undone ? t("brainDumps.undone") : t("brainDumps.undo")}
                      </Button>
                    )}
                  </div>
                </SettingsPanelRow>
              );
            })}
          </SettingsPanel>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <SectionHeader title={t("brainDumps.roundups")} />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            disabled={roundupState === "running"}
            onClick={() => void runNow()}
          >
            {roundupState === "running" ? t("brainDumps.running") : t("brainDumps.runNow")}
          </Button>
        </div>
        <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            {t("brainDumps.roundupMorning")}
            <Input
              type="time"
              className="h-7 w-28 text-xs"
              value={morning}
              onChange={(e) => isRoundupTime(e.target.value) && setMorning(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            {t("brainDumps.roundupNight")}
            <Input
              type="time"
              className="h-7 w-28 text-xs"
              value={night}
              onChange={(e) => isRoundupTime(e.target.value) && setNight(e.target.value)}
            />
          </label>
        </div>
        {roundupState === "nothing" && (
          <p className="mb-2 text-xs text-muted-foreground">{t("brainDumps.roundupNothing")}</p>
        )}
        {roundups.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("brainDumps.roundupsEmpty")}</p>
        ) : (
          <SettingsPanel>
            {roundups.map((note) => (
              <SettingsPanelRow key={note.id}>
                <button
                  type="button"
                  className="w-full text-left"
                  aria-expanded={expanded === note.id}
                  onClick={() => setExpanded(expanded === note.id ? null : note.id)}
                >
                  <p className="text-xs font-medium text-foreground">{note.title}</p>
                  <p
                    className={`whitespace-pre-wrap text-[11px] text-muted-foreground ${
                      expanded === note.id ? "" : "line-clamp-2"
                    }`}
                  >
                    {note.content}
                  </p>
                </button>
              </SettingsPanelRow>
            ))}
          </SettingsPanel>
        )}
      </div>
    </div>
  );
}
