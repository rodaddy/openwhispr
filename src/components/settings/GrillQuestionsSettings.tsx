import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import {
  groupGrillQuestions,
  markCountsForRows,
  type GrillChapterGroup,
} from "../../services/grill/grillEditor";
import { loadGrillBank } from "../../services/grill/grillBankStore";
import type {
  GrillQuestionHistoryRow,
  GrillQuestionMarkCounts,
  GrillQuestionMarkValue,
  GrillQuestionRow,
} from "../../types/electron";

const MARK_KINDS: GrillQuestionMarkValue[] = ["good", "weak", "retire"];

/** Narrows any editor result to its failure member (the union members are
 * intersections, which TypeScript will not discriminate on `success` alone). */
const failed = (result: { success: boolean }): result is { success: false; error: string } =>
  !result.success;

// The grill question bank editor (openwhispr#54). The live bank is SQLite in the
// main process; every write goes through the preload API and is followed by a
// re-list, so the rendered order is always the stored order.
export function GrillQuestionsSettings() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<GrillQuestionRow[]>([]);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Record<string, GrillQuestionHistoryRow[]>>({});
  const [openChapters, setOpenChapters] = useState<Record<number, boolean>>({});
  const [markCounts, setMarkCounts] = useState<GrillQuestionMarkCounts>({});

  const api = typeof window === "undefined" ? undefined : window.electronAPI;

  const loadMarkCounts = useCallback(async () => {
    if (!api?.grillMarkCounts) return;
    const result = await api.grillMarkCounts();
    if (failed(result)) {
      setError(result.error);
      return;
    }
    setMarkCounts(result.counts);
  }, [api]);

  const list = useCallback(async () => {
    if (!api?.grillListQuestions) return;
    const result = await api.grillListQuestions();
    if (failed(result)) {
      setError(result.error);
      return;
    }
    setRows(result.questions);
    setError("");
  }, [api]);

  const loadParams = useCallback(async () => {
    if (!api?.grillGetQuestionBank) return;
    const bank = await api.grillGetQuestionBank();
    setParams(bank.params ?? {});
  }, [api]);

  useEffect(() => {
    void (async () => {
      try {
        await loadGrillBank(api);
        await list();
        await loadParams();
        await loadMarkCounts();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [api, list, loadParams, loadMarkCounts]);

  // Every mutation shares this shape: run it, surface an error, re-list.
  const run = async (
    call: () => Promise<{ success: true } | { success: false; error: string }> | undefined
  ) => {
    try {
      const result = await call();
      if (result && failed(result)) {
        setError(result.error);
        return;
      }
      setError("");
      await list();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const updateText = (row: GrillQuestionRow, text: string) => {
    const next = text.trim();
    if (!next || next === row.text) return;
    void run(() => api?.grillUpdateQuestion?.(row.id, next));
  };

  const move = (row: GrillQuestionRow, delta: number) => {
    const position = row.position + delta;
    if (position < 0) return;
    void run(() => api?.grillMoveQuestion?.(row.id, position));
  };

  const setStatus = (row: GrillQuestionRow, status: GrillQuestionRow["status"]) =>
    void run(() => api?.grillSetQuestionStatus?.(row.id, status));

  // An editor tag is a vote in the question's null-note slot; it never changes
  // the question's status (Retire is the direct action). Re-tagging replaces it.
  const tag = (row: GrillQuestionRow, mark: GrillQuestionMarkValue) =>
    void run(async () => {
      const result = await api?.grillSetMark?.(row.id, null, mark);
      await loadMarkCounts();
      return result;
    });

  const toggleHistory = async (row: GrillQuestionRow) => {
    if (history[row.id]) {
      setHistory((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      return;
    }
    if (!api?.grillQuestionHistory) return;
    const result = await api.grillQuestionHistory(row.id);
    if (failed(result)) {
      setError(result.error);
      return;
    }
    setHistory((prev) => ({ ...prev, [row.id]: result.history }));
  };

  const add = (section: GrillQuestionRow["section"], chapter: number | null, text: string) =>
    run(() => api?.grillAddQuestion?.({ section, text, chapter }));

  const setFlowParam = (key: "max_day_questions" | "max_feed_questions", value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
    void run(async () => {
      const result = await api?.grillSetFlowParam?.(key, value);
      await loadParams();
      return result;
    });
  };

  const grouped = groupGrillQuestions(rows);
  const tallies = markCountsForRows(rows, markCounts);
  const chapterTitles = (params.chapter_titles ?? {}) as Record<string, string>;
  const flowValue = (key: string, fallback: number) =>
    typeof params[key] === "number" ? (params[key] as number) : fallback;

  const renderRow = (row: GrillQuestionRow) => {
    const retired = row.status === "retired";
    const rowHistory = history[row.id];
    return (
      <div key={row.id} className="flex flex-col gap-1">
        <div className={`flex items-center gap-2 ${retired ? "opacity-50" : ""}`}>
          <Input
            defaultValue={row.text}
            key={`${row.id}-${row.updated_at}`}
            className="h-7 flex-1 text-xs"
            aria-label={t("settings.grillQuestions.questionLabel")}
            onBlur={(e) => updateText(row, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            aria-label={t("settings.grillQuestions.moveUp")}
            onClick={() => move(row, -1)}
          >
            ↑
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            aria-label={t("settings.grillQuestions.moveDown")}
            onClick={() => move(row, 1)}
          >
            ↓
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            title={retired ? undefined : t("settings.grillQuestions.retireHint")}
            onClick={() => setStatus(row, retired ? "active" : "retired")}
          >
            {retired ? t("settings.grillQuestions.restore") : t("settings.grillQuestions.retire")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void toggleHistory(row)}
          >
            {t("settings.grillQuestions.history")}
          </Button>
          <select
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            value=""
            aria-label={t("settings.grillQuestions.tagLabel")}
            title={t("settings.grillQuestions.tagHint")}
            onChange={(e) => {
              const mark = e.target.value as GrillQuestionMarkValue;
              if (MARK_KINDS.includes(mark)) tag(row, mark);
            }}
          >
            <option value="" disabled>
              {t("settings.grillQuestions.tag")}
            </option>
            {MARK_KINDS.map((mark) => (
              <option key={mark} value={mark}>
                {t(`settings.grillQuestions.tagMarks.${mark}`)}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("settings.grillQuestions.markCounts", tallies[row.id])}
        </span>
        {row.source && (
          <span className="text-xs text-muted-foreground">
            {t("settings.grillQuestions.source", { source: row.source })}
          </span>
        )}
        {rowHistory && (
          <ul className="pl-2 text-xs text-muted-foreground">
            {rowHistory.length === 0 && <li>{t("settings.grillQuestions.noHistory")}</li>}
            {rowHistory.map((entry) => (
              <li key={entry.id}>
                {t("settings.grillQuestions.historyEntry", {
                  date: entry.changed_at,
                  field: entry.field,
                  from: entry.old_value ?? "",
                  to: entry.new_value ?? "",
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderAdd = (section: GrillQuestionRow["section"], chapter: number | null) => (
    <AddQuestion
      label={t("settings.grillQuestions.add")}
      placeholder={t("settings.grillQuestions.addPlaceholder")}
      onAdd={(text) => add(section, chapter, text)}
    />
  );

  const renderChapter = (chapter: GrillChapterGroup) => {
    const open = openChapters[chapter.number] ?? false;
    return (
      <div key={chapter.number} className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start text-xs"
          aria-expanded={open}
          onClick={() => setOpenChapters((prev) => ({ ...prev, [chapter.number]: !open }))}
        >
          {`${open ? "▾" : "▸"} ${chapter.number}. ${chapterTitles[String(chapter.number)] ?? ""}`}
        </Button>
        {open && (
          <div className="flex flex-col gap-2 pl-3">
            {chapter.rows.map(renderRow)}
            {renderAdd("chapter", chapter.number)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <SectionHeader
        title={t("settings.grillQuestions.title")}
        description={t("settings.grillQuestions.description")}
      />
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
            <span className="text-xs font-medium text-foreground">
              {t("settings.grillQuestions.standard")}
            </span>
            {grouped.standard.map(renderRow)}
            {renderAdd("standard", null)}
          </div>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">
              {t("settings.grillQuestions.dayTemplates")}
            </span>
            {grouped.dayTemplates.map(renderRow)}
            {renderAdd("day-template", null)}
          </div>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">
              {t("settings.grillQuestions.chapters")}
            </span>
            {grouped.chapters.map(renderChapter)}
          </div>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground">
              {t("settings.grillQuestions.flow")}
            </span>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("settings.grillQuestions.maxDayQuestions")}
              <Input
                type="number"
                min={0}
                max={20}
                className="h-7 w-20 text-xs"
                value={flowValue("max_day_questions", 4)}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= 0 && value <= 20)
                    setFlowParam("max_day_questions", value);
                }}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("settings.grillQuestions.maxFeedQuestions")}
              <Input
                type="number"
                min={0}
                max={20}
                className="h-7 w-20 text-xs"
                value={flowValue("max_feed_questions", 2)}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= 0 && value <= 20)
                    setFlowParam("max_feed_questions", value);
                }}
              />
            </label>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}

interface AddQuestionProps {
  label: string;
  placeholder: string;
  onAdd: (text: string) => void | Promise<void>;
}

function AddQuestion({ label, placeholder, onAdd }: AddQuestionProps) {
  const [text, setText] = useState("");
  const submit = () => {
    const next = text.trim();
    if (!next) return;
    void Promise.resolve(onAdd(next)).then(() => setText(""));
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-7 flex-1 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Button size="sm" className="h-7 text-xs" disabled={!text.trim()} onClick={submit}>
        {label}
      </Button>
    </div>
  );
}
