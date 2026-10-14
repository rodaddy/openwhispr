// Per-hub cloud ids (decision D14). A cloud_id belongs to
// the hub that issued it. Switching hubs relaunches the app, and at startup,
// before any sync pass, swapHubIds stashes the previous hub's ids and restores
// the current hub's, so A -> B -> A resumes A from A's own ids instead of
// pushing A's rows to A again as new notes.

// kind -> local table. The kind is what hub_ids stores.
const SYNCED_TABLES = {
  notes: "notes",
  folders: "folders",
  transcriptions: "transcriptions",
  dictionary: "custom_dictionary",
  snippets: "snippets",
};

// A row deleted while on another hub is gone locally, but its stashed id for
// this hub still names a live row here. It comes back as a
// pending tombstone row so the next push deletes it on this hub too. Each
// kind fills its NOT NULL / unique columns from the cloud id; notes and
// folders sit in the private space so the account-scoped delete queue sees them.
const PRIVATE_SPACE = "(SELECT id FROM spaces WHERE kind = 'private' LIMIT 1)";
const TOMBSTONE_COLUMNS = {
  notes: { space_id: PRIVATE_SPACE },
  folders: { name: "'hub-tombstone:' || h.cloud_id", space_id: PRIVATE_SPACE },
  transcriptions: { text: "''" },
  dictionary: { word: "'hub-tombstone:' || h.cloud_id" },
  snippets: {
    trigger: "'hub-tombstone:' || h.cloud_id",
    replacement: "''",
  },
};

// Forward-only: sync_state holds the one hub URL the local cloud ids belong
// to; hub_ids holds the ids stashed for every other hub.
function ensureHubIdTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hub_url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_ids (
      hub_url TEXT NOT NULL,
      kind TEXT NOT NULL,
      local_id INTEGER NOT NULL,
      cloud_id TEXT NOT NULL,
      PRIMARY KEY (hub_url, kind, local_id)
    );
  `);
}

// currentUrl is the normalized hub URL ("" means hub off). Returns what it
// did: "off", "first-run", "same", or "swapped".
function swapHubIds(db, currentUrl) {
  if (!currentUrl) return "off";
  const row = db.prepare("SELECT hub_url FROM sync_state WHERE id = 1").get();
  if (!row) {
    // First run after the upgrade: the ids on disk are this hub's.
    db.prepare("INSERT INTO sync_state (id, hub_url) VALUES (1, ?)").run(currentUrl);
    return "first-run";
  }
  if (row.hub_url === currentUrl) return "same";
  const previousUrl = row.hub_url;
  db.transaction(() => {
    for (const [kind, table] of Object.entries(SYNCED_TABLES)) {
      db.prepare(
        `INSERT OR REPLACE INTO hub_ids (hub_url, kind, local_id, cloud_id)
         SELECT ?, ?, id, cloud_id FROM ${table} WHERE cloud_id IS NOT NULL`
      ).run(previousUrl, kind);
      db.prepare(`UPDATE ${table} SET cloud_id = NULL WHERE cloud_id IS NOT NULL`).run();
      db.prepare(
        `UPDATE ${table} SET cloud_id = (
           SELECT h.cloud_id FROM hub_ids h
           WHERE h.hub_url = ? AND h.kind = ? AND h.local_id = ${table}.id
         )
         WHERE id IN (SELECT local_id FROM hub_ids WHERE hub_url = ? AND kind = ?)`
      ).run(currentUrl, kind, currentUrl, kind);
      const extra = TOMBSTONE_COLUMNS[kind];
      db.prepare(
        `INSERT INTO ${table} (cloud_id, deleted_at, sync_status${Object.keys(extra)
          .map((c) => `, ${c}`)
          .join("")})
         SELECT h.cloud_id, datetime('now'), 'pending'${Object.values(extra)
           .map((v) => `, ${v}`)
           .join("")}
         FROM hub_ids h
         WHERE h.hub_url = ? AND h.kind = ?
           AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = h.local_id)`
      ).run(currentUrl, kind);
      db.prepare("DELETE FROM hub_ids WHERE hub_url = ? AND kind = ?").run(currentUrl, kind);
      // A row this hub has never seen pushes to it as new.
      db.prepare(`UPDATE ${table} SET sync_status = 'pending' WHERE cloud_id IS NULL`).run();
    }
    // The stale-write base is the previous hub's clock: push once without it.
    db.prepare("UPDATE notes SET cloud_updated_at = NULL").run();
    db.prepare("UPDATE sync_state SET hub_url = ? WHERE id = 1").run(currentUrl);
  })();
  return "swapped";
}

module.exports = { SYNCED_TABLES, ensureHubIdTables, swapHubIds };
