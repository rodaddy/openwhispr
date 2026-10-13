// Remove old copy (#325): decides what to delete after a data folder move.
// Pure: no fs access, so the refusals and the KEEP set are unit-testable.
// The caller passes realpaths and says whether the old folder is a store of
// this app; the planner only compares, case-insensitively where the
// filesystem usually is (darwin, win32).
//
// The model cache is never removed here: ~/.cache/openwhispr is shared by
// every channel (qdrant-data and qdrant-data-dev side by side), so it may only
// go through device erasure.
const path = require("path");

function planOldCopyRemoval({
  previousDataRoot,
  dataRoot,
  defaultUserData,
  oldIsStore = false,
  caseInsensitive = false,
  keep = [],
  entries = [],
}) {
  if (typeof previousDataRoot !== "string" || !previousDataRoot || !dataRoot) {
    return { ok: false, reason: "missing" };
  }
  if (!path.isAbsolute(previousDataRoot)) return { ok: false, reason: "missing" };
  const norm = (p) => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p));
  const isInside = (parent, child) => {
    const rel = path.relative(norm(parent), norm(child));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const old = path.resolve(previousDataRoot);
  const live = path.resolve(dataRoot);
  if (norm(old) === norm(live)) return { ok: false, reason: "sameAsLive" };
  if (isInside(old, live)) return { ok: false, reason: "containsLive" };

  const isDefault = Boolean(defaultUserData) && norm(defaultUserData) === norm(old);
  if (!isDefault && !oldIsStore) return { ok: false, reason: "notAStore" };

  // Boot still reads the pointer from the default userData folder.
  const kept = isDefault ? new Set(keep) : new Set();
  const paths = entries
    .filter((name) => !kept.has(name))
    .map((name) => path.resolve(old, name))
    .filter((p) => path.dirname(p) === old && !isInside(p, live) && !isInside(live, p));
  return { ok: true, paths };
}

module.exports = { planOldCopyRemoval };
