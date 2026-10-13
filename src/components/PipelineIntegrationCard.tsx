import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { PipelineSaveSettingsInput, PipelineSettings } from "../types/pipeline";

const EMPTY_SETTINGS: PipelineSettings = { baseUrl: "", hasToken: false, configured: false };

type MessageKind = "success" | "auth" | "unreachable" | "generic";

/**
 * Settings for the social-media-pipeline: its base URL and bearer token.
 * Finished grills are sent there; the token is write-only from here.
 */
export default function PipelineIntegrationCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [savedSettings, setSavedSettings] = useState(EMPTY_SETTINGS);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: MessageKind; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.electronAPI.pipelineGetSettings();
    if ("settings" in result) {
      setSettings(result.settings);
      setSavedSettings(result.settings);
    } else setMessage({ kind: "generic", text: result.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (removeToken = false) => {
    setSaving(true);
    setMessage(null);
    const input: PipelineSaveSettingsInput = { baseUrl: settings.baseUrl.trim() };
    if (removeToken) input.token = "";
    else if (token.trim()) input.token = token.trim();
    const result = await window.electronAPI.pipelineSaveSettings(input);
    if ("settings" in result) {
      setSettings(result.settings);
      setSavedSettings(result.settings);
      setToken("");
      setMessage({ kind: "success", text: t("integrations.pipeline.saved") });
    } else {
      setMessage({ kind: "generic", text: result.error });
    }
    setSaving(false);
  };

  const hasUnsavedChanges = Boolean(token) || settings.baseUrl !== savedSettings.baseUrl;

  const test = async () => {
    setTesting(true);
    setMessage(null);
    const result = await window.electronAPI.pipelineTestConnection();
    if ("error" in result) setMessage({ kind: "generic", text: result.error });
    else if (result.result === "ok")
      setMessage({
        kind: "success",
        text: t("integrations.pipeline.testOk", { status: result.status }),
      });
    else if (result.result === "unauthorized")
      setMessage({ kind: "auth", text: t("integrations.pipeline.testUnauthorized") });
    else setMessage({ kind: "unreachable", text: t("integrations.pipeline.testUnreachable") });
    setTesting(false);
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border/50 p-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm p-4">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
          <Send className="h-4 w-4 text-primary/80" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t("integrations.pipeline.title")}
            </h3>
            {settings.configured && (
              <Badge variant="success">{t("integrations.pipeline.configured")}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
            {t("integrations.pipeline.description")}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("integrations.pipeline.baseUrl")}
          <Input
            value={settings.baseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
            placeholder="https://pipeline.example.com"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("integrations.pipeline.token")}
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={settings.hasToken ? t("integrations.pipeline.tokenUnchanged") : ""}
            autoComplete="new-password"
          />
        </label>
      </div>

      {message && (
        <div
          className={`mt-3 text-xs ${message.kind === "success" ? "text-success" : message.kind === "auth" ? "text-destructive" : "text-warning"}`}
        >
          {message.text}
        </div>
      )}
      {hasUnsavedChanges && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("integrations.pipeline.saveBeforeTesting")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button size="sm" onClick={() => void save()} disabled={saving || testing}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {t("common.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void test()}
          disabled={saving || testing || !settings.configured || hasUnsavedChanges}
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("integrations.pipeline.test")}
        </Button>
        {settings.hasToken && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void save(true)}
            disabled={saving || testing}
            className="text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("integrations.pipeline.removeToken")}
          </Button>
        )}
      </div>
    </div>
  );
}
