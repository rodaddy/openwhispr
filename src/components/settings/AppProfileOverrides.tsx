import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import type { DictationAppProfile, DictationAppProfileName } from "../../stores/settingsStore";
import {
  APP_PROFILE_NAMES,
  MAX_APP_PROFILE_MATCH_LENGTH,
  MAX_APP_PROFILE_OVERRIDES,
  cleanAppProfileOverrides,
} from "./appProfileOverrideRules";

interface AppProfileOverridesProps {
  profiles: DictationAppProfile[];
  onProfilesChange: (profiles: DictationAppProfile[]) => void;
}

type Row = DictationAppProfile & { id: number };

// The per-app formatting list: name an app, pick its profile. Rows are local
// while they are being typed (a new row has no name yet); the store only ever
// gets the cleaned list.
export function AppProfileOverrides({ profiles, onProfilesChange }: AppProfileOverridesProps) {
  const { t } = useTranslation();
  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    profiles.map((profile) => ({ ...profile, id: nextId.current++ }))
  );
  const atLimit = rows.length >= MAX_APP_PROFILE_OVERRIDES;

  const commit = (next: Row[]) => {
    setRows(next);
    onProfilesChange(cleanAppProfileOverrides(next));
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-xs font-medium text-foreground">
          {t("settingsPage.general.clipboard.appProfiles.title")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.general.clipboard.appProfiles.description")}
        </p>
      </div>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            value={row.match}
            maxLength={MAX_APP_PROFILE_MATCH_LENGTH}
            onChange={(e) =>
              setRows(rows.map((r) => (r.id === row.id ? { ...r, match: e.target.value } : r)))
            }
            onBlur={() => commit(rows)}
            placeholder={t("settingsPage.general.clipboard.appProfiles.appPlaceholder")}
            className="h-7 flex-1 text-xs"
          />
          <Select
            value={row.profile}
            onValueChange={(profile) =>
              commit(
                rows.map((r) =>
                  r.id === row.id ? { ...r, profile: profile as DictationAppProfileName } : r
                )
              )
            }
          >
            <SelectTrigger className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APP_PROFILE_NAMES.map((name) => (
                <SelectItem key={name} value={name} className="text-xs">
                  {t(`settingsPage.general.clipboard.appProfiles.profiles.${name}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            aria-label={t("settingsPage.general.clipboard.appProfiles.remove")}
            onClick={() => commit(rows.filter((r) => r.id !== row.id))}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={atLimit}
          onClick={() =>
            commit([...rows, { id: nextId.current++, match: "", profile: "terminal" }])
          }
        >
          {t("settingsPage.general.clipboard.appProfiles.add")}
        </Button>
        {atLimit && (
          <span className="text-xs text-muted-foreground">
            {t("settingsPage.general.clipboard.appProfiles.limit")}
          </span>
        )}
      </div>
    </div>
  );
}
