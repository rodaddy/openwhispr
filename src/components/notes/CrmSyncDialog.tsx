import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Contact, ExternalLink, Loader2, Search } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import type { NoteItem } from "../../types/electron";
import type {
  CrmContact,
  CrmOpportunity,
  CrmOpportunityStatus,
  CrmSyncState,
} from "../../types/crm";

interface CrmSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note: NoteItem;
  initialState: CrmSyncState | null;
  onBeforeSync: () => Promise<void>;
  onSynced: (state: CrmSyncState) => void;
  blocked: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;

function statusLabel(t: TFunction, status: CrmOpportunityStatus): string {
  switch (status) {
    case "open":
      return t("notes.crm.status.open", { defaultValue: "Open" });
    case "won":
      return t("notes.crm.status.won", { defaultValue: "Won" });
    case "lost":
      return t("notes.crm.status.lost", { defaultValue: "Lost" });
    case "abandoned":
      return t("notes.crm.status.abandoned", { defaultValue: "Abandoned" });
  }
}

const rowClass = (selected: boolean) =>
  `w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 ${selected ? "bg-primary/5 ring-1 ring-inset ring-primary/20" : ""}`;

const dotClass = (selected: boolean) =>
  `h-3.5 w-3.5 rounded-full border ${selected ? "border-primary bg-primary ring-2 ring-primary/15" : "border-border"}`;

export default function CrmSyncDialog({
  open,
  onOpenChange,
  note,
  initialState,
  onBeforeSync,
  onSynced,
  blocked,
}: CrmSyncDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [searching, setSearching] = useState(false);
  const [contactId, setContactId] = useState<string | null>(initialState?.contactId ?? null);
  const [opportunities, setOpportunities] = useState<CrmOpportunity[] | null>(null);
  const [loadingOpportunities, setLoadingOpportunities] = useState(false);
  const [opportunityId, setOpportunityId] = useState<string | null>(
    initialState?.opportunityId ?? null
  );
  const [syncing, setSyncing] = useState(false);
  const [syncState, setSyncState] = useState(initialState);
  const [error, setError] = useState("");
  const blockedRef = useRef(blocked);
  const searchGenerationRef = useRef(0);
  const listGenerationRef = useRef(0);
  const resetIdentityRef = useRef<string | null>(null);
  blockedRef.current = blocked;

  useEffect(() => {
    setSyncState(initialState);
  }, [initialState]);

  useEffect(() => {
    const identity = open ? String(note.id) : null;
    if (resetIdentityRef.current === identity) return;
    resetIdentityRef.current = identity;
    if (identity === null) return;
    setQuery("");
    setContacts([]);
    setSearching(false);
    setContactId(initialState?.contactId ?? null);
    setOpportunityId(initialState?.opportunityId ?? null);
    setSyncState(initialState);
    setError("");
  }, [initialState, note.id, open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    const searchGeneration = ++searchGenerationRef.current;
    // The previous results belong to the old query: none is pickable until this one answers.
    setContacts([]);
    if (!trimmed) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const result = await window.electronAPI.crmSearchContacts(trimmed);
      if (searchGeneration !== searchGenerationRef.current) return;
      if ("contacts" in result) {
        setContacts(result.contacts);
        setError("");
      } else setError(result.error);
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [note.id, open, query]);

  useEffect(() => {
    const listGeneration = ++listGenerationRef.current;
    setOpportunities(null);
    if (!open || !contactId) {
      setLoadingOpportunities(false);
      return;
    }
    setLoadingOpportunities(true);
    void window.electronAPI.crmListOpportunities(contactId).then((result) => {
      if (listGeneration !== listGenerationRef.current) return;
      if ("opportunities" in result) setOpportunities(result.opportunities);
      else setError(result.error);
      setLoadingOpportunities(false);
    });
  }, [contactId, open]);

  const pickContact = (contact: CrmContact) => {
    if (contact.id === contactId) return;
    setContactId(contact.id);
    setOpportunityId(null);
    setError("");
  };

  const chosenOpportunity = opportunities?.find((row) => row.id === opportunityId) ?? null;
  const canSync = Boolean(contactId && chosenOpportunity) && !syncing && !blocked;

  const sync = async () => {
    if (!contactId || !chosenOpportunity || blockedRef.current) return;
    setSyncing(true);
    setError("");
    try {
      await onBeforeSync();
      if (blockedRef.current) return;
      const result = await window.electronAPI.crmSyncNote(note.id, {
        contactId,
        opportunityId: chosenOpportunity.id,
      });
      if ("state" in result) {
        setSyncState(result.state);
        onSynced(result.state);
      } else setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {syncState
              ? t("notes.crm.updateTitle", { defaultValue: "Update GoHighLevel note" })
              : t("notes.crm.syncTitle", { defaultValue: "Sync note to GoHighLevel" })}
          </DialogTitle>
          <DialogDescription>
            {t("notes.crm.description", {
              defaultValue: "Choose a GoHighLevel contact and one of its opportunities.",
            })}
          </DialogDescription>
        </DialogHeader>

        {syncState && (
          <div className="flex items-center justify-between rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-xs">
            <Badge variant="success">
              {t("notes.crm.syncedAt", {
                defaultValue: "Synced {{time}}",
                time: new Date(syncState.syncedAt).toLocaleString(),
              })}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.electronAPI.openExternal(syncState.url)}
            >
              {t("notes.crm.open", { defaultValue: "Open in GoHighLevel" })}
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground/50" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            placeholder={t("notes.crm.search", { defaultValue: "Search GoHighLevel contacts" })}
            autoFocus
          />
          {searching && (
            <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>

        {query.trim() && (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/40">
            {contacts.map((contact) => (
              <button
                key={contact.id}
                type="button"
                onClick={() => pickContact(contact)}
                className={rowClass(contactId === contact.id)}
              >
                <Contact className="h-4 w-4 text-primary/70" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{contact.name}</span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {contact.email || contact.phone || ""}
                  </span>
                </span>
                <span className={dotClass(contactId === contact.id)} />
              </button>
            ))}
            {!searching && contacts.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t("notes.crm.noMatches", { defaultValue: "No matching contacts" })}
              </div>
            )}
          </div>
        )}

        {contactId && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t("notes.crm.opportunity", { defaultValue: "Opportunity" })}
            </p>
            {loadingOpportunities ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : opportunities && opportunities.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("notes.crm.noOpportunities", {
                  defaultValue: "This contact has no opportunities in GoHighLevel.",
                })}
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/40">
                {(opportunities ?? []).map((opportunity) => (
                  <button
                    key={opportunity.id}
                    type="button"
                    aria-pressed={opportunityId === opportunity.id}
                    onClick={() => setOpportunityId(opportunity.id)}
                    className={rowClass(opportunityId === opportunity.id)}
                  >
                    <span className="min-w-0 flex-1 text-sm font-medium truncate">
                      {opportunity.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {statusLabel(t, opportunity.status)}
                    </span>
                    <span className={dotClass(opportunityId === opportunity.id)} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={() => void sync()} disabled={!canSync}>
            {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {syncState
              ? t("notes.crm.update", { defaultValue: "Update GoHighLevel note" })
              : t("notes.crm.sync", { defaultValue: "Sync to GoHighLevel" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
