// Folders for grill-mode transcripts: daily sessions save to "Grill", lifetime
// chapters to "Life Story". Seeded ONCE (user_version 3), like the Videos seed
// in database.js, as ordinary folders in the personal space that the user may
// rename or delete. A deleted or renamed one is never re-seeded; the renderer
// creates it on demand, in the personal space, when a session is saved
// (src/services/grill/grillSession.ts). A live personal folder with the same
// name is used as-is; team-space folders are never looked at.
const { randomUUID } = require("crypto");

const GRILL_FOLDER_NAME = "Grill";
const LIFE_STORY_FOLDER_NAME = "Life Story";
// Must stay above every earlier one-time migration's user_version (2 today).
const GRILL_FOLDERS_USER_VERSION = 3;

// Runs after the spaces migration, so folders carry space_id and deleted_at.
function seedGrillFoldersOnce(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= GRILL_FOLDERS_USER_VERSION) return;
  const personal = db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get();
  if (!personal) return;
  for (const name of [GRILL_FOLDER_NAME, LIFE_STORY_FOLDER_NAME]) {
    const existing = db
      .prepare("SELECT id FROM folders WHERE name = ? AND space_id = ? AND deleted_at IS NULL")
      .get(name, personal.id);
    if (existing) continue;
    const maxOrder = db
      .prepare("SELECT MAX(sort_order) AS m FROM folders WHERE space_id = ?")
      .get(personal.id);
    db.prepare(
      "INSERT INTO folders (name, is_default, sort_order, space_id, client_folder_id) VALUES (?, 0, ?, ?, ?)"
    ).run(name, maxOrder?.m == null ? 0 : maxOrder.m + 1, personal.id, randomUUID());
  }
  db.exec(`PRAGMA user_version = ${GRILL_FOLDERS_USER_VERSION}`);
}

module.exports = {
  GRILL_FOLDER_NAME,
  LIFE_STORY_FOLDER_NAME,
  GRILL_FOLDERS_USER_VERSION,
  seedGrillFoldersOnce,
};
