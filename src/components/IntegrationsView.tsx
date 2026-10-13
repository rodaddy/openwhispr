import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, Info, Loader2, Mail, Plus, Unlink } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "./ui/SettingsSection";
import { Toggle } from "./ui/toggle";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useSettingsStore } from "../stores/settingsStore";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";
import type {
  CalendarAccount,
  CalendarAccountSyncHealth,
  CalendarSyncHealthMap,
} from "../types/calendar";
import {
  syncNowStateFromResult,
  syncNowStatusLine,
  type SyncNowState,
} from "../utils/calendarSyncNowState";
import CliIntegrationCard from "./CliIntegrationCard";
import McpIntegrationCard from "./McpIntegrationCard";
import CrmIntegrationCard from "./CrmIntegrationCard";
import PipelineIntegrationCard from "./PipelineIntegrationCard";
import googleCalendarIcon from "../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../assets/icons/microsoft-calendar.svg";
import appleCalendarIcon from "../assets/icons/apple-calendar.svg";

interface IntegrationsViewProps {
  isPaid: boolean;
  onUpgrade: () => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-2 pl-1">
      {children}
    </div>
  );
}

interface ProviderRowProps {
  icon: string;
  i18nKey: string;
  connected: boolean;
  isConnecting: boolean;
  onConnect: () => void;
  onSyncNow?: () => Promise<{ success: boolean; error?: string } | undefined> | undefined;
}

const SYNC_NOW_TICK_MS = 30 * 1000;

function ProviderRow({
  icon,
  i18nKey,
  connected,
  isConnecting,
  onConnect,
  onSyncNow,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const [syncNow, setSyncNow] = useState<SyncNowState>({ status: "idle" });
  const [now, setNow] = useState(() => Date.now());

  // Keeps "Synced 3 min ago" moving while the result is on screen
  useEffect(() => {
    if (syncNow.status !== "synced") return;
    const timer = setInterval(() => setNow(Date.now()), SYNC_NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [syncNow.status]);

  const handleSyncNow = async () => {
    setSyncNow({ status: "running" });
    let result: { success: boolean; error?: string } | undefined;
    try {
      result = await onSyncNow?.();
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const finishedAt = Date.now();
    setNow(finishedAt);
    setSyncNow(syncNowStateFromResult(result, finishedAt));
  };

  const statusLine = connected ? syncNowStatusLine(syncNow, now) : null;
  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
          <img src={icon} alt="" className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold text-foreground">{t(`${i18nKey}.title`)}</p>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
              {t(`${i18nKey}.optional`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
            {t(`${i18nKey}.description`)}
          </p>
          {statusLine && (
            <p
              className={`text-xs mt-0.5 leading-relaxed break-words ${
                statusLine.kind === "error" ? "text-warning" : "text-muted-foreground/70"
              }`}
            >
              {"text" in statusLine
                ? statusLine.text
                : t(`integrations.calendarSyncNow.${statusLine.key}`, {
                    count: "count" in statusLine ? statusLine.count : undefined,
                  })}
            </p>
          )}
        </div>
        {connected ? (
          <div className="flex items-center gap-2 shrink-0">
            {onSyncNow && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleSyncNow}
                disabled={syncNow.status === "running"}
              >
                {syncNow.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("integrations.calendarSyncNow.syncNow")}
              </Button>
            )}
            <Badge variant="success">{t(`${i18nKey}.connected`)}</Badge>
          </div>
        ) : (
          <Button size="sm" onClick={onConnect} disabled={isConnecting} className="shrink-0">
            {isConnecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t(`${i18nKey}.connect`)
            )}
          </Button>
        )}
      </div>
    </SettingsPanelRow>
  );
}

interface CalendarAccountRowsProps {
  i18nKey: string;
  accounts: CalendarAccount[];
  disconnectingEmail: string | null;
  onUnlink: (email: string) => void;
  primaryOnly: boolean;
  onPrimaryOnlyChange: (value: boolean) => void;
  isConnecting: boolean;
  onAddAnother: () => void;
  syncHealth: CalendarSyncHealthMap;
}

const SYNC_FAILING_NOTICE_MS = 30 * 60 * 1000;

function SyncHealthNotice({
  health,
  isConnecting,
  onReconnect,
}: {
  health?: CalendarAccountSyncHealth;
  isConnecting: boolean;
  onReconnect: () => void;
}) {
  const { t } = useTranslation();
  const failure = health?.failure;
  if (failure?.kind === "auth") {
    return (
      <>
        <span className="text-xs text-warning shrink-0">
          {t("integrations.calendarSyncHealth.needsReconnect")}
        </span>
        <Button size="sm" variant="outline" onClick={onReconnect} disabled={isConnecting}>
          {t("integrations.calendarSyncHealth.reconnect")}
        </Button>
      </>
    );
  }
  if (failure && Date.now() - failure.since > SYNC_FAILING_NOTICE_MS) {
    return (
      <span className="text-xs text-warning shrink-0">
        {t("integrations.calendarSyncHealth.failingSince", {
          time: new Date(failure.since).toLocaleString(),
        })}
      </span>
    );
  }
  return null;
}

function CalendarAccountRows({
  i18nKey,
  accounts,
  disconnectingEmail,
  onUnlink,
  primaryOnly,
  onPrimaryOnlyChange,
  isConnecting,
  onAddAnother,
  syncHealth,
}: CalendarAccountRowsProps) {
  const { t } = useTranslation();
  if (accounts.length === 0) return null;
  return (
    <>
      {accounts.map((account) => (
        <SettingsPanelRow key={account.email}>
          <div className="group flex items-center gap-3 pl-12">
            <Mail className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <span className="text-xs text-muted-foreground truncate flex-1">{account.email}</span>
            <SyncHealthNotice
              health={syncHealth[account.email]}
              isConnecting={isConnecting}
              onReconnect={onAddAnother}
            />
            <button
              onClick={() => onUnlink(account.email)}
              disabled={disconnectingEmail === account.email}
              className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
              aria-label={t(`${i18nKey}.disconnect`)}
            >
              {disconnectingEmail === account.email ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Unlink className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </SettingsPanelRow>
      ))}

      <SettingsPanelRow>
        <SettingsRow
          label={t(`${i18nKey}.primaryOnly`)}
          description={t(`${i18nKey}.primaryOnlyDescription`)}
        >
          <Toggle checked={primaryOnly} onChange={onPrimaryOnlyChange} />
        </SettingsRow>
      </SettingsPanelRow>

      <SettingsPanelRow>
        <button
          onClick={onAddAnother}
          disabled={isConnecting}
          className="flex items-center gap-2 pl-12 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
        >
          {isConnecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t(`${i18nKey}.addAnother`)}
        </button>
      </SettingsPanelRow>
    </>
  );
}

export default function IntegrationsView({ isPaid, onUpgrade }: IntegrationsViewProps) {
  const { t } = useTranslation();
  const {
    gcalAccounts,
    setGcalAccounts,
    gcalPrimaryOnly,
    setGcalPrimaryOnly,
    mcalAccounts,
    setMcalAccounts,
    mcalPrimaryOnly,
    setMcalPrimaryOnly,
    appleCalendarConnected,
    setAppleCalendarConnected,
  } = useSettingsStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
  const [confirmDisconnectEmail, setConfirmDisconnectEmail] = useState<string | null>(null);
  const [isMsConnecting, setIsMsConnecting] = useState(false);
  const [msDisconnectingEmail, setMsDisconnectingEmail] = useState<string | null>(null);
  const [confirmMsDisconnectEmail, setConfirmMsDisconnectEmail] = useState<string | null>(null);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const [isAppleConnecting, setIsAppleConnecting] = useState(false);
  const [appleSourceNames, setAppleSourceNames] = useState<string[]>([]);
  const [confirmAppleDisconnect, setConfirmAppleDisconnect] = useState(false);
  const [appleConnectError, setAppleConnectError] = useState<"denied" | "failed" | null>(null);
  // i18n prefix of the provider whose OAuth flow failed, e.g. "integrations.googleCalendar"
  const [oauthErrorKey, setOauthErrorKey] = useState<string | null>(null);
  const [gcalSyncHealth, setGcalSyncHealth] = useState<CalendarSyncHealthMap>({});
  const [mcalSyncHealth, setMcalSyncHealth] = useState<CalendarSyncHealthMap>({});
  const systemAudio = useSystemAudioPermission();
  const { request: requestSystemAudioAccess } = systemAudio;
  const hasAccounts = gcalAccounts.length > 0;
  const needsSystemAudioGrant = !systemAudio.granted && canManageSystemAudioInApp(systemAudio);
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";

  const startOAuth = useCallback(async () => {
    setIsConnecting(true);
    try {
      const result = await window.electronAPI?.gcalStartOAuth?.();
      if (result?.success && result.email) {
        const current = useSettingsStore.getState().gcalAccounts;
        setGcalAccounts([
          ...current.filter((a) => a.email !== result.email),
          { email: result.email },
        ]);
      } else if (!result?.error?.includes("access_denied")) {
        // access_denied means the user cancelled on the consent screen
        setOauthErrorKey("integrations.googleCalendar");
      }
    } finally {
      setIsConnecting(false);
    }
  }, [setGcalAccounts]);

  const startMicrosoftOAuth = useCallback(async () => {
    setIsMsConnecting(true);
    try {
      const result = await window.electronAPI?.mcalStartOAuth?.();
      if (result?.success && result.email) {
        const current = useSettingsStore.getState().mcalAccounts;
        setMcalAccounts([
          ...current.filter((a) => a.email !== result.email),
          { email: result.email },
        ]);
      } else if (!result?.error?.includes("access_denied")) {
        setOauthErrorKey("integrations.microsoftCalendar");
      }
    } finally {
      setIsMsConnecting(false);
    }
  }, [setMcalAccounts]);

  const connectAppleCalendar = useCallback(async () => {
    setIsAppleConnecting(true);
    try {
      const result = await window.electronAPI?.acalConnect?.();
      if (result?.success) {
        setAppleCalendarConnected(true);
      } else {
        // Only send the user to Privacy settings when access was actually
        // denied; helper-missing/snapshot-failed are not permission problems.
        setAppleConnectError(result?.reason === "denied" ? "denied" : "failed");
      }
    } finally {
      setIsAppleConnecting(false);
    }
  }, [setAppleCalendarConnected]);

  const withSystemAudioGate = useCallback(
    async (connect: () => Promise<void>) => {
      if (needsSystemAudioGrant) {
        const granted = await requestSystemAudioAccess();
        if (!granted) {
          setShowPermissionDialog(true);
          return;
        }
      }
      await connect();
    },
    [needsSystemAudioGrant, requestSystemAudioAccess]
  );

  const handleConnect = useCallback(
    () => withSystemAudioGate(startOAuth),
    [withSystemAudioGate, startOAuth]
  );

  const handleMicrosoftConnect = useCallback(
    () => withSystemAudioGate(startMicrosoftOAuth),
    [withSystemAudioGate, startMicrosoftOAuth]
  );

  const handleAppleConnect = useCallback(
    () => withSystemAudioGate(connectAppleCalendar),
    [withSystemAudioGate, connectAppleCalendar]
  );

  const handleAppleDisconnect = useCallback(async () => {
    await window.electronAPI?.acalDisconnect?.();
    setAppleCalendarConnected(false);
    setAppleSourceNames([]);
  }, [setAppleCalendarConnected]);

  const handleDisconnect = useCallback(
    async (email: string) => {
      setDisconnectingEmail(email);
      try {
        await window.electronAPI?.gcalDisconnect?.(email);
        const current = useSettingsStore.getState().gcalAccounts;
        setGcalAccounts(current.filter((a) => a.email !== email));
      } finally {
        setDisconnectingEmail(null);
      }
    },
    [setGcalAccounts]
  );

  const handleMicrosoftDisconnect = useCallback(
    async (email: string) => {
      setMsDisconnectingEmail(email);
      try {
        await window.electronAPI?.mcalDisconnect?.(email);
        const current = useSettingsStore.getState().mcalAccounts;
        setMcalAccounts(current.filter((a) => a.email !== email));
      } finally {
        setMsDisconnectingEmail(null);
      }
    },
    [setMcalAccounts]
  );

  useEffect(() => {
    const unsub = window.electronAPI?.onGcalConnectionChanged?.(
      (data: {
        accounts?: Array<{ email: string }>;
        connected?: boolean;
        email?: string | null;
      }) => {
        if (data.accounts) {
          setGcalAccounts(data.accounts);
        } else if (data.connected && data.email) {
          const current = useSettingsStore.getState().gcalAccounts;
          setGcalAccounts([
            ...current.filter((a) => a.email !== data.email),
            { email: data.email },
          ]);
        }
      }
    );
    return () => unsub?.();
  }, [setGcalAccounts]);

  useEffect(() => {
    const unsub = window.electronAPI?.onMcalConnectionChanged?.(
      (data: { accounts?: Array<{ email: string }> }) => {
        if (data.accounts) setMcalAccounts(data.accounts);
      }
    );
    return () => unsub?.();
  }, [setMcalAccounts]);

  useEffect(() => {
    window.electronAPI?.gcalGetSyncHealth?.().then((h) => h && setGcalSyncHealth(h));
    window.electronAPI?.mcalGetSyncHealth?.().then((h) => h && setMcalSyncHealth(h));
    const unsubG = window.electronAPI?.onGcalSyncHealthChanged?.(setGcalSyncHealth);
    const unsubM = window.electronAPI?.onMcalSyncHealthChanged?.(setMcalSyncHealth);
    return () => {
      unsubG?.();
      unsubM?.();
    };
  }, []);

  useEffect(() => {
    if (!isMac) return;
    window.electronAPI?.acalGetConnectionStatus?.().then((status) => {
      if (status) {
        setAppleCalendarConnected(status.connected);
        setAppleSourceNames(status.sourceNames);
      }
    });
    const unsub = window.electronAPI?.onAcalConnectionChanged?.((data) => {
      setAppleCalendarConnected(data.connected);
      setAppleSourceNames(data.sourceNames ?? []);
    });
    return () => unsub?.();
  }, [isMac, setAppleCalendarConnected]);

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("integrations.title")}</h2>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{t("integrations.description")}</p>
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.calendar")}</SectionLabel>
        <SettingsPanel>
          <ProviderRow
            icon={googleCalendarIcon}
            i18nKey="integrations.googleCalendar"
            connected={hasAccounts}
            isConnecting={isConnecting}
            onConnect={handleConnect}
            onSyncNow={() => window.electronAPI?.gcalSyncNow?.()}
          />
          <CalendarAccountRows
            i18nKey="integrations.googleCalendar"
            accounts={gcalAccounts}
            disconnectingEmail={disconnectingEmail}
            onUnlink={setConfirmDisconnectEmail}
            primaryOnly={gcalPrimaryOnly}
            onPrimaryOnlyChange={setGcalPrimaryOnly}
            isConnecting={isConnecting}
            onAddAnother={handleConnect}
            syncHealth={gcalSyncHealth}
          />

          <ProviderRow
            icon={microsoftCalendarIcon}
            i18nKey="integrations.microsoftCalendar"
            connected={mcalAccounts.length > 0}
            isConnecting={isMsConnecting}
            onConnect={handleMicrosoftConnect}
            onSyncNow={() => window.electronAPI?.mcalSyncNow?.()}
          />
          <CalendarAccountRows
            i18nKey="integrations.microsoftCalendar"
            accounts={mcalAccounts}
            disconnectingEmail={msDisconnectingEmail}
            onUnlink={setConfirmMsDisconnectEmail}
            primaryOnly={mcalPrimaryOnly}
            onPrimaryOnlyChange={setMcalPrimaryOnly}
            isConnecting={isMsConnecting}
            onAddAnother={handleMicrosoftConnect}
            syncHealth={mcalSyncHealth}
          />

          {isMac && (
            <ProviderRow
              icon={appleCalendarIcon}
              i18nKey="integrations.appleCalendar"
              connected={appleCalendarConnected}
              isConnecting={isAppleConnecting}
              onConnect={handleAppleConnect}
              onSyncNow={() => window.electronAPI?.acalSyncNow?.()}
            />
          )}

          {isMac && appleCalendarConnected && (
            <SettingsPanelRow>
              <div className="group flex items-center gap-3 pl-12">
                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1">
                  {appleSourceNames.join(" · ")}
                </span>
                <button
                  onClick={() => setConfirmAppleDisconnect(true)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                  aria-label={t("integrations.appleCalendar.disconnect")}
                >
                  <Unlink className="h-3.5 w-3.5" />
                </button>
              </div>
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      </div>

      <div>
        <SectionLabel>
          {t("integrations.sections.crm", { defaultValue: "GoHighLevel" })}
        </SectionLabel>
        <CrmIntegrationCard />
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.pipeline")}</SectionLabel>
        <PipelineIntegrationCard />
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.mcp")}</SectionLabel>
        <McpIntegrationCard isPaid={isPaid} onUpgrade={onUpgrade} />
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.cli")}</SectionLabel>
        <CliIntegrationCard />
      </div>

      {!hasAccounts && (
        <div className="rounded-lg border border-border/40 dark:border-border-subtle/40 bg-muted/20 dark:bg-surface-2/30 p-4 flex items-start gap-3">
          <Info size={15} className="text-primary/60 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground/80">
              {t("integrations.notABot.title")}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">
              {t("integrations.notABot.description")}
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDisconnectEmail}
        onOpenChange={(open) => {
          if (!open) setConfirmDisconnectEmail(null);
        }}
        title={t("integrations.googleCalendar.disconnectConfirm", {
          email: confirmDisconnectEmail,
        })}
        description={t("integrations.googleCalendar.disconnectDescription")}
        confirmText={t("integrations.googleCalendar.disconnect")}
        variant="destructive"
        onConfirm={() => {
          if (confirmDisconnectEmail) handleDisconnect(confirmDisconnectEmail);
        }}
      />

      <ConfirmDialog
        open={!!confirmMsDisconnectEmail}
        onOpenChange={(open) => {
          if (!open) setConfirmMsDisconnectEmail(null);
        }}
        title={t("integrations.microsoftCalendar.disconnectConfirm", {
          email: confirmMsDisconnectEmail,
        })}
        description={t("integrations.microsoftCalendar.disconnectDescription")}
        confirmText={t("integrations.microsoftCalendar.disconnect")}
        variant="destructive"
        onConfirm={() => {
          if (confirmMsDisconnectEmail) handleMicrosoftDisconnect(confirmMsDisconnectEmail);
        }}
      />

      <ConfirmDialog
        open={showPermissionDialog}
        onOpenChange={setShowPermissionDialog}
        title={t("integrations.googleCalendar.systemAudioRequired")}
        description={t("integrations.googleCalendar.systemAudioDescription")}
        confirmText={
          systemAudio.mode === "native"
            ? t("integrations.googleCalendar.openSettings")
            : t("onboarding.permissions.grantAccess")
        }
        onConfirm={systemAudio.mode === "native" ? systemAudio.openSettings : systemAudio.request}
      />

      <ConfirmDialog
        open={confirmAppleDisconnect}
        onOpenChange={setConfirmAppleDisconnect}
        title={t("integrations.appleCalendar.disconnectConfirm")}
        description={t("integrations.appleCalendar.disconnectDescription")}
        confirmText={t("integrations.appleCalendar.disconnect")}
        variant="destructive"
        onConfirm={handleAppleDisconnect}
      />

      <ConfirmDialog
        open={appleConnectError === "denied"}
        onOpenChange={(open) => !open && setAppleConnectError(null)}
        title={t("integrations.appleCalendar.permissionDenied")}
        description={t("integrations.appleCalendar.permissionDeniedDescription")}
        confirmText={t("integrations.appleCalendar.openSettings")}
        onConfirm={() => window.electronAPI?.openCalendarPrivacySettings?.()}
      />

      <AlertDialog
        open={appleConnectError === "failed"}
        onOpenChange={(open) => !open && setAppleConnectError(null)}
        title={t("integrations.appleCalendar.connectFailed")}
        description={t("integrations.appleCalendar.connectFailedDescription")}
        onOk={() => {}}
      />

      <AlertDialog
        open={!!oauthErrorKey}
        onOpenChange={(open) => !open && setOauthErrorKey(null)}
        title={oauthErrorKey ? t(`${oauthErrorKey}.connectFailed`) : ""}
        description={oauthErrorKey ? t(`${oauthErrorKey}.connectFailedDescription`) : ""}
        onOk={() => {}}
      />
    </div>
  );
}
