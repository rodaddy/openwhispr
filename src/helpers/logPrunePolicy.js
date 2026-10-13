const LOG_MAX_AGE_DAYS = 3;
const LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEBUG_LOG_PATTERN = /^debug-.*\.log$/;

const isDebugLogName = (name) => DEBUG_LOG_PATTERN.test(name);

/**
 * Pure prune policy for debug log files.
 * @param {{name: string, mtimeMs: number, size: number}[]} files
 * @param {string|null} currentName basename of the log being written; never selected
 * @param {number} now epoch ms
 * @returns {string[]} names to delete, oldest first
 */
function selectLogsToPrune(files, currentName, now) {
  const cutoff = now - LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const logs = files.filter((f) => isDebugLogName(f.name));
  const candidates = logs
    .filter((f) => f.name !== currentName)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const doomed = new Set(candidates.filter((f) => f.mtimeMs < cutoff).map((f) => f.name));
  let total = logs.filter((f) => !doomed.has(f.name)).reduce((sum, f) => sum + f.size, 0);
  for (const f of candidates) {
    if (total <= LOG_MAX_TOTAL_BYTES) break;
    if (doomed.has(f.name)) continue;
    doomed.add(f.name);
    total -= f.size;
  }
  return candidates.filter((f) => doomed.has(f.name)).map((f) => f.name);
}

module.exports = { selectLogsToPrune, isDebugLogName, LOG_MAX_AGE_DAYS, LOG_MAX_TOTAL_BYTES };
