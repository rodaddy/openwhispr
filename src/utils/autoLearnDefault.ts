// Auto-learn from corrections is OFF by default: it kept learning ordinary
// words. A one-time migration switches an existing ON install OFF and
// records that it ran, so a later manual ON sticks.
export const AUTO_LEARN_KEY = "autoLearnCorrections";
export const AUTO_LEARN_MIGRATION_KEY = "autoLearnOffMigrated";
export const AUTO_LEARN_DEFAULT = false;

export function parseAutoLearn(value: string | null): boolean {
  return value === null ? AUTO_LEARN_DEFAULT : value === "true";
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function migrateAutoLearnOff(storage: StorageLike): void {
  if (storage.getItem(AUTO_LEARN_MIGRATION_KEY) === "true") return;
  if (storage.getItem(AUTO_LEARN_KEY) !== null) {
    storage.setItem(AUTO_LEARN_KEY, "false");
  }
  storage.setItem(AUTO_LEARN_MIGRATION_KEY, "true");
}
