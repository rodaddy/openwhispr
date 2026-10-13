import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { CrmSaveSettingsInput, CrmSettings } from "../types/crm";

const EMPTY_SETTINGS: CrmSettings = { configured: false, hasToken: false, locationId: "" };

export default function CrmIntegrationCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.electronAPI.crmGetSettings();
    if ("settings" in result) setSettings(result.settings);
    else setMessage({ ok: false, text: result.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (input: CrmSaveSettingsInput) => {
    setSaving(true);
    setMessage(null);
    const result = await window.electronAPI.crmSaveSettings(input);
    if ("settings" in result) {
      setSettings(result.settings);
      setToken("");
      setMessage({
        ok: true,
        text: t("integrations.crm.saved", { defaultValue: "GoHighLevel settings saved" }),
      });
    } else {
      setMessage({ ok: false, text: result.error });
    }
    setSaving(false);
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    const result = await window.electronAPI.crmTestConnection();
    if ("locationName" in result) {
      setMessage({
        ok: true,
        text: t("integrations.crm.testSuccess", {
          defaultValue: "Connected to {{locationName}}",
          locationName: result.locationName,
        }),
      });
    } else {
      setMessage({ ok: false, text: result.error });
    }
    setTesting(false);
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border/50 p-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const trimmedToken = token.trim();
  const busy = saving || testing;
  const hasUnsavedToken = trimmedToken.length > 0;

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm p-4">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
          <KeyRound className="h-4 w-4 text-primary/80" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t("integrations.crm.title", { defaultValue: "GoHighLevel" })}
            </h3>
            {settings.configured ? (
              <Badge variant="success">
                {t("integrations.crm.configured", { defaultValue: "Configured" })}
              </Badge>
            ) : (
              <Badge variant="outline">
                {t("integrations.crm.notConfigured", { defaultValue: "Not configured" })}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
            {t("integrations.crm.description", {
              defaultValue:
                "Sync notes to a contact and opportunity in the rTech GoHighLevel sub-account.",
            })}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("integrations.crm.locationId", { defaultValue: "Location ID" })}:{" "}
          <span className="font-mono text-foreground">{settings.locationId}</span>
        </p>
        <label className="block space-y-1 text-xs text-muted-foreground">
          {t("integrations.crm.token", { defaultValue: "Private Integration token" })}
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              settings.hasToken
                ? t("integrations.crm.tokenUnchanged", {
                    defaultValue: "Leave blank to keep the saved token",
                  })
                : ""
            }
            autoComplete="new-password"
          />
        </label>
      </div>

      {message && (
        <div className={`mt-3 text-xs ${message.ok ? "text-success" : "text-destructive"}`}>
          {message.text}
        </div>
      )}
      {hasUnsavedToken && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("integrations.crm.saveBeforeTesting", {
            defaultValue: "Save changes before testing the connection.",
          })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button
          size="sm"
          onClick={() => void save({ token: trimmedToken })}
          disabled={busy || !trimmedToken}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {t("common.save", { defaultValue: "Save" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void test()}
          disabled={busy || !settings.configured || hasUnsavedToken}
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("integrations.crm.test", { defaultValue: "Test connection" })}
        </Button>
        {settings.hasToken && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void save({ token: null })}
            disabled={busy}
            className="text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("integrations.crm.removeToken", { defaultValue: "Remove token" })}
          </Button>
        )}
      </div>
    </div>
  );
}
