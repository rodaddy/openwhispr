// Text for the startup error dialog. A failed database migration carries
// the path of the snapshot taken before it, and the dialog names it.
function startupErrorMessage(error, t) {
  const message = String(error?.message ?? error);
  const backupPath = error?.backupPath;
  if (typeof backupPath === "string" && backupPath.length > 0) {
    return t("startup.error.messageWithBackup", { error: message, backupPath });
  }
  return t("startup.error.message", { error: message });
}

module.exports = { startupErrorMessage };
